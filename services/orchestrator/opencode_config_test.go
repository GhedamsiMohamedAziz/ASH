package orchestrator

import (
	"encoding/json"
	"os"
	"strings"
	"testing"
)

// opencodeConfig is the subset of opencode 1.17's opencode.json we assert on.
// opencode reads MCP servers from the top-level "mcp" map (verified: the binary's
// `opencode mcp add` writes to the ["mcp", <name>] path) — NOT "mcpServers".
type opencodeConfig struct {
	Schema string                  `json:"$schema"`
	MCP    map[string]mcpServerCfg `json:"mcp"`
	Tools  map[string]bool         `json:"tools"`
}

type mcpServerCfg struct {
	Type    string            `json:"type"` // "remote" | "local"
	URL     string            `json:"url"`
	Enabled bool              `json:"enabled"`
	Headers map[string]string `json:"headers"`
}

const (
	sandboxOpencodeConfig = "../../sandbox/opencode.json"
	gatewayMCPName        = "mcp-gateway"
	gatewayMCPURL         = "https://mcp-gateway.internal:8443/mcp"
)

// TestOpenCodeConfigShape is an offline, container-free guarantee that the sandbox
// image would boot OpenCode with the MCP Gateway wired as its ONLY remote MCP server
// (§12, README "OpenCode + profiles wiring"). It does NOT spawn a container — it only
// validates the static config the Dockerfile copies into the image.
func TestOpenCodeConfigShape(t *testing.T) {
	raw, err := os.ReadFile(sandboxOpencodeConfig)
	if err != nil {
		t.Fatalf("read %s: %v", sandboxOpencodeConfig, err)
	}

	var cfg opencodeConfig
	// DisallowUnknownFields would be too strict (opencode has many keys); a plain
	// Unmarshal proves it is valid JSON in the shape opencode expects.
	if err := json.Unmarshal(raw, &cfg); err != nil {
		t.Fatalf("opencode.json is not valid JSON: %v", err)
	}

	if cfg.Schema != "https://opencode.ai/config.json" {
		t.Errorf("missing/incorrect $schema: %q", cfg.Schema)
	}

	// --- exactly one remote MCP server, and it is the Gateway ---
	var remotes []string
	for name, s := range cfg.MCP {
		if s.Type == "remote" {
			remotes = append(remotes, name)
		}
	}
	if len(remotes) != 1 {
		t.Fatalf("want exactly 1 remote MCP server, got %d: %v", len(remotes), remotes)
	}
	if remotes[0] != gatewayMCPName {
		t.Fatalf("the sole remote MCP server must be %q, got %q", gatewayMCPName, remotes[0])
	}

	gw := cfg.MCP[gatewayMCPName]
	if gw.URL != gatewayMCPURL {
		t.Errorf("gateway url = %q, want %q", gw.URL, gatewayMCPURL)
	}
	if !gw.Enabled {
		t.Errorf("gateway MCP server must be enabled")
	}

	// --- TASK_JWT presented as a bearer header, no secret baked on disk ---
	auth := gw.Headers["Authorization"]
	if !strings.HasPrefix(auth, "Bearer ") {
		t.Errorf("gateway Authorization header must be a Bearer token, got %q", auth)
	}
	if !strings.Contains(auth, "{env:TASK_JWT}") {
		t.Errorf("gateway must resolve TASK_JWT from env via {env:TASK_JWT}, got %q", auth)
	}

	// --- tools allow-list is non-empty (derived from profiles/*.json groups) ---
	if len(cfg.Tools) == 0 {
		t.Fatal("tools allow-list must be non-empty")
	}
	anyEnabled := false
	for _, on := range cfg.Tools {
		if on {
			anyEnabled = true
			break
		}
	}
	if !anyEnabled {
		t.Fatal("tools allow-list must enable at least one tool group")
	}
}
