package orchestrator

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os/exec"
	"testing"
	"time"
)

// fakeOpenCode mimics the real opencode HTTP API for offline/CI testing.
func fakeOpenCode(t *testing.T, frames []string) *httptest.Server {
	mux := http.NewServeMux()
	mux.HandleFunc("/session", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("content-type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]string{"id": "ses_test"})
	})
	mux.HandleFunc("/session/ses_test/prompt", func(w http.ResponseWriter, r *http.Request) {
		if got := r.Header.Get("authorization"); got != "Bearer jwt123" {
			t.Errorf("TASK JWT not forwarded: %q", got)
		}
		w.WriteHeader(http.StatusOK)
	})
	mux.HandleFunc("/event", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("content-type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		for _, f := range frames {
			fmt.Fprintf(w, "data: %s\n\n", f)
		}
	})
	return httptest.NewServer(mux)
}

func TestProfileToAgentMapping(t *testing.T) {
	if AgentForProfile("dev") != "build" {
		t.Fatalf("dev should map to build, got %s", AgentForProfile("dev"))
	}
	if AgentForProfile("unknown") != "general" {
		t.Fatal("unknown profile should fall back to general")
	}
}

func TestCreateSessionAndPrompt(t *testing.T) {
	srv := fakeOpenCode(t, nil)
	defer srv.Close()
	c := &OpenCodeClient{BaseURL: srv.URL, HTTP: srv.Client()}

	sid, err := c.CreateSession(context.Background())
	if err != nil || sid != "ses_test" {
		t.Fatalf("create session: %v (%s)", err, sid)
	}
	if err := c.Prompt(context.Background(), sid, "jwt123", "dev", "hello"); err != nil {
		t.Fatalf("prompt failed: %v", err)
	}
}

func TestStreamEventsRelays(t *testing.T) {
	frames := []string{
		`{"type":"message.updated"}`,
		`not json — skipped`,
		`{"type":"session.idle"}`,
		`[DONE]`,
	}
	srv := fakeOpenCode(t, frames)
	defer srv.Close()
	c := &OpenCodeClient{BaseURL: srv.URL, HTTP: srv.Client()}

	var got []AgentEvent
	if err := c.StreamEvents(context.Background(), func(e AgentEvent) { got = append(got, e) }); err != nil {
		t.Fatalf("stream: %v", err)
	}
	if len(got) != 2 { // malformed skipped, [DONE] ends
		t.Fatalf("want 2 events, got %d: %+v", len(got), got)
	}
	if got[0].Type != "message.updated" {
		t.Fatalf("unexpected first event: %+v", got[0])
	}
}

// TestRealOpenCodeServer boots the ACTUAL opencode binary in server mode and drives
// the real API — proving §12 "run OpenCode in server mode + agents load". Skips
// when opencode isn't installed (CI without the binary).
func TestRealOpenCodeServer(t *testing.T) {
	bin, err := exec.LookPath("opencode")
	if err != nil {
		t.Skip("opencode not installed")
	}
	cmd := exec.Command(bin, "serve", "--port", "45099", "--hostname", "127.0.0.1", "--log-level", "ERROR")
	if err := cmd.Start(); err != nil {
		t.Skipf("could not start opencode: %v", err)
	}
	defer func() { _ = cmd.Process.Kill() }()

	c := &OpenCodeClient{BaseURL: "http://127.0.0.1:45099", HTTP: &http.Client{Timeout: 5 * time.Second}}
	// wait for readiness
	var sid string
	for i := 0; i < 40; i++ {
		if sid, err = c.CreateSession(context.Background()); err == nil {
			break
		}
		time.Sleep(250 * time.Millisecond)
	}
	if sid == "" {
		t.Fatalf("could not create a session on the real server: %v", err)
	}
	if len(sid) < 4 || sid[:4] != "ses_" {
		t.Fatalf("unexpected session id from real server: %s", sid)
	}
}
