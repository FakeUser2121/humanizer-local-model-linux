// Humanizer (Linux, bring-your-own-server edition).
//
// A tiny local launcher: it serves the embedded web UI on 127.0.0.1 and proxies
// rewrite requests to YOUR llama.cpp server (or any OpenAI-compatible server).
// It does not download, bundle or start any model or inference engine.
package main

import (
	"embed"
	"io/fs"
	"os"

	"github.com/FakeUser2121/humanizer-local-model-linux/app/internal/launcher"
)

//go:embed web
var webFS embed.FS

//go:embed config/default.json
var defaultConfig []byte

// Overridden at build time with -ldflags "-X main.version=...".
var version = "dev"

func main() {
	web, err := fs.Sub(webFS, "web")
	if err != nil {
		panic(err)
	}
	os.Exit(launcher.Main(launcher.Options{
		Web:           web,
		DefaultConfig: defaultConfig,
		Version:       version,
		Args:          os.Args[1:],
	}))
}
