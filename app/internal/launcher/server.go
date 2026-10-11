package launcher

import (
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"strings"
	"time"
)

func (a *App) handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /app/ping", a.handlePing)
	mux.HandleFunc("GET /app/status", a.handleStatus)
	mux.HandleFunc("GET /app/config", a.handleConfig)
	mux.HandleFunc("POST /app/document", a.handleDocument)
	mux.HandleFunc("GET /app/server", a.handleServerGet)
	mux.HandleFunc("POST /app/server", a.handleServerSet)
	mux.HandleFunc("POST /app/server/test", a.handleServerTest)
	mux.HandleFunc("POST /app/quit", a.handleQuit)
	mux.Handle("/api/", a.apiProxy())
	mux.Handle("/", a.static())
	return a.guard(mux)
}

// guard blocks:
//  1. a Host that is not 127.0.0.1/localhost (DNS rebinding);
//  2. cross-site pages calling the API (Origin check);
//  3. write requests without the X-Humanizer header (a custom header forces a CORS preflight,
//     which other websites cannot pass).
func (a *App) guard(next http.Handler) http.Handler {
	okHost := map[string]bool{
		fmt.Sprintf("127.0.0.1:%d", a.port): true,
		fmt.Sprintf("localhost:%d", a.port): true,
	}
	okOrigin := map[string]bool{
		fmt.Sprintf("http://127.0.0.1:%d", a.port): true,
		fmt.Sprintf("http://localhost:%d", a.port): true,
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !okHost[r.Host] {
			http.Error(w, "forbidden host", http.StatusForbidden)
			return
		}
		if o := r.Header.Get("Origin"); o != "" && !okOrigin[o] {
			http.Error(w, "forbidden origin", http.StatusForbidden)
			return
		}
		isAPI := strings.HasPrefix(r.URL.Path, "/app/") || strings.HasPrefix(r.URL.Path, "/api/")
		if isAPI && r.Method != http.MethodGet && r.Method != http.MethodHead && r.Header.Get("X-Humanizer") != "1" {
			http.Error(w, "missing X-Humanizer header", http.StatusForbidden)
			return
		}
		h := w.Header()
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("Referrer-Policy", "no-referrer")
		h.Set("Cross-Origin-Resource-Policy", "same-origin")
		if r.URL.Path != "/app/ping" {
			a.touch()
		}
		next.ServeHTTP(w, r)
	})
}

func (a *App) static() http.Handler {
	fsrv := http.FileServerFS(a.web)
	csp := "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; " +
		"font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'"
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Security-Policy", csp)
		w.Header().Set("Cache-Control", "no-cache")
		fsrv.ServeHTTP(w, r)
	})
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}

func (a *App) handlePing(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, 200, map[string]any{"app": "humanizer", "version": a.opts.Version, "pid": os.Getpid()})
}

type statusResp struct {
	App             string        `json:"app"`
	Version         string        `json:"version"`
	Phase           string        `json:"phase"` // "setup" (no server yet) | "ready"
	CtxSize         int           `json:"ctx_size"`
	CtxDetected     bool          `json:"ctx_detected"`
	IdleExitMinutes int           `json:"idle_exit_minutes"`
	DataDir         string        `json:"data_dir"`
	External        *serverStatus `json:"external"` // name kept for the web code: the configured model server
}

func (a *App) handleStatus(w http.ResponseWriter, r *http.Request) {
	s := statusResp{
		App: "humanizer", Version: a.opts.Version, Phase: "setup",
		IdleExitMinutes: int(a.idleExit / time.Minute), DataDir: a.dataDir, CtxSize: a.cfg.CtxSize,
	}
	a.mu.Lock()
	s.External = a.serverStatusLocked()
	if s.External.Enabled {
		s.Phase = "ready"
	}
	if a.health.Checked && a.health.OK && a.health.CtxSize > 0 {
		s.CtxSize, s.CtxDetected = a.health.CtxSize, true
	}
	a.mu.Unlock()
	writeJSON(w, 200, s)
}

// handleConfig gives the web page what it needs to build the prompt. probe = BuildPrompt("X"):
// the page builds the same string itself and refuses to rewrite if the two differ.
func (a *App) handleConfig(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, 200, map[string]any{
		"instr":       promptInstr,
		"sep":         promptSep,
		"probe":       BuildPrompt("X"),
		"fingerprint": PromptFingerprint(),
		"sampling":    a.cfg.Sampling,
		"n_predict":   a.cfg.NPredict,
		"ctx_size":    a.cfg.CtxSize,
	})
}

func (a *App) handleQuit(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, 200, map[string]any{"ok": true})
	go func() {
		time.Sleep(150 * time.Millisecond) // let the response go out first
		a.shutdown()
	}()
}
