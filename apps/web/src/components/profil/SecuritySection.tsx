// Sécurité (§2.6): mot de passe, 2FA (TOTP), sessions actives — rose accent (§4.5
// "rose = sécurité/danger"). No backend route exists yet for any of the three (checked
// services/backend-core/app/main.py and services/auth-service/app/main.py: only /token, /verify,
// /admin/rotate, /oidc/dev-login — no password/2FA/session endpoints). Real, usable forms are
// built below, but every submit stays disabled with an honest "bientôt disponible" instead of
// faking a success (ADR-017) — nothing here ever claims to have changed anything server-side.
import { useState } from "react";
import { ShieldAlert, KeyRound, ScanFace, Monitor, Info } from "lucide-react";
import { SectionCard } from "./SectionCard";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";

function PendingNote({ children }: { children: string }) {
  return (
    <p className="flex items-start gap-1.5 text-[11px] leading-relaxed text-muted-foreground">
      <Info className="mt-0.5 size-3 shrink-0 text-rose" aria-hidden /> {children}
    </p>
  );
}

function PasswordForm() {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const mismatch = next.length > 0 && confirm.length > 0 && next !== confirm;

  return (
    <div className="flex flex-col gap-3">
      <h3 className="flex items-center gap-1.5 text-sm font-medium text-foreground">
        <KeyRound className="size-3.5 text-rose" aria-hidden /> Mot de passe
      </h3>
      <div className="grid min-w-0 grid-cols-1 gap-2 sm:grid-cols-3">
        <Input
          type="password"
          placeholder="Mot de passe actuel"
          autoComplete="current-password"
          value={current}
          onChange={(e) => setCurrent(e.target.value)}
          className="min-w-0"
        />
        <Input
          type="password"
          placeholder="Nouveau mot de passe"
          autoComplete="new-password"
          value={next}
          onChange={(e) => setNext(e.target.value)}
          className="min-w-0"
        />
        <Input
          type="password"
          placeholder="Confirmer"
          autoComplete="new-password"
          aria-invalid={mismatch}
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          className="min-w-0"
        />
      </div>
      {mismatch && <p className="text-xs text-rose">Les deux mots de passe ne correspondent pas.</p>}
      <div>
        <Button
          size="sm"
          variant="outline"
          className="border-rose/40 text-rose hover:bg-rose/10"
          disabled
          title="Bientôt disponible"
        >
          Mettre à jour le mot de passe
        </Button>
      </div>
      <PendingNote>
        Bientôt disponible — aucun endpoint de changement de mot de passe n'est encore exposé par
        auth-service.
      </PendingNote>
    </div>
  );
}

function TwoFactorToggle() {
  return (
    <div className="flex flex-col gap-3">
      <h3 className="flex items-center gap-1.5 text-sm font-medium text-foreground">
        <ScanFace className="size-3.5 text-rose" aria-hidden /> Authentification à deux facteurs (TOTP)
      </h3>
      <div className="flex items-center justify-between gap-3 rounded-md border bg-card px-3 py-2.5">
        <span className="min-w-0 flex-1 text-sm text-card-foreground">
          Exiger un code TOTP en plus du mot de passe à chaque connexion.
        </span>
        <button
          type="button"
          role="switch"
          aria-checked={false}
          disabled
          title="Bientôt disponible"
          className="relative inline-flex h-5 w-9 shrink-0 cursor-not-allowed items-center rounded-full bg-panel-2 opacity-50 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <span className="inline-block size-3.5 translate-x-1 rounded-full bg-muted-foreground transition-transform" />
        </button>
      </div>
      <PendingNote>Bientôt disponible — l'enrôlement TOTP n'est pas encore branché.</PendingNote>
    </div>
  );
}

function ActiveSessions() {
  return (
    <div className="flex flex-col gap-3">
      <h3 className="flex items-center gap-1.5 text-sm font-medium text-foreground">
        <Monitor className="size-3.5 text-rose" aria-hidden /> Sessions actives
      </h3>
      <div className="flex items-center gap-3 rounded-md border bg-card px-3 py-2.5">
        <Monitor className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        <span className="min-w-0 flex-1 text-sm text-card-foreground">Cette session (navigateur actuel)</span>
        <Badge variant="secondary" className="shrink-0 text-green">active</Badge>
      </div>
      <PendingNote>
        La gestion des sessions distantes (liste multi-appareils, révocation) n'est pas encore
        exposée par le backend — seule la session en cours, déjà connue localement, est affichée.
      </PendingNote>
    </div>
  );
}

export function SecuritySection() {
  return (
    <SectionCard
      icon={ShieldAlert}
      title="Sécurité"
      description="Mot de passe, double authentification et sessions."
      accent="rose"
    >
      <PasswordForm />
      <Separator />
      <TwoFactorToggle />
      <Separator />
      <ActiveSessions />
    </SectionCard>
  );
}
