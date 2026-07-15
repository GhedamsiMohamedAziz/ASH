// Route: /chat (§4.3–4.4) — the flagship page: conversation list (left) · streaming thread
// (center, Chat.tsx) · governance tabs (right, RightPanel.tsx). Owns conversation bootstrap/
// selection; Chat/RightPanel keep their existing self-contained WebSocket + last_seq-resume
// logic untouched (they're keyed by conversationId so switching conversations is a clean remount,
// same pattern the old main.tsx used for login/logout).
import { useCallback, useEffect, useState } from "react";
import { useShell } from "@/components/shell/AppShell";
import { ConversationList, type ConversationSummary } from "@/components/chat/ConversationList";
import { Chat } from "../Chat.tsx";
import { RightPanel } from "../RightPanel.tsx";
import { api, tryGet } from "@/lib/api";
import { authToken } from "../auth.ts";
import { Loader2 } from "lucide-react";

export function ChatPage() {
  const { identityKey } = useShell();
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [live, setLive] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  const createConversation = useCallback(async (): Promise<ConversationSummary | null> => {
    try {
      const c = await api.post<ConversationSummary>("/conversations", {});
      setLive(true);
      return c;
    } catch {
      return null;
    }
  }, []);

  // On mount (and whenever identity changes — login/logout mints a fresh view of "your"
  // conversations) load the real list; if it's empty, start one so the page never opens blank.
  useEffect(() => {
    let stop = false;
    setLoading(true);
    (async () => {
      const page = await tryGet<{ items: ConversationSummary[] }>("/conversations", { items: [] });
      if (stop) return;
      if (page.items.length > 0) {
        setConversations(page.items);
        setSelectedId(page.items[0].id);
        setLive(true);
      } else {
        const created = await createConversation();
        if (stop) return;
        if (created) {
          setConversations([created]);
          setSelectedId(created.id);
        } else {
          // backend unreachable — demo mode so the UI still renders (tolerant-degrade, ADR-017)
          setConversations([]);
          setSelectedId("conv_demo");
          setLive(false);
        }
      }
      setLoading(false);
    })();
    return () => { stop = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [identityKey]);

  const handleNew = useCallback(async () => {
    setBusy(true);
    const created = await createConversation();
    if (created) {
      setConversations((prev) => [created, ...prev]);
      setSelectedId(created.id);
    }
    setBusy(false);
  }, [createConversation]);

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center gap-2 text-muted-foreground">
        <Loader2 className="size-4 animate-spin" /> Connexion au backend…
      </div>
    );
  }

  return (
    <div className="grid h-full min-h-0 grid-cols-1 min-[860px]:grid-cols-[220px_minmax(0,1fr)] lg:grid-cols-[220px_minmax(0,1fr)_minmax(320px,420px)]">
      <ConversationList items={conversations} selectedId={selectedId} onSelect={setSelectedId} onNew={handleNew} busy={busy} />
      <Chat
        key={`${selectedId}:${identityKey}`}
        conversationId={selectedId ?? "conv_demo"}
        demo={!live}
        onNew={handleNew}
      />
      <div className="hidden lg:block lg:min-h-0">
        <RightPanel key={`${selectedId}:${identityKey}:${authToken()}`} conversationId={selectedId ?? undefined} live={live} />
      </div>
    </div>
  );
}
