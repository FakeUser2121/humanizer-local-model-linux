package launcher

// Everything about "the user's model server": URL normalisation, connectivity probe,
// the reverse proxy the web page talks through, and the /app/server* handlers.
//
// The browser never talks to the model server directly. It only talks to this launcher on
// 127.0.0.1; the launcher forwards a small allow-list of endpoints and adds the API key (if any),
// so the page needs no CORS support from the server and the key never reaches the browser.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"slices"
	"sort"
	"strings"
	"time"
)

const apiKeyFile = "api-key"

// ───────────── URL normalisation ─────────────

// normalizeServerURL turns what the user typed into a base URL.
//
//	llamacpp: host:8080, http://host:8080/, http://host:8080/v1, .../completion  → http://host:8080
//	openai:   host:1234, http://host:1234/v1/chat/completions                    → http://host:1234/v1
func normalizeServerURL(raw, kind string) (string, error) {
	s := strings.TrimSpace(raw)
	if s == "" {
		return "", errors.New("empty")
	}
	if !strings.Contains(s, "://") {
		s = "http://" + s
	}
	u, err := url.Parse(s)
	if err != nil || u.Host == "" || (u.Scheme != "http" && u.Scheme != "https") {
		return "", errors.New("bad_url")
	}
	if u.User != nil {
		return "", errors.New("bad_url") // put secrets in the API key field, not in the URL
	}
	p := strings.TrimRight(u.Path, "/")
	switch kind {
	case KindOpenAI:
		for _, suffix := range []string{"/chat/completions", "/completions", "/models"} {
			p = strings.TrimSuffix(p, suffix)
		}
		p = strings.TrimRight(p, "/")
		if p == "" {
			p = "/v1"
		}
	case KindLlamaCpp:
		for _, suffix := range []string{"/chat/completions", "/completions", "/completion", "/models",
			"/props", "/health", "/tokenize", "/detokenize", "/slots"} {
			p = strings.TrimSuffix(p, suffix)
		}
		p = strings.TrimSuffix(strings.TrimRight(p, "/"), "/v1")
		p = strings.TrimRight(p, "/")
	default:
		return "", errors.New("bad_kind")
	}
	u.Path, u.RawPath, u.RawQuery, u.Fragment = p, "", "", ""
	return u.String(), nil
}

func validKind(k string) bool { return k == KindLlamaCpp || k == KindOpenAI }

// ───────────── transport ─────────────

// Only connecting and TLS are time-limited. Generation itself (long documents, slow machines)
// has no overall deadline; the user can press Stop at any time.
var serverTransport = &http.Transport{
	Proxy:               http.ProxyFromEnvironment, // localhost / 127.0.0.1 are never proxied
	DialContext:         (&net.Dialer{Timeout: 5 * time.Second}).DialContext,
	TLSHandshakeTimeout: 10 * time.Second,
	MaxIdleConnsPerHost: 2,
	IdleConnTimeout:     60 * time.Second,
}

func joinURL(base, p string) string { return strings.TrimRight(base, "/") + p }

// ───────────── probe ─────────────

type probeResult struct {
	OK      bool     `json:"ok"`
	Code    string   `json:"code,omitempty"` // bad_url | unreachable | auth | http | not_llamacpp | loading
	Message string   `json:"message,omitempty"`
	URL     string   `json:"url,omitempty"`
	Models  []string `json:"models,omitempty"`
	Model   string   `json:"model,omitempty"`    // what the server says it has loaded
	CtxSize int      `json:"ctx_size,omitempty"` // per-request context the server reports (llama.cpp /props)
}

func httpGet(ctx context.Context, rawURL, key string) (int, []byte, error) {
	req, err := http.NewRequestWithContext(ctx, "GET", rawURL, nil)
	if err != nil {
		return 0, nil, err
	}
	if key != "" {
		req.Header.Set("Authorization", "Bearer "+key)
	}
	resp, err := (&http.Client{Transport: serverTransport}).Do(req)
	if err != nil {
		return 0, nil, err
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	return resp.StatusCode, body, nil
}

func errMessage(body []byte) string {
	msg := strings.TrimSpace(string(body))
	var j struct {
		Error any `json:"error"`
	}
	if json.Unmarshal(body, &j) == nil && j.Error != nil {
		if m, ok := j.Error.(map[string]any); ok && m["message"] != nil {
			msg = fmt.Sprint(m["message"])
		} else {
			msg = fmt.Sprint(j.Error)
		}
	}
	if len(msg) > 300 {
		msg = msg[:300]
	}
	return msg
}

func probeServer(parent context.Context, kind, base, key string) probeResult {
	ctx, cancel := context.WithTimeout(parent, 6*time.Second)
	defer cancel()
	r := probeResult{URL: base}
	if kind == KindOpenAI {
		return probeOpenAI(ctx, base, key, r)
	}
	return probeLlama(ctx, base, key, r)
}

func probeLlama(ctx context.Context, base, key string, r probeResult) probeResult {
	status, body, err := httpGet(ctx, joinURL(base, "/health"), "")
	if err != nil {
		r.Code, r.Message = "unreachable", err.Error()
		return r
	}
	switch {
	case status == 503:
		r.Code, r.Message = "loading", "the server is still loading the model"
		return r
	case status == 401 || status == 403:
		r.Code, r.Message = "auth", errMessage(body)
		return r
	case status != 200:
		r.Code, r.Message = "not_llamacpp", fmt.Sprintf("GET /health → HTTP %d", status)
		return r
	}
	var h struct {
		Status string `json:"status"`
	}
	if json.Unmarshal(body, &h) != nil || h.Status == "" {
		r.Code, r.Message = "not_llamacpp", "GET /health did not return llama-server JSON"
		return r
	}
	if h.Status != "ok" {
		r.Code, r.Message = "loading", "server status: "+h.Status
		return r
	}
	// /health is public even when --api-key is set, so check the key (and learn n_ctx) via /props.
	status, body, err = httpGet(ctx, joinURL(base, "/props"), key)
	if err != nil {
		r.Code, r.Message = "unreachable", err.Error()
		return r
	}
	if status == 401 || status == 403 {
		r.Code, r.Message = "auth", errMessage(body)
		return r
	}
	if status == 200 {
		var p struct {
			ModelAlias string `json:"model_alias"`
			ModelPath  string `json:"model_path"`
			NCtx       int    `json:"n_ctx"`
			Default    struct {
				NCtx int `json:"n_ctx"`
			} `json:"default_generation_settings"`
		}
		if json.Unmarshal(body, &p) == nil {
			r.CtxSize = p.Default.NCtx
			if r.CtxSize == 0 {
				r.CtxSize = p.NCtx
			}
			r.Model = p.ModelAlias
			if r.Model == "" && p.ModelPath != "" {
				r.Model = path.Base(strings.ReplaceAll(p.ModelPath, "\\", "/"))
			}
			if r.Model != "" {
				r.Models = []string{r.Model}
			}
		}
	}
	r.OK = true
	return r
}

func probeOpenAI(ctx context.Context, base, key string, r probeResult) probeResult {
	status, body, err := httpGet(ctx, joinURL(base, "/models"), key)
	if err != nil {
		r.Code, r.Message = "unreachable", err.Error()
		return r
	}
	if status == 401 || status == 403 {
		r.Code, r.Message = "auth", errMessage(body)
		return r
	}
	if status != 200 {
		r.Code, r.Message = "http", fmt.Sprintf("HTTP %d %s", status, errMessage(body))
		return r
	}
	var list struct {
		Data []struct {
			ID string `json:"id"`
		} `json:"data"`
		Models []struct { // Ollama / llama-server style
			Name string `json:"name"`
		} `json:"models"`
	}
	if json.Unmarshal(body, &list) != nil {
		r.Code, r.Message = "http", "not an OpenAI-compatible /models response"
		return r
	}
	for _, m := range list.Data {
		if m.ID != "" {
			r.Models = append(r.Models, m.ID)
		}
	}
	for _, m := range list.Models {
		if m.Name != "" {
			r.Models = append(r.Models, m.Name)
		}
	}
	sort.Strings(r.Models)
	r.Models = slices.Compact(r.Models) // llama-server lists each model twice (data + models)
	r.OK = true
	return r
}

// ───────────── API key file ─────────────

func (a *App) apiKeyPath() string { return filepath.Join(a.dataDir, apiKeyFile) }

func (a *App) loadAPIKey() string {
	b, err := os.ReadFile(a.apiKeyPath())
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(b))
}

func (a *App) saveAPIKey(key string) error {
	if key == "" {
		if err := os.Remove(a.apiKeyPath()); err != nil && !errors.Is(err, os.ErrNotExist) {
			return err
		}
		return nil
	}
	return writeFileAtomic(a.apiKeyPath(), []byte(key), 0o600)
}

// ───────────── status shared with the web page ─────────────

type serverStatus struct {
	Enabled     bool   `json:"enabled"` // a server is configured
	Kind        string `json:"kind,omitempty"`
	URL         string `json:"url,omitempty"`
	Model       string `json:"model,omitempty"`
	HasKey      bool   `json:"has_key"`
	Reachable   *bool  `json:"reachable"` // nil = not checked yet
	Code        string `json:"code,omitempty"`
	Message     string `json:"message,omitempty"`
	ServerModel string `json:"server_model,omitempty"`
}

// serverStatusLocked: caller holds a.mu.
func (a *App) serverStatusLocked() *serverStatus {
	s := &serverStatus{HasKey: a.srvKey != ""}
	if sv := a.settings.Server; sv != nil {
		s.Enabled, s.Kind, s.URL, s.Model = true, sv.Kind, sv.URL, sv.Model
		if a.health.Checked {
			ok := a.health.OK
			s.Reachable = &ok
			s.Code, s.Message, s.ServerModel = a.health.Code, a.health.Message, a.health.Model
		}
	}
	return s
}

// ───────────── reverse proxy ─────────────

var llamaAllow = map[string]string{
	"/completion": http.MethodPost,
	"/tokenize":   http.MethodPost,
	"/detokenize": http.MethodPost,
	"/health":     http.MethodGet,
	"/props":      http.MethodGet,
}

func (a *App) apiProxy() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		a.mu.Lock()
		sv, key := a.settings.Server, a.srvKey
		a.mu.Unlock()
		if sv == nil {
			writeJSON(w, http.StatusServiceUnavailable, map[string]any{"error": map[string]any{"code": 503, "type": "not_configured", "message": "No model server configured yet."}})
			return
		}
		base, err := url.Parse(sv.URL)
		sub := strings.TrimPrefix(r.URL.Path, "/api")
		if err != nil {
			http.NotFound(w, r)
			return
		}
		switch sv.Kind {
		case KindOpenAI:
			if sub != "/v1/chat/completions" || r.Method != http.MethodPost {
				http.NotFound(w, r)
				return
			}
			sub = "/chat/completions" // base already ends with /v1
		case KindLlamaCpp:
			if m, ok := llamaAllow[sub]; !ok || m != r.Method {
				http.NotFound(w, r)
				return
			}
		default:
			http.NotFound(w, r)
			return
		}
		a.inflight.Add(1)
		defer a.inflight.Add(-1)
		newProxy(base, key, sub).ServeHTTP(w, r)
	})
}

func newProxy(base *url.URL, key, sub string) http.Handler {
	return &httputil.ReverseProxy{
		Rewrite: func(pr *httputil.ProxyRequest) {
			pr.Out.URL.Scheme = base.Scheme
			pr.Out.URL.Host = base.Host
			pr.Out.URL.Path = strings.TrimRight(base.Path, "/") + sub
			pr.Out.URL.RawPath = ""
			pr.Out.URL.RawQuery = ""
			pr.Out.Host = base.Host
			for _, h := range []string{"Origin", "Referer", "Cookie", "X-Humanizer", "Authorization"} {
				pr.Out.Header.Del(h)
			}
			if key != "" {
				pr.Out.Header.Set("Authorization", "Bearer "+key)
			}
		},
		Transport:     serverTransport,
		FlushInterval: -1, // SSE: push every token to the browser immediately
		ModifyResponse: func(r *http.Response) error {
			for _, h := range []string{"Access-Control-Allow-Origin", "Access-Control-Allow-Credentials", "Set-Cookie"} {
				r.Header.Del(h)
			}
			return nil
		},
		ErrorHandler: func(w http.ResponseWriter, r *http.Request, err error) {
			if r.Context().Err() != nil { // user pressed Stop
				return
			}
			writeJSON(w, http.StatusBadGateway, map[string]any{"error": map[string]any{
				"code": 502, "type": "external_unreachable", "url": base.String(),
				"message": "Cannot reach the model server at " + base.String() + ": " + err.Error(),
			}})
		},
	}
}

// ───────────── handlers ─────────────

func (a *App) handleServerGet(w http.ResponseWriter, r *http.Request) {
	a.mu.Lock()
	s := a.serverStatusLocked()
	a.mu.Unlock()
	writeJSON(w, 200, s)
}

// POST /app/server {kind, url, model, api_key?, disconnect?}
// api_key: omitted = keep the saved one, "" = delete it.
func (a *App) handleServerSet(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Kind       string  `json:"kind"`
		URL        string  `json:"url"`
		Model      string  `json:"model"`
		APIKey     *string `json:"api_key"`
		Disconnect bool    `json:"disconnect"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 8192)).Decode(&req); err != nil {
		writeJSON(w, 400, map[string]any{"error": "bad json", "code": "bad_json"})
		return
	}
	if req.Disconnect {
		a.mu.Lock()
		a.settings.Server = nil
		a.health = healthState{}
		s := a.settings
		a.mu.Unlock()
		if err := saveSettings(a.settingsPath(), s); err != nil {
			a.logf("saving settings failed: %v", err)
		}
		a.logf("disconnected from the model server")
		a.handleServerGet(w, r)
		return
	}
	if req.Kind == "" {
		req.Kind = KindLlamaCpp
	}
	if !validKind(req.Kind) {
		writeJSON(w, 400, map[string]any{"error": "bad kind", "code": "bad_kind"})
		return
	}
	base, err := normalizeServerURL(req.URL, req.Kind)
	if err != nil {
		writeJSON(w, 400, map[string]any{"error": "bad url", "code": "bad_url"})
		return
	}
	model := strings.TrimSpace(req.Model)
	if len(model) > 256 {
		writeJSON(w, 400, map[string]any{"error": "model name too long", "code": "bad_model"})
		return
	}
	if req.APIKey != nil {
		key := strings.TrimSpace(*req.APIKey)
		if len(key) > 4096 || strings.ContainsAny(key, "\r\n") {
			writeJSON(w, 400, map[string]any{"error": "bad api key", "code": "bad_key"})
			return
		}
		if err := a.saveAPIKey(key); err != nil {
			writeJSON(w, 500, map[string]any{"error": err.Error(), "code": "save_failed"})
			return
		}
		a.mu.Lock()
		a.srvKey = key
		a.mu.Unlock()
	}
	a.setServer(&ServerSettings{Kind: req.Kind, URL: base, Model: model})
	a.handleServerGet(w, r)
}

// setServer stores the settings and triggers an immediate connectivity check.
func (a *App) setServer(sv *ServerSettings) {
	a.mu.Lock()
	a.settings.Server = sv
	a.health = healthState{}
	s := a.settings
	a.mu.Unlock()
	if err := saveSettings(a.settingsPath(), s); err != nil {
		a.logf("saving settings failed: %v", err)
	}
	a.logf("model server: %s (%s)", sv.URL, sv.Kind)
	a.kickProbe()
}

// POST /app/server/test {kind, url, api_key?}: the saved key is used when api_key is omitted.
func (a *App) handleServerTest(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Kind   string  `json:"kind"`
		URL    string  `json:"url"`
		APIKey *string `json:"api_key"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 8192)).Decode(&req); err != nil {
		writeJSON(w, 400, map[string]any{"ok": false, "code": "bad_json"})
		return
	}
	if req.Kind == "" {
		req.Kind = KindLlamaCpp
	}
	base, err := normalizeServerURL(req.URL, req.Kind)
	if err != nil {
		writeJSON(w, 200, map[string]any{"ok": false, "code": "bad_url"})
		return
	}
	a.mu.Lock()
	key := a.srvKey
	a.mu.Unlock()
	if req.APIKey != nil {
		key = strings.TrimSpace(*req.APIKey)
	}
	writeJSON(w, 200, probeServer(r.Context(), req.Kind, base, key))
}

// ───────────── background health check ─────────────

type healthState struct {
	Checked bool
	OK      bool
	Code    string
	Message string
	Model   string
	CtxSize int
	At      time.Time
}

func (a *App) kickProbe() {
	select {
	case a.probeKick <- struct{}{}:
	default:
	}
}

func (a *App) watchLoop(ctx context.Context) {
	t := time.NewTicker(5 * time.Second)
	defer t.Stop()
	for {
		a.runProbe(ctx)
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		case <-a.probeKick:
		}
	}
}

func (a *App) runProbe(ctx context.Context) {
	a.mu.Lock()
	sv, key := a.settings.Server, a.srvKey
	a.mu.Unlock()
	if sv == nil {
		return
	}
	// Nobody has the page open: don't poll the server for nothing.
	if time.Since(time.Unix(0, a.lastSeen.Load())) > time.Minute {
		return
	}
	res := probeServer(ctx, sv.Kind, sv.URL, key)
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.settings.Server == nil || a.settings.Server.URL != sv.URL || a.settings.Server.Kind != sv.Kind {
		return // changed while we were probing
	}
	prev := a.health
	a.health = healthState{Checked: true, OK: res.OK, Code: res.Code, Message: res.Message, Model: res.Model, CtxSize: res.CtxSize, At: time.Now()}
	if !prev.Checked || prev.OK != res.OK {
		if res.OK {
			a.logf("model server reachable (%s, n_ctx=%d, model=%q)", sv.URL, res.CtxSize, res.Model)
		} else {
			a.logf("model server not ready: %s %s", res.Code, res.Message)
		}
	}
}
