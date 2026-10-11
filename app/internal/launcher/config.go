package launcher

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
)

type NPredictRule struct {
	Factor float64 `json:"factor"`
	Min    int     `json:"min"`
	Max    int     `json:"max"`
}

// Config is the built-in default configuration (config/default.json).
// A config.json in the data directory may override individual fields.
type Config struct {
	Schema          int            `json:"schema"`
	Sampling        map[string]any `json:"sampling"`
	NPredict        NPredictRule   `json:"n_predict"`
	CtxSize         int            `json:"ctx_size"` // assumed context size until the server reports its real one
	IdleExitMinutes int            `json:"idle_exit_minutes"`
	PreferredPort   int            `json:"preferred_port"`
}

func loadConfig(def []byte, overridePath string) (Config, error) {
	var c Config
	if err := json.Unmarshal(def, &c); err != nil {
		return c, fmt.Errorf("built-in config: %w", err)
	}
	if b, err := os.ReadFile(overridePath); err == nil {
		// Overlay: fields present in the file replace the default; sampling is merged key by key.
		var over Config
		if err := json.Unmarshal(b, &over); err != nil {
			return c, fmt.Errorf("%s: %w", overridePath, err)
		}
		var raw map[string]json.RawMessage
		_ = json.Unmarshal(b, &raw)
		if _, ok := raw["sampling"]; ok {
			for k, v := range over.Sampling {
				c.Sampling[k] = v
			}
		}
		if _, ok := raw["n_predict"]; ok {
			c.NPredict = over.NPredict
		}
		if over.CtxSize > 0 {
			c.CtxSize = over.CtxSize
		}
		if _, ok := raw["idle_exit_minutes"]; ok {
			c.IdleExitMinutes = over.IdleExitMinutes
		}
		if over.PreferredPort > 0 {
			c.PreferredPort = over.PreferredPort
		}
	}
	return c, c.validate()
}

func (c *Config) validate() error {
	if len(c.Sampling) == 0 {
		return fmt.Errorf("config: sampling is empty")
	}
	if c.NPredict.Factor <= 0 || c.NPredict.Min <= 0 || c.NPredict.Max < c.NPredict.Min {
		return fmt.Errorf("config: bad n_predict %+v", c.NPredict)
	}
	if c.CtxSize < 512 {
		return fmt.Errorf("config: ctx_size too small")
	}
	return nil
}

// Server kinds.
const (
	KindLlamaCpp = "llamacpp" // llama-server native API: /completion, /tokenize, /props, /health
	KindOpenAI   = "openai"   // OpenAI-compatible: /v1/chat/completions (LM Studio, Ollama, vLLM...)
)

// ServerSettings is the user's model server, saved in settings.json.
type ServerSettings struct {
	Kind  string `json:"kind"`
	URL   string `json:"url"`             // normalised base URL
	Model string `json:"model,omitempty"` // only used by the OpenAI-compatible kind
}

type Settings struct {
	Port   int             `json:"port,omitempty"`
	Server *ServerSettings `json:"server,omitempty"`
}

func loadSettings(path string) Settings {
	var s Settings
	if b, err := os.ReadFile(path); err == nil {
		_ = json.Unmarshal(b, &s)
	}
	return s
}

func saveSettings(path string, s Settings) error {
	b, _ := json.MarshalIndent(s, "", "  ")
	return writeFileAtomic(path, b, 0o644)
}

func writeFileAtomic(path string, b []byte, mode os.FileMode) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, b, mode); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

// defaultDataDir: $XDG_CONFIG_HOME/humanizer-llamacpp or ~/.config/humanizer-llamacpp.
func defaultDataDir() string {
	if d := os.Getenv("XDG_CONFIG_HOME"); d != "" {
		return filepath.Join(d, "humanizer-llamacpp")
	}
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".config", "humanizer-llamacpp")
}
