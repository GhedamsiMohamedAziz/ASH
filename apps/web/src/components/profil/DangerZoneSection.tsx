// Zone RGPD (§2.6): branchée sur le job `user-erasure` (§15.7 — purge messages, mémoires,
// volumes, tokens et scheduled_jobs/runs). Checked services/backend-core/app/main.py and
// services/prompt-layer/app/main.py: `erase_user` exists as a pure function
// (services/prompt-layer/app/erasure.py) but no HTTP route calls it from either service, so there
// is nothing for the web app to wire yet. The confirm dialog (type-to-confirm) is fully real and
// keyboard-accessible; the terminal action deliberately does NOT call any endpoint and never
// claims data was deleted — it states plainly that this will be wired to `user-erasure` once the
// route exists (ADR-017: no fabricated success).
import { useState } from "react";
import { AlertTriangle, Trash2, Info } from "lucide-react";
import { SectionCard } from "./SectionCard";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Modal } from "./Modal";
import { isConfirmMatch } from "./identity";

export function DangerZoneSection({ userId }: { userId: string | null }) {
  const [open, setOpen] = useState(false);
  const [input, setInput] = useState("");
  const [acknowledged, setAcknowledged] = useState(false);

  const expected = userId ?? "SUPPRIMER";
  const matched = isConfirmMatch(input, expected);

  const close = () => {
    setOpen(false);
    setInput("");
    setAcknowledged(false);
  };

  return (
    <SectionCard
      icon={AlertTriangle}
      title="Zone RGPD"
      description="Suppression définitive de vos données personnelles."
      accent="rose"
    >
      <p className="text-sm leading-relaxed text-muted-foreground">
        Cette action déclenchera le job <code className="rounded bg-panel-2 px-1 py-0.5 font-mono text-[11px] text-rose">user-erasure</code> (§15.7) :
        purge de vos messages, mémoires, volumes, tokens OAuth et automatisations planifiées
        (scheduled_jobs/runs). Irréversible.
      </p>
      <div>
        <Button
          variant="destructive"
          onClick={() => setOpen(true)}
          className="h-auto min-h-9 whitespace-normal py-2 text-center"
        >
          <Trash2 className="size-3.5 shrink-0" /> Supprimer mon compte et mes données
        </Button>
      </div>

      <Modal open={open} onClose={close} title="Confirmer la suppression">
        {!acknowledged ? (
          <div className="flex flex-col gap-3">
            <p className="text-sm leading-relaxed text-muted-foreground">
              Cette action est irréversible et purgera toutes vos données (messages, mémoires,
              volumes, tokens, automatisations). Pour confirmer, tapez{" "}
              <span className="font-mono text-rose">{expected}</span> ci-dessous.
            </p>
            <Input
              autoFocus
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder={expected}
              aria-label={`Tapez ${expected} pour confirmer`}
              className="border-rose/40 font-mono"
            />
            <div className="flex justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={close}>Annuler</Button>
              <Button
                variant="destructive"
                size="sm"
                disabled={!matched}
                onClick={() => setAcknowledged(true)}
              >
                <Trash2 className="size-3.5" /> Confirmer la suppression
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            <p className="flex items-start gap-2 rounded-md border border-rose/30 bg-rose/10 p-3 text-sm leading-relaxed text-foreground">
              <Info className="mt-0.5 size-4 shrink-0 text-rose" aria-hidden />
              <span>
                Cette action sera branchée sur le job <code className="font-mono">user-erasure</code> dès
                que l'endpoint sera exposé côté backend. Aucune donnée n'a été supprimée.
              </span>
            </p>
            <div className="flex justify-end">
              <Button size="sm" variant="outline" onClick={close}>Fermer</Button>
            </div>
          </div>
        )}
      </Modal>
    </SectionCard>
  );
}
