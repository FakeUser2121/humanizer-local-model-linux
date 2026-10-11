package launcher

import (
	"bufio"
	"context"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"testing/fstest"
	"time"
)

func TestNormalizeServerURL(t *testing.T) {
	llama := map[string]string{
		"localhost:8080":                       "http://localhost:8080",
		"  http://192.168.1.10:8080/  ":        "http://192.168.1.10:8080",
		"http://host:8080/v1":                  "http://host:8080",
		"http://host:8080/v1/chat/completions": "http://host:8080",
		"http://host:8080/completion":          "http://host:8080",
		"http://host:8080/props?x=1#y":         "http://host:8080",
		"https://gpu.example.test/llama/":      "https://gpu.example.test/llama",
		"http://[::1]:8080":                    "http://[::1]:8080",
	}
	for in, want := range llama {
		got, err := normalizeServerURL(in, KindLlamaCpp)
		if err != nil || got != want {
			t.Errorf("llamacpp normalize(%q) = %q, %v; want %q", in, got, err, want)
		}
	}
	openai := map[string]string{
		"localhost:1234": "http://localhost:1234/v1",
		"http://127.0.0.1:1234/v1/chat/completions": "http://127.0.0.1:1234/v1",
		"http://host:11434/v1/":                     "http://host:11434/v1",
		"https://example.test/openai/v1":            "https://example.test/openai/v1",
	}
	for in, want := range openai {
		got, err := normalizeServerURL(in, KindOpenAI)
		if err != nil || got != want {
			t.Errorf("openai normalize(%q) = %q, %v; want %q", in, got, err, want)
		}
	}
	for _, bad := range []string{"", "   ", "ftp://host", "http://", "http://user:pw@host:8080", "://x"} {
		if got, err := normalizeServerURL(bad, KindLlamaCpp); err == nil {
			t.Errorf("normalize(%q) = %q, want error", bad, got)
		}
	}
	if _, err := normalizeServerURL("host:1", "nope"); err == nil {
		t.Error("unknown kind should fail")
	}
}

// fakeLlama imitates the parts of llama-server we use.
type fakeLlama struct {
	mu      sync.Mutex
	key     string // required bearer key for everything except /health ("" = none)
	loading bool
	nctx    int
	seen    []*http.Request
	bodies  []map[string]any
}

func (f *fakeLlama) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	var body map[string]any
	if r.Body != nil {
		_ = json.NewDecoder(r.Body).Decode(&body)
	}
	f.mu.Lock()
	f.seen = append(f.seen, r)
	f.bodies = append(f.bodies, body)
	key, loading, nctx := f.key, f.loading, f.nctx
	f.mu.Unlock()
	if r.URL.Path == "/health" {
		if loading {
			w.WriteHeader(503)
			io.WriteString(w, `{"error":{"code":503,"message":"Loading model"}}`)
			return
		}
		io.WriteString(w, `{"status":"ok"}`)
		return
	}
	if key != "" && r.Header.Get("Authorization") != "Bearer "+key {
		w.WriteHeader(401)
		io.WriteString(w, `{"error":{"code":401,"message":"Invalid API Key"}}`)
		return
	}
	switch r.URL.Path {
	case "/props":
		json.NewEncoder(w).Encode(map[string]any{
			"model_path":                  "/models/humanizer-12b-Q8_0.gguf",
			"default_generation_settings": map[string]any{"n_ctx": nctx},
		})
	case "/tokenize":
		s, _ := body["content"].(string)
		toks := make([]int, 0)
		for range strings.Fields(s) {
			toks = append(toks, 1)
		}
		json.NewEncoder(w).Encode(map[string]any{"tokens": toks})
	case "/completion":
		w.Header().Set("Content-Type", "text/event-stream")
		fl := w.(http.Flusher)
		for _, p := range []string{"Hel", "lo ", "there."} {
			b, _ := json.Marshal(map[string]any{"content": p, "stop": false})
			io.WriteString(w, "data: "+string(b)+"\n\n")
			fl.Flush()
		}
		b, _ := json.Marshal(map[string]any{"content": "", "stop": true, "stop_type": "eos", "tokens_predicted": 3})
		io.WriteString(w, "data: "+string(b)+"\n\n")
	case "/v1/chat/completions":
		w.Header().Set("Content-Type", "text/event-stream")
		io.WriteString(w, `data: {"choices":[{"delta":{"content":"Hi"}}]}`+"\n\n")
		io.WriteString(w, `data: {"choices":[{"delta":{},"finish_reason":"stop"}]}`+"\n\n")
		io.WriteString(w, "data: [DONE]\n\n")
	case "/v1/models":
		io.WriteString(w, `{"data":[{"id":"humanizer-12b"},{"id":"other"}]}`)
	default:
		http.NotFound(w, r)
	}
}

func (f *fakeLlama) last() (*http.Request, map[string]any) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.seen[len(f.seen)-1], f.bodies[len(f.bodies)-1]
}

// testApp starts the launcher's handler on a real listener whose port the guard knows about.
func testApp(t *testing.T) (*App, string) {
	t.Helper()
	dir := t.TempDir()
	cfg, err := loadConfig([]byte(`{"schema":2,"sampling":{"temperature":1.0,"top_p":0.95,"top_k":0,"min_p":0.0,"repeat_penalty":1.0},"n_predict":{"factor":2.5,"min":256,"max":2048},"ctx_size":8192,"idle_exit_minutes":0,"preferred_port":0}`), filepath.Join(dir, "config.json"))
	if err != nil {
		t.Fatal(err)
	}
	a := &App{cfg: cfg, dataDir: dir, probeKick: make(chan struct{}, 1),
		web: fstest.MapFS{"index.html": {Data: []byte("<html>ok</html>")}}}
	a.opts.Version = "test"
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	a.port = ln.Addr().(*net.TCPAddr).Port
	ctx, cancel := context.WithCancel(context.Background())
	a.rootCtx, a.shutdown = ctx, cancel
	a.touch()
	srv := &http.Server{Handler: a.handler()}
	go srv.Serve(ln)
	t.Cleanup(func() { cancel(); srv.Close() })
	go a.watchLoop(ctx)
	return a, "http://" + ln.Addr().String()
}

func call(t *testing.T, method, url string, body any, hdr map[string]string) (*http.Response, []byte) {
	t.Helper()
	var rd io.Reader
	if body != nil {
		b, _ := json.Marshal(body)
		rd = strings.NewReader(string(b))
	}
	req, _ := http.NewRequest(method, url, rd)
	if method == "POST" {
		req.Header.Set("X-Humanizer", "1")
		req.Header.Set("Content-Type", "application/json")
	}
	for k, v := range hdr {
		req.Header.Set(k, v)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	return resp, b
}

func waitFor(t *testing.T, what string, cond func() bool) {
	t.Helper()
	for i := 0; i < 100; i++ {
		if cond() {
			return
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for %s", what)
}

func status(t *testing.T, base string) map[string]any {
	_, b := call(t, "GET", base+"/app/status", nil, nil)
	var m map[string]any
	if err := json.Unmarshal(b, &m); err != nil {
		t.Fatalf("status: %v %s", err, b)
	}
	return m
}

func TestLlamaCppEndToEnd(t *testing.T) {
	fl := &fakeLlama{key: "sekret", nctx: 6144}
	upstream := httptest.NewServer(fl)
	defer upstream.Close()
	a, base := testApp(t)

	if st := status(t, base); st["phase"] != "setup" {
		t.Fatalf("phase = %v, want setup", st["phase"])
	}
	if resp, _ := call(t, "POST", base+"/api/completion", map[string]any{"prompt": "x"}, nil); resp.StatusCode != 503 {
		t.Fatalf("unconfigured proxy status %d", resp.StatusCode)
	}

	_, b := call(t, "POST", base+"/app/server/test", map[string]any{"kind": "llamacpp", "url": upstream.URL, "api_key": "nope"}, nil)
	var tr probeResult
	json.Unmarshal(b, &tr)
	if tr.OK || tr.Code != "auth" {
		t.Fatalf("expected auth failure, got %+v", tr)
	}
	_, b = call(t, "POST", base+"/app/server/test", map[string]any{"kind": "llamacpp", "url": upstream.URL + "/v1", "api_key": "sekret"}, nil)
	tr = probeResult{}
	json.Unmarshal(b, &tr)
	if !tr.OK || tr.CtxSize != 6144 || tr.Model != "humanizer-12b-Q8_0.gguf" {
		t.Fatalf("probe = %+v", tr)
	}

	resp, b := call(t, "POST", base+"/app/server", map[string]any{"kind": "llamacpp", "url": upstream.URL + "/", "api_key": "sekret"}, nil)
	if resp.StatusCode != 200 {
		t.Fatalf("save: %d %s", resp.StatusCode, b)
	}
	if strings.Contains(string(b), "sekret") {
		t.Fatal("API key leaked in /app/server response")
	}
	waitFor(t, "ctx detection", func() bool {
		st := status(t, base)
		return st["phase"] == "ready" && st["ctx_size"] == float64(6144) && st["ctx_detected"] == true
	})
	_, sb := call(t, "GET", base+"/app/status", nil, nil)
	if strings.Contains(string(sb), "sekret") {
		t.Fatal("API key leaked in /app/status")
	}
	if st, err := os.Stat(filepath.Join(a.dataDir, "api-key")); err != nil || st.Mode().Perm() != 0o600 {
		t.Fatalf("api-key file: %v %v", st, err)
	}

	req, _ := http.NewRequest("POST", base+"/api/completion", strings.NewReader(`{"prompt":"P","stream":true,"n_predict":5}`))
	req.Header.Set("X-Humanizer", "1")
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer browser-supplied")
	req.Header.Set("Origin", base)
	r2, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	sc := bufio.NewScanner(r2.Body)
	var got strings.Builder
	for sc.Scan() {
		line := sc.Text()
		if strings.HasPrefix(line, "data: ") {
			var ev map[string]any
			json.Unmarshal([]byte(line[6:]), &ev)
			if s, ok := ev["content"].(string); ok {
				got.WriteString(s)
			}
		}
	}
	r2.Body.Close()
	if got.String() != "Hello there." {
		t.Fatalf("streamed %q", got.String())
	}
	up, body := fl.last()
	if up.Header.Get("Authorization") != "Bearer sekret" || up.Header.Get("Origin") != "" || up.Header.Get("X-Humanizer") != "" {
		t.Fatalf("upstream headers wrong: %v", up.Header)
	}
	if body["prompt"] != "P" || body["n_predict"] != float64(5) {
		t.Fatalf("upstream body %v", body)
	}

	_, b = call(t, "POST", base+"/api/tokenize", map[string]any{"content": "a b c"}, nil)
	if !strings.Contains(string(b), `"tokens"`) {
		t.Fatalf("tokenize: %s", b)
	}
	for _, p := range []string{"/api/slots", "/api/v1/chat/completions", "/api/v1/models", "/api/metrics"} {
		if resp, _ := call(t, "POST", base+p, map[string]any{}, nil); resp.StatusCode != 404 {
			t.Errorf("POST %s → %d, want 404", p, resp.StatusCode)
		}
	}
	if resp, _ := call(t, "GET", base+"/api/completion", nil, nil); resp.StatusCode != 404 {
		t.Errorf("GET /api/completion → %d, want 404", resp.StatusCode)
	}

	call(t, "POST", base+"/app/server", map[string]any{"disconnect": true}, nil)
	if st := status(t, base); st["phase"] != "setup" {
		t.Fatalf("after disconnect: %v", st["phase"])
	}
}

func TestOpenAIKind(t *testing.T) {
	fl := &fakeLlama{nctx: 8192}
	upstream := httptest.NewServer(fl)
	defer upstream.Close()
	_, base := testApp(t)

	_, b := call(t, "POST", base+"/app/server/test", map[string]any{"kind": "openai", "url": upstream.URL}, nil)
	var tr probeResult
	json.Unmarshal(b, &tr)
	if !tr.OK || len(tr.Models) != 2 {
		t.Fatalf("probe = %+v", tr)
	}
	call(t, "POST", base+"/app/server", map[string]any{"kind": "openai", "url": upstream.URL, "model": "humanizer-12b"}, nil)
	resp, body := call(t, "POST", base+"/api/v1/chat/completions", map[string]any{"messages": []any{}, "stream": true}, nil)
	if resp.StatusCode != 200 || !strings.Contains(string(body), "[DONE]") {
		t.Fatalf("chat proxy: %d %s", resp.StatusCode, body)
	}
	if up, _ := fl.last(); up.URL.Path != "/v1/chat/completions" {
		t.Fatalf("upstream path %s", up.URL.Path)
	}
	if resp, _ := call(t, "POST", base+"/api/completion", map[string]any{}, nil); resp.StatusCode != 404 {
		t.Fatalf("/api/completion in openai mode → %d", resp.StatusCode)
	}
}

func TestProbeProblems(t *testing.T) {
	fl := &fakeLlama{loading: true}
	up := httptest.NewServer(fl)
	defer up.Close()
	r := probeServer(context.Background(), KindLlamaCpp, up.URL, "")
	if r.OK || r.Code != "loading" {
		t.Fatalf("loading: %+v", r)
	}
	other := httptest.NewServer(http.NotFoundHandler())
	defer other.Close()
	r = probeServer(context.Background(), KindLlamaCpp, other.URL, "")
	if r.OK || r.Code != "not_llamacpp" {
		t.Fatalf("not llama: %+v", r)
	}
	l, _ := net.Listen("tcp", "127.0.0.1:0")
	addr := l.Addr().String()
	l.Close()
	r = probeServer(context.Background(), KindLlamaCpp, "http://"+addr, "")
	if r.OK || r.Code != "unreachable" {
		t.Fatalf("unreachable: %+v", r)
	}
}

func TestUpstreamDownGives502(t *testing.T) {
	_, base := testApp(t)
	l, _ := net.Listen("tcp", "127.0.0.1:0")
	addr := l.Addr().String()
	l.Close()
	call(t, "POST", base+"/app/server", map[string]any{"kind": "llamacpp", "url": "http://" + addr}, nil)
	resp, b := call(t, "POST", base+"/api/completion", map[string]any{"prompt": "x"}, nil)
	if resp.StatusCode != 502 || !strings.Contains(string(b), "external_unreachable") {
		t.Fatalf("%d %s", resp.StatusCode, b)
	}
	waitFor(t, "unreachable status", func() bool {
		ext, _ := status(t, base)["external"].(map[string]any)
		return ext != nil && ext["reachable"] == false && ext["code"] == "unreachable"
	})
}

func TestGuard(t *testing.T) {
	_, base := testApp(t)
	req, _ := http.NewRequest("POST", base+"/app/server", strings.NewReader(`{}`))
	resp, _ := http.DefaultClient.Do(req)
	if resp.StatusCode != 403 {
		t.Fatalf("no header → %d", resp.StatusCode)
	}
	_, _ = call(t, "GET", base+"/app/status", nil, nil)
	resp, _ = call(t, "GET", base+"/app/status", nil, map[string]string{"Origin": "https://evil.example"})
	if resp.StatusCode != 403 {
		t.Fatalf("evil origin → %d", resp.StatusCode)
	}
	req, _ = http.NewRequest("GET", base+"/app/status", nil)
	req.Host = "evil.example"
	resp, _ = http.DefaultClient.Do(req)
	if resp.StatusCode != 403 {
		t.Fatalf("evil host → %d", resp.StatusCode)
	}
	resp, b := call(t, "GET", base+"/", nil, nil)
	if resp.StatusCode != 200 || !strings.Contains(string(b), "ok") || !strings.Contains(resp.Header.Get("Content-Security-Policy"), "connect-src 'self'") {
		t.Fatalf("static: %d %q %v", resp.StatusCode, b, resp.Header)
	}
}

func TestConfigEndpointHasPrompt(t *testing.T) {
	_, base := testApp(t)
	_, b := call(t, "GET", base+"/app/config", nil, nil)
	var c struct {
		Probe       string         `json:"probe"`
		Fingerprint string         `json:"fingerprint"`
		Sampling    map[string]any `json:"sampling"`
	}
	if err := json.Unmarshal(b, &c); err != nil {
		t.Fatal(err)
	}
	if c.Probe != BuildPrompt("X") || c.Fingerprint != pythonFingerprint || c.Sampling["top_k"] != float64(0) {
		t.Fatalf("config: %+v", c)
	}
}
