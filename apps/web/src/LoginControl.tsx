// Dev login control (§7.1) for the top bar: logged-out state offers a small inline form (identifiant
// / org / role) plus quick presets for a fast demo; logged-in state shows a compact identity chip
// with a sign-out button. Purely additive — with no token the rest of the app behaves exactly as
// today (see auth.ts). shadcn/ui only, dark control-room aesthetic.
import React, { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { login, clearToken, currentUser } from "./auth.ts";
import { User, LogIn, LogOut, XCircle } from "lucide-react";

const PRESETS = [
  { sub: "usr_mehdi", org: "org_9", role: "admin", label: "usr_mehdi / org_9 (admin)" },
  { sub: "usr_sarah", org: "org_9", role: "member", label: "usr_sarah / org_9" },
];

export function LoginControl({ onChange }: { onChange: () => void }) {
  const [open, setOpen] = useState(false);
  const [sub, setSub] = useState("");
  const [org, setOrg] = useState("");
  const [role, setRole] = useState("member");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const user = currentUser();

  const submit = async (values?: { sub: string; org: string; role: string }) => {
    const s = (values?.sub ?? sub).trim();
    const o = (values?.org ?? org).trim();
    const r = (values?.role ?? role).trim() || "member";
    if (!s || !o || busy) return;
    setBusy(true);
    setError(null);
    try {
      await login(s, o, r);
      setOpen(false);
      setSub("");
      setOrg("");
      setRole("member");
      onChange();
    } catch {
      setError("Échec de la connexion.");
    } finally {
      setBusy(false);
    }
  };

  const logout = () => {
    clearToken();
    onChange();
  };

  if (user) {
    return (
      <div className="flex items-center gap-2">
        <Badge variant="outline" className="flex items-center gap-1.5 text-muted-foreground">
          <User className="size-3.5" /> {user.sub} · {user.org}
        </Badge>
        <Button size="sm" variant="outline" onClick={logout}>
          <LogOut className="size-3.5" /> Se déconnecter
        </Button>
      </div>
    );
  }

  if (!open) {
    return (
      <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
        <LogIn className="size-3.5" /> Se connecter
      </Button>
    );
  }

  return (
    <div className="flex flex-col items-end gap-2">
      <div className="flex items-center gap-2">
        <Input
          placeholder="identifiant (sub)"
          value={sub}
          disabled={busy}
          onChange={(e) => setSub(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && submit()}
          className="h-8 w-36 text-xs"
        />
        <Input
          placeholder="org"
          value={org}
          disabled={busy}
          onChange={(e) => setOrg(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && submit()}
          className="h-8 w-24 text-xs"
        />
        <Input
          placeholder="role"
          value={role}
          disabled={busy}
          onChange={(e) => setRole(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && submit()}
          className="h-8 w-20 text-xs"
        />
        <Button size="sm" onClick={() => submit()} disabled={busy || !sub.trim() || !org.trim()}>
          Connecter
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setOpen(false)} disabled={busy}>
          Annuler
        </Button>
      </div>
      <div className="flex items-center gap-1.5">
        {PRESETS.map((p) => (
          <Button
            key={p.label}
            size="sm"
            variant="secondary"
            className="h-6 px-2 text-xs"
            disabled={busy}
            onClick={() => submit(p)}
          >
            {p.label}
          </Button>
        ))}
      </div>
      {error && (
        <p className="flex items-center gap-1.5 text-xs text-rose-400">
          <XCircle className="size-3.5 shrink-0" /> {error}
        </p>
      )}
    </div>
  );
}
