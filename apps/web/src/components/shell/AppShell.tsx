// App shell (§4.2 "coquille applicative"): fixed sidebar + topbar around a routed <Outlet/>.
// Owns the one piece of state every route needs — the current identity — and republishes it as
// an Outlet context so route components (ChatPage today) can key their data on login/logout the
// same way the previous single-page main.tsx did (`key={`${id}:${authToken()}`}`).
import { Outlet, useOutletContext } from "react-router-dom";
import { Sidebar } from "./Sidebar.tsx";
import { Topbar } from "./Topbar.tsx";
import { useState, useCallback } from "react";

export interface ShellContext {
  identityKey: number;   // bumped on login/logout — route components remount/refetch on it
  bumpIdentity: () => void;
}

export function AppShell() {
  const [identityKey, setIdentityKey] = useState(0);
  const bumpIdentity = useCallback(() => setIdentityKey((k) => k + 1), []);

  return (
    <div className="flex h-screen overflow-hidden bg-background text-foreground">
      <Sidebar />
      <div className="flex min-w-0 flex-1 flex-col">
        <Topbar onIdentityChange={bumpIdentity} />
        <main className="min-h-0 flex-1">
          <Outlet context={{ identityKey, bumpIdentity } satisfies ShellContext} />
        </main>
      </div>
    </div>
  );
}

// Route components call this to read the shared shell state (currently just identityKey).
export function useShell(): ShellContext {
  return useOutletContext<ShellContext>();
}
