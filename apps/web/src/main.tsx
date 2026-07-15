import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import "./globals.css";
import { Chat } from "./Chat.tsx";
import { RightPanel } from "./RightPanel.tsx";
import { LoginControl } from "./LoginControl.tsx";
import { authHeaders, authToken } from "./auth.ts";

// Control room (§4.4): chat on the left, live governance audit trail on the right. On load we
// create a REAL conversation against backend-core and run live; if it's unreachable we fall
// back to demo mode so the UI still renders.
function App() {
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [live, setLive] = useState(false);
  const [tried, setTried] = useState(false);

  // If a token is present in localStorage ('olma_token') attach it as a Bearer header so the
  // backend resolves the real user; absent → authHeaders() returns the plain content-type bag and
  // the no-login bootstrap behaves exactly as before (backend falls back to usr_dev).
  const bootstrap = () =>
    fetch("/api/v1/conversations", {
      method: "POST", headers: authHeaders({ "content-type": "application/json" }), body: "{}",
    })
      .then((r) => r.json())
      .then((c) => { setConversationId(c.id); setLive(true); setTried(true); })
      .catch(() => { setConversationId("conv_demo"); setLive(false); setTried(true); });

  useEffect(() => { bootstrap(); }, []);

  if (!tried || !conversationId) {
    return (
      <div className="flex h-screen items-center justify-center bg-background text-muted-foreground">
        Connexion au backend…
      </div>
    );
  }
  // key by conversationId + token → identity changes (login/logout) and "Nouveau" both mint a
  // fresh conversation and remount both panes clean.
  return (
    <div className="flex h-screen flex-col">
      <header className="flex h-12 shrink-0 items-center border-b px-4">
        <span className="font-semibold tracking-tight">Axone</span>
        <div className="ml-auto">
          <LoginControl onChange={bootstrap} />
        </div>
      </header>
      <div className="grid min-h-0 flex-1 grid-cols-1 md:grid-cols-[minmax(0,1fr)_minmax(320px,440px)]">
        <Chat key={`${conversationId}:${authToken()}`} conversationId={conversationId} demo={!live} onNew={live ? bootstrap : undefined} />
        <RightPanel key={`${conversationId}:${authToken()}`} conversationId={conversationId} live={live} />
      </div>
    </div>
  );
}

// The design system is dark (control-room aesthetic, §4.5).
document.documentElement.classList.add("dark");
createRoot(document.getElementById("root")!).render(<App />);
