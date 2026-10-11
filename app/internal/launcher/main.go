package launcher

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"syscall"
	"time"
)

type instanceInfo struct {
	PID     int    `json:"pid"`
	Port    int    `json:"port"`
	Version string `json:"version,omitempty"`
}

func envOr(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}

func atoiOr(s string, def int) int {
	if n, err := strconv.Atoi(s); err == nil {
		return n
	}
	return def
}

// Main is the launcher entry point; it returns the process exit code.
func Main(o Options) int {
	fl := flag.NewFlagSet("humanizer", flag.ContinueOnError)
	dataDirFlag := fl.String("data-dir", os.Getenv("HUMANIZER_DATA_DIR"), "settings and log directory (default ~/.config/humanizer-llamacpp)")
	serverFlag := fl.String("server", os.Getenv("HUMANIZER_SERVER"), "model server URL to connect to, e.g. http://192.168.1.10:8080 (saved to settings)")
	kindFlag := fl.String("kind", envOr("HUMANIZER_KIND", ""), "server type for --server: llamacpp (default) or openai")
	keyFlag := fl.String("api-key", os.Getenv("HUMANIZER_API_KEY"), "API key for --server (saved in the data directory, mode 0600)")
	modelFlag := fl.String("model", os.Getenv("HUMANIZER_MODEL"), "model name to send (openai kind only)")
	noBrowser := fl.Bool("no-browser", os.Getenv("HUMANIZER_NO_BROWSER") != "", "do not open the browser automatically")
	webDir := fl.String("web-dir", os.Getenv("HUMANIZER_WEB_DIR"), "serve the web UI from this directory (development)")
	port := fl.Int("port", atoiOr(os.Getenv("HUMANIZER_PORT"), 0), "web UI port (default: a fixed port so browser history survives restarts)")
	idle := fl.Int("idle-exit", atoiOr(os.Getenv("HUMANIZER_IDLE_EXIT"), -1), "quit N minutes after the web page is closed, 0 = never, -1 = default")
	showVer := fl.Bool("version", false, "print version and exit")
	fl.SetOutput(io.Discard)
	if err := fl.Parse(o.Args); err != nil {
		fl.SetOutput(os.Stderr)
		fmt.Fprintln(os.Stderr, "Usage: humanizer [options]")
		fl.PrintDefaults()
		return 2
	}
	if *showVer {
		fmt.Println("humanizer (bring-your-own-server)", o.Version)
		return 0
	}

	dataDir := *dataDirFlag
	if strings.TrimSpace(dataDir) == "" {
		dataDir = defaultDataDir()
	}
	if abs, err := filepath.Abs(dataDir); err == nil {
		dataDir = abs
	}
	if err := os.MkdirAll(filepath.Join(dataDir, "logs"), 0o755); err != nil {
		fmt.Fprintln(os.Stderr, "cannot create data directory:", err)
		return 1
	}

	// Already running: just open its page.
	if inst, ok := runningInstance(dataDir); ok {
		u := fmt.Sprintf("http://127.0.0.1:%d/", inst.Port)
		fmt.Println("Humanizer is already running:", u)
		if !*noBrowser {
			_ = openURL(u)
		}
		return 0
	}

	logPath := filepath.Join(dataDir, "logs", "launcher.log")
	rotateLog(logPath, 2<<20)
	lf, err := os.OpenFile(logPath, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
	var logw io.Writer = os.Stderr
	if err == nil {
		logw = io.MultiWriter(lf, os.Stderr)
		defer lf.Close()
	}
	logger := log.New(logw, "", log.LstdFlags)
	logger.Printf("===== Humanizer %s starting (%s/%s), data dir %s", o.Version, runtime.GOOS, runtime.GOARCH, dataDir)

	cfg, err := loadConfig(o.DefaultConfig, filepath.Join(dataDir, "config.json"))
	if err != nil {
		logger.Printf("config error: %v", err)
		return 1
	}
	a := &App{opts: o, cfg: cfg, dataDir: dataDir, logger: logger, probeKick: make(chan struct{}, 1)}
	a.settings = loadSettings(a.settingsPath())
	a.srvKey = a.loadAPIKey()
	a.web = o.Web
	if *webDir != "" {
		a.web = os.DirFS(*webDir)
		logger.Printf("serving the web UI from disk: %s", *webDir)
	}
	if *idle >= 0 {
		a.idleExit = time.Duration(*idle) * time.Minute
	} else {
		a.idleExit = time.Duration(cfg.IdleExitMinutes) * time.Minute
	}

	// --server / HUMANIZER_SERVER: configure from the command line.
	if strings.TrimSpace(*serverFlag) != "" {
		kind := *kindFlag
		if kind == "" {
			kind = KindLlamaCpp
		}
		if !validKind(kind) {
			fmt.Fprintf(os.Stderr, "unknown --kind %q (use llamacpp or openai)\n", kind)
			return 2
		}
		base, err := normalizeServerURL(*serverFlag, kind)
		if err != nil {
			fmt.Fprintf(os.Stderr, "bad --server URL %q\n", *serverFlag)
			return 2
		}
		if *keyFlag != "" {
			if err := a.saveAPIKey(strings.TrimSpace(*keyFlag)); err != nil {
				logger.Printf("saving API key failed: %v", err)
			}
			a.srvKey = strings.TrimSpace(*keyFlag)
		}
		a.settings.Server = &ServerSettings{Kind: kind, URL: base, Model: strings.TrimSpace(*modelFlag)}
		_ = saveSettings(a.settingsPath(), a.settings)
	} else if *keyFlag != "" {
		_ = a.saveAPIKey(strings.TrimSpace(*keyFlag))
		a.srvKey = strings.TrimSpace(*keyFlag)
	}
	if sv := a.settings.Server; sv != nil {
		logger.Printf("model server: %s (%s)", sv.URL, sv.Kind)
	} else {
		logger.Printf("no model server configured yet; the web page will ask for one")
	}

	ln, err := listenPreferred(*port, a.settings.Port, cfg.PreferredPort)
	if err != nil {
		logger.Printf("cannot listen: %v", err)
		return 1
	}
	a.port = ln.Addr().(*net.TCPAddr).Port
	a.url = fmt.Sprintf("http://127.0.0.1:%d/", a.port)
	if *port == 0 && a.settings.Port != a.port {
		a.settings.Port = a.port
		_ = saveSettings(a.settingsPath(), a.settings)
	}

	ctx, cancel := context.WithCancel(context.Background())
	a.rootCtx, a.shutdown = ctx, cancel
	a.touch()
	a.writeInstance()

	srv := &http.Server{Handler: a.handler(), ReadHeaderTimeout: 10 * time.Second}
	go func() {
		if err := srv.Serve(ln); err != nil && err != http.ErrServerClosed {
			logger.Printf("HTTP server error: %v", err)
			cancel()
		}
	}()
	logger.Printf("web UI: %s", a.url)
	fmt.Println("Humanizer:", a.url)

	if !*noBrowser {
		if err := openURL(a.url); err != nil {
			logger.Printf("could not open a browser (%v). Open %s yourself.", err, a.url)
		}
	}
	go a.idleLoop(ctx)
	go a.watchLoop(ctx)

	sig := make(chan os.Signal, 1)
	signal.Notify(sig, os.Interrupt, syscall.SIGTERM)
	select {
	case s := <-sig:
		logger.Printf("signal %v, exiting", s)
	case <-ctx.Done():
	}
	cancel()
	_ = os.Remove(filepath.Join(dataDir, "instance.json"))
	sctx, scancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer scancel()
	_ = srv.Shutdown(sctx)
	logger.Printf("bye")
	return 0
}

func (a *App) writeInstance() {
	b, _ := json.Marshal(instanceInfo{PID: os.Getpid(), Port: a.port, Version: a.opts.Version})
	_ = writeFileAtomic(filepath.Join(a.dataDir, "instance.json"), b, 0o644)
}

// listenPreferred prefers a fixed port: localStorage is per origin (including the port), so a
// changing port would hide the saved history.
func listenPreferred(forced, saved, preferred int) (net.Listener, error) {
	if forced > 0 {
		return net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", forced))
	}
	var cands []int
	if saved > 0 {
		cands = append(cands, saved)
	}
	for i := 0; i < 10 && preferred > 0; i++ {
		cands = append(cands, preferred+i)
	}
	for _, p := range cands {
		if l, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", p)); err == nil {
			return l, nil
		}
	}
	return net.Listen("tcp", "127.0.0.1:0")
}

func runningInstance(dataDir string) (instanceInfo, bool) {
	var inst instanceInfo
	b, err := os.ReadFile(filepath.Join(dataDir, "instance.json"))
	if err != nil || json.Unmarshal(b, &inst) != nil || inst.Port <= 0 {
		return inst, false
	}
	c := &http.Client{Timeout: 1500 * time.Millisecond}
	req, _ := http.NewRequest("GET", fmt.Sprintf("http://127.0.0.1:%d/app/ping", inst.Port), nil)
	req.Host = fmt.Sprintf("127.0.0.1:%d", inst.Port)
	resp, err := c.Do(req)
	if err != nil {
		return inst, false
	}
	defer resp.Body.Close()
	var p struct {
		App string `json:"app"`
	}
	if json.NewDecoder(resp.Body).Decode(&p) != nil || p.App != "humanizer" {
		return inst, false
	}
	return inst, true
}

func rotateLog(path string, max int64) {
	if st, err := os.Stat(path); err == nil && st.Size() > max {
		_ = os.Rename(path, path+".1")
	}
}

func openURL(u string) error {
	if _, err := exec.LookPath("xdg-open"); err != nil {
		return err
	}
	cmd := exec.Command("xdg-open", u)
	cmd.Stdin, cmd.Stdout, cmd.Stderr = nil, nil, nil
	// Clear variables the AppImage runtime may have set so the host's browser starts cleanly.
	cmd.Env = cleanEnvForChild(os.Environ())
	return cmd.Start()
}

func cleanEnvForChild(env []string) []string {
	out := make([]string, 0, len(env))
	for _, e := range env {
		if strings.HasPrefix(e, "APPIMAGE=") || strings.HasPrefix(e, "APPDIR=") || strings.HasPrefix(e, "ARGV0=") || strings.HasPrefix(e, "OWD=") {
			continue
		}
		out = append(out, e)
	}
	return out
}
