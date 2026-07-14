package orchestrator

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
)

// OpenCode runs headless in the sandbox: `opencode serve --port 4096` (§12, ADR 009).
// This client speaks its REAL HTTP API (verified against opencode 1.17):
//   POST /session                      → create a session
//   POST /session/{id}/prompt          → send a turn  {prompt:{text}, agent, model}
//   GET  /event  (SSE)                 → stream events → agent.events.{conversation_id} (§10.2)
// The orchestrator maps an Axone profile (dev/data-analyst/ops/generalist,
// sandbox/profiles/) to an OpenCode agent; the TASK JWT is forwarded so the MCP
// client presents it to the Gateway (§13).

type AgentEvent struct {
	Type string                 `json:"type"`
	Data map[string]interface{} `json:"data,omitempty"`
}

// AgentProfile is an Axone profile name; profileToAgent maps it to an OpenCode agent.
type AgentProfile string

var profileToAgent = map[AgentProfile]string{
	"dev":          "build",
	"data-analyst": "general",
	"ops":          "general",
	"generalist":   "general",
}

// AgentForProfile resolves the OpenCode agent for an Axone profile (§9.5).
func AgentForProfile(p AgentProfile) string {
	if a, ok := profileToAgent[p]; ok {
		return a
	}
	return "general"
}

type OpenCodeClient struct {
	BaseURL string
	HTTP    *http.Client
}

type sessionResp struct {
	ID string `json:"id"`
}

// CreateSession opens a new OpenCode session, returning its id.
func (c *OpenCodeClient) CreateSession(ctx context.Context) (string, error) {
	req, _ := http.NewRequestWithContext(ctx, http.MethodPost, c.BaseURL+"/session",
		bytes.NewReader([]byte("{}")))
	req.Header.Set("content-type", "application/json")
	resp, err := c.HTTP.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("create session: HTTP %d", resp.StatusCode)
	}
	var s sessionResp
	if err := json.NewDecoder(resp.Body).Decode(&s); err != nil {
		return "", err
	}
	return s.ID, nil
}

// Prompt sends a turn to a session. The TASK JWT is forwarded as a bearer header
// (OpenCode → MCP client → Gateway, §13). Non-2xx is an error.
func (c *OpenCodeClient) Prompt(ctx context.Context, sessionID, taskJWT, profile, text string) error {
	body, _ := json.Marshal(map[string]interface{}{
		"prompt": map[string]string{"text": text},
		"agent":  AgentForProfile(AgentProfile(profile)),
	})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost,
		fmt.Sprintf("%s/session/%s/prompt", c.BaseURL, sessionID), bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("content-type", "application/json")
	if taskJWT != "" {
		req.Header.Set("authorization", "Bearer "+taskJWT)
	}
	resp, err := c.HTTP.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode/100 != 2 {
		return fmt.Errorf("opencode prompt: HTTP %d", resp.StatusCode)
	}
	return nil
}

// StreamEvents subscribes to the SSE event stream and relays each event to onEvent
// (the orchestrator forwards these to NATS agent.events.{conversation_id}, §10.2).
// Returns when the stream closes or ctx is done.
func (c *OpenCodeClient) StreamEvents(ctx context.Context, onEvent func(AgentEvent)) error {
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, c.BaseURL+"/event", nil)
	req.Header.Set("accept", "text/event-stream")
	resp, err := c.HTTP.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("opencode events: HTTP %d", resp.StatusCode)
	}
	return relaySSE(resp.Body, onEvent)
}

// relaySSE parses a `data: {json}` SSE stream into AgentEvents. A malformed line
// is skipped rather than aborting the whole stream.
func relaySSE(r interface{ Read([]byte) (int, error) }, onEvent func(AgentEvent)) error {
	scanner := bufio.NewScanner(newReader(r))
	scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" || !strings.HasPrefix(line, "data:") {
			continue
		}
		payload := strings.TrimSpace(strings.TrimPrefix(line, "data:"))
		if payload == "[DONE]" {
			return nil
		}
		var ev AgentEvent
		if err := json.Unmarshal([]byte(payload), &ev); err != nil {
			continue
		}
		onEvent(ev)
	}
	return scanner.Err()
}

func newReader(r interface{ Read([]byte) (int, error) }) *readerShim { return &readerShim{r} }

type readerShim struct {
	r interface{ Read([]byte) (int, error) }
}

func (s *readerShim) Read(p []byte) (int, error) { return s.r.Read(p) }
