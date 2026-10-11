package launcher

import (
	"context"
	"io/fs"
	"log"
	"path/filepath"
	"sync"
	"sync/atomic"
	"time"
)

// Options are passed in by package main.
type Options struct {
	Web           fs.FS
	DefaultConfig []byte
	Version       string
	Args          []string
}

type App struct {
	opts     Options
	cfg      Config
	dataDir  string
	settings Settings
	web      fs.FS
	logger   *log.Logger
	port     int
	url      string

	rootCtx  context.Context
	shutdown context.CancelFunc

	mu        sync.Mutex // guards settings, srvKey, health
	srvKey    string     // API key for the model server (never sent to the browser)
	health    healthState
	probeKick chan struct{}

	lastSeen atomic.Int64
	idleExit time.Duration
	inflight atomic.Int32 // rewrite requests in flight (the idle timer never fires during one)
}

func (a *App) logf(format string, args ...any) {
	if a.logger != nil {
		a.logger.Printf(format, args...)
	}
}

func (a *App) settingsPath() string { return filepath.Join(a.dataDir, "settings.json") }

func (a *App) touch() { a.lastSeen.Store(time.Now().UnixNano()) }

// idleLoop quits the app when the web page has been closed for idleExit.
func (a *App) idleLoop(ctx context.Context) {
	if a.idleExit <= 0 {
		return
	}
	t := time.NewTicker(30 * time.Second)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			if a.inflight.Load() > 0 {
				a.touch()
				continue
			}
			if time.Since(time.Unix(0, a.lastSeen.Load())) > a.idleExit {
				a.logf("web page closed for more than %s, exiting", a.idleExit)
				a.shutdown()
				return
			}
		}
	}
}
