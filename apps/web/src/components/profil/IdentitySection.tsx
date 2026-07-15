// Identité (§2.6 "Profil"). Source of truth split across two real endpoints:
//  - GET /api/v1/me        → user_id, always answers (dev-fallback usr_dev/org_1 when no token).
//  - GET /api/v1/whoami    → user_id + org_id, SIGNATURE-VERIFIED, but 401s without a bearer.
// Role is not returned by either route (whoami deliberately omits it) — it's read locally from
// the session JWT's own claims via identity.ts's decodeSessionClaims, same pattern LoginControl
// already uses for its "logged in as" chip. Email has no backing field anywhere in this API
// surface, so it is ALWAYS "—" — never fabricated (ADR-017).
import { UserRound, Loader2 } from "lucide-react";
import { SectionCard } from "./SectionCard";
import { roleLabel, type SessionClaims } from "./identity";

function Field({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-xs uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className="font-mono text-sm text-foreground">{value}</dd>
      {hint && <span className="text-[11px] text-muted-foreground">{hint}</span>}
    </div>
  );
}

export function IdentitySection({
  loading,
  userId,
  orgId,
  hasToken,
  claims,
}: {
  loading: boolean;
  userId: string | null;
  orgId: string | null;
  hasToken: boolean;
  claims: SessionClaims | null;
}) {
  if (loading) {
    return (
      <SectionCard icon={UserRound} title="Identité" description="Votre identité sur cette session.">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-3.5 animate-spin" /> Chargement…
        </div>
      </SectionCard>
    );
  }

  return (
    <SectionCard icon={UserRound} title="Identité" description="Votre identité sur cette session.">
      <dl className="grid min-w-0 grid-cols-1 gap-4 sm:grid-cols-2">
        <Field
          label="Identifiant"
          value={userId ?? "—"}
          hint={hasToken ? "vérifié (jeton signé)" : "identité par défaut (aucune connexion)"}
        />
        <Field
          label="Organisation"
          value={orgId ?? "—"}
          hint={orgId ? "vérifié (jeton signé)" : "connectez-vous pour voir l'organisation"}
        />
        <Field
          label="Rôle"
          value={roleLabel(claims?.role)}
          hint={claims?.role ? "depuis le jeton (non revérifié par /whoami)" : undefined}
        />
        <Field label="Email" value="—" hint="non exposé par l'API actuellement" />
      </dl>
    </SectionCard>
  );
}
