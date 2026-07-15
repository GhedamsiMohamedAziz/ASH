// Shell topbar: current page label + the dev login control (§7.1). Kept out of the sidebar so
// login/logout stays reachable from every route, and out of ChatPage so it isn't chat-specific.
// Brand ("Axone") already lives in the sidebar header — no need to repeat it here.
import { useLocation } from "react-router-dom";
import { ROUTES } from "../../routes/index.ts";
import { LoginControl } from "../../LoginControl.tsx";

export function Topbar({ onIdentityChange }: { onIdentityChange: () => void }) {
  const { pathname } = useLocation();
  const current = ROUTES.find((r) => pathname === `/${r.path}`);

  return (
    <header className="flex h-14 shrink-0 items-center gap-3 border-b border-border bg-panel px-4">
      <span className="font-heading text-base font-semibold tracking-tight text-foreground">
        {current?.label ?? ""}
      </span>
      <div className="ml-auto">
        <LoginControl onChange={onIdentityChange} />
      </div>
    </header>
  );
}
