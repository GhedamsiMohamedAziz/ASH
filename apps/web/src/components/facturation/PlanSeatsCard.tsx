// "Plan & sièges" (§L5.5 / §4.4). GET /api/v1/me (services/backend-core/app/main.py) returns
// exactly {user_id, connections[]} — there is no plan name, price, or seat count on that
// response, and no org/plan endpoint exists anywhere in backend-core or prompt-layer today
// (services/prompt-layer/app/billing.py has Plan/seat_price_usd as a Python dataclass, but it is
// never wired to an HTTP route). Per ADR-017 this card shows the identity that DID come back —
// never a guessed plan/price — and says plainly why the rest reads "—".
import { useEffect, useState } from "react";
import { Layers } from "lucide-react";
import { tryGet } from "@/lib/api";
import { StatCard, StatRow } from "./StatCard";

interface Me { user_id?: string }

export function PlanSeatsCard({ identityKey }: { identityKey: number }) {
  const [me, setMe] = useState<Me | null>(null);

  useEffect(() => {
    let stop = false;
    (async () => {
      const m = await tryGet<Me | null>("/me", null);
      if (!stop) setMe(m);
    })();
    return () => { stop = true; };
  }, [identityKey]);

  return (
    <StatCard icon={Layers} label="Plan & sièges">
      <div className="flex flex-col gap-2">
        <StatRow label="Plan" value="—" muted />
        <StatRow label="Sièges actifs" value="—" muted />
      </div>
      <p className="text-xs leading-relaxed text-muted-foreground">
        Non exposé par l'API pour le moment{me?.user_id ? ` (connecté en tant que ${me.user_id})` : ""} —
        aucune valeur n'est inventée ici.
      </p>
    </StatCard>
  );
}
