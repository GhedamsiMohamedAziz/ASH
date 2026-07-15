// Route: /profil (§2.6, §4.4): identité, canaux liés (table `identities`, §16.1), sécurité
// (mot de passe / 2FA / sessions) et la zone RGPD branchée sur le job `user-erasure` (§15.7).
//
// Identity is read from TWO real endpoints and combined (checked services/backend-core/app/main.py):
//  - GET /api/v1/me     → { user_id, connections }, always answers (dev-fallback usr_dev/org_1
//                          when no bearer token — same as every other tab).
//  - GET /api/v1/whoami → { user_id, org_id }, SIGNATURE-VERIFIED via auth-service's JWKS, but
//                          401s without a bearer (no dev fallback there, unlike /me).
// whoami wins when it answers (stronger guarantee); /me's user_id is the fallback so the page
// still shows a real identity when logged out. Role has no backing endpoint (whoami omits it) —
// read locally from the session JWT's own claims (identity.ts, same pattern as LoginControl's
// "logged in as" chip). Re-fetches on identityKey so login/logout via the top-bar control refresh
// this page the same way ChatPage/RightPanel already do.
import { useEffect, useState } from "react";
import { useShell } from "@/components/shell/AppShell";
import { tryGet } from "@/lib/api";
import { authToken } from "@/auth";
import { IdentitySection } from "@/components/profil/IdentitySection";
import { ChannelsSection } from "@/components/profil/ChannelsSection";
import { SecuritySection } from "@/components/profil/SecuritySection";
import { DangerZoneSection } from "@/components/profil/DangerZoneSection";
import { decodeSessionClaims, type SessionClaims } from "@/components/profil/identity";

interface MeResponse { user_id: string }
interface WhoamiResponse { user_id: string; org_id: string }

export function ProfilPage() {
  const { identityKey } = useShell();
  const [loading, setLoading] = useState(true);
  const [userId, setUserId] = useState<string | null>(null);
  const [orgId, setOrgId] = useState<string | null>(null);
  const [claims, setClaims] = useState<SessionClaims | null>(null);
  const hasToken = !!authToken();

  useEffect(() => {
    let stop = false;
    setLoading(true);
    setClaims(decodeSessionClaims(authToken()));
    (async () => {
      const [me, whoami] = await Promise.all([
        tryGet<MeResponse>("/me", { user_id: "" }),
        tryGet<WhoamiResponse | null>("/whoami", null),
      ]);
      if (stop) return;
      // whoami is signature-verified when it answers; /me's dev-fallback covers the logged-out case.
      setUserId(whoami?.user_id || me.user_id || null);
      setOrgId(whoami?.org_id ?? null);
      setLoading(false);
    })();
    return () => { stop = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [identityKey]);

  // A plain native-scroll container, not the shared shadcn ScrollArea: that component wraps its
  // content in a `display: table` viewport (so genuinely wide content — e.g. RightPanel's fixed
  // side-panel rows — can size itself and scroll horizontally). A responsive settings page is the
  // opposite shape: everything should wrap/shrink to the available width, never scroll sideways.
  // Native overflow-y-auto gives real vertical scrolling without that intrinsic-width quirk.
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 p-6 lg:p-8">
        <IdentitySection loading={loading} userId={userId} orgId={orgId} hasToken={hasToken} claims={claims} />
        <ChannelsSection userId={userId} />
        <SecuritySection />
        <DangerZoneSection userId={userId} />
      </div>
    </div>
  );
}
