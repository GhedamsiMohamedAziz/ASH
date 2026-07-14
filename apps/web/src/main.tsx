import React from "react";
import { createRoot } from "react-dom/client";
import { Chat } from "./Chat.tsx";
import { AuditPanel } from "./AuditPanel.tsx";

// Control room (§4.4): the chat on the left, the live governance audit trail on the right —
// who acted, on whose behalf, what was allowed/denied/approved, what DLP redacted. Demo mode
// renders both without a backend. Set demo={false} + run `make backend` (Vite proxy) for live.
function ControlRoom() {
  return (
    <div className="control-room">
      <Chat conversationId="conv_1" demo />
      <AuditPanel />
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<ControlRoom />);
