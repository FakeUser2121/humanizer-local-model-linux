# Humanizer Linux — bring-your-own-server edition

This is the Linux app for this fork ([FakeUser2121/humanizer-local-model-linux](https://github.com/FakeUser2121/humanizer-local-model-linux)).
Converted from the upstream [`app/`](https://github.com/sgaofen/humanizer-local-model/tree/main/app). **No model download, no bundled engine, no auto-updates, no
storage-location settings.** You run `llama-server` yourself (any machine),
this app serves the same editor UI on `http://127.0.0.1:47615/` and forwards
rewrite requests to your server.

Two server types (picked in the UI under **… → Model server…**):

| Type | Your server | What the app uses |
|---|---|---|
| `llamacpp` (recommended) | `llama-server -m humanizer-*.gguf -c 8192 -np 1 -ngl 99 --port 8080` | native `/completion` (exact training prompt, prompt probe self-check), `/tokenize` (real token counts), `/props` (context size auto-detect) |
| `openai` | LM Studio / Ollama / vLLM with a humanizer GGUF loaded | streaming `/chat/completions`, draft as the only user message; token counts estimated from words |

The API key (if your server needs one, e.g. `llama-server --api-key …`) is sent
to the launcher once, stored as `api-key` (mode `0600`) in the data dir
(`~/.config/humanizer-llamacpp`), added by the proxy on every request, and
**never** sent back to the browser.

**Long drafts now show word-level change highlights at any length — new wording highlighted, replaced wording struck through, no more "too long to show changes", even on 30+ section rewrites.**

## Use it

```bash
# 1. start your model server (example: local GPU box)
llama-server -m humanizer-12b-Q8_0.gguf -c 8192 -np 1 -ngl 99 --port 8080

# 2. run the app
chmod +x Humanizer-1.0.0-x86_64.AppImage
./Humanizer-1.0.0-x86_64.AppImage
# first run: the page opens a "Model server" dialog — enter http://127.0.0.1:8080, Test, Save.

# handy flags (also as HUMANIZER_* env vars):
./Humanizer-1.0.0-x86_64.AppImage --server http://192.168.1.10:8080   # pre-configure + skip dialog
./Humanizer-1.0.0-x86_64.AppImage --kind openai --server http://localhost:1234/v1 --model my-model
./Humanizer-1.0.0-x86_64.AppImage --api-key SECRET --server http://host:8080
./Humanizer-1.0.0-x86_64.AppImage --no-browser --port 47615 --idle-exit 0
./Humanizer-1.0.0-x86_64.AppImage --version
```

Remote server note: start `llama-server` with `--host 0.0.0.0` so other
machines can reach it. Your draft text is sent to whatever address you enter —
use a local address to stay fully offline.

## Build it yourself

```bash
cd app
./build.sh                 # runs Go tests + web logic tests, then packs dist/Humanizer-<ver>-<arch>.AppImage
VERSION=1.2.3 ./build.sh   # version string
ARCH=aarch64 ./build.sh    # cross-build ARM64
SKIP_TESTS=1 ./build.sh    # skip tests
```

Needs: `bash curl tar go>=1.21 node` (node only for the web test step).
First build downloads the Go module deps and `appimagetool` into `.cache/`.

## What changed vs upstream

- Deleted: model tiers/download/verify, bundled llama.cpp engine + GPU backends,
  update checker, storage-location settings, `pick-dir`, engine restart/reveal.
- New thin launcher: `internal/launcher/{config,app,server,main,connection}.go`
  (~1100 lines, stdlib + `ledongthuc/pdf` for .docx/.pdf import, kept as-is).
- Kept byte-for-byte: prompt (`prompt.go`, fingerprint `cc51d66b4c593fbe`),
  `.docx`/`.pdf` import, rewrite/guard/facts/diff/history web modules.
- Web UI: setup screen is now a connect card; server dialog has a type selector
  (`llamacpp`/`openai`), test/save/disconnect; status light shows
  connected / unreachable / loading / auth states.

License: same as upstream — Apache-2.0 (`LICENSE`), plus `NOTICE`
(Gemma fine-tune attribution).
