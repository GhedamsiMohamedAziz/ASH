// "Factures" (§L5.5) — a list of monthly invoices with a download affordance. No invoice
// endpoint exists anywhere in the API today: services/prompt-layer/app/billing.py computes an
// Invoice (seat + quota, overage at cost + margin, TVA, TND conversion — §30.1) but nothing in
// backend-core or prompt-layer's main.py wires it to an HTTP route or persists it, so there is
// nothing real to fetch. Rather than fabricate rows, this renders the honest empty state the spec
// asks for; the list-rendering path below is real code (not a stub) so a future page agent only
// has to point it at a real endpoint once one ships.
import { Receipt, Download } from "lucide-react";

export interface Invoice {
  id: string;
  month: string;       // "2026-06"
  totalUsd: number;
  totalTnd: number;
  downloadUrl?: string;
}

export function InvoicesCard({ invoices = [] as Invoice[] }: { invoices?: Invoice[] }) {
  return (
    <div className="flex flex-col gap-3 rounded-xl border border-border bg-card p-4">
      <div className="flex items-center gap-2 text-muted-foreground">
        <Receipt className="size-4 shrink-0 text-cyan" aria-hidden />
        <span className="text-xs font-medium uppercase tracking-wide">Factures</span>
      </div>

      {invoices.length === 0 ? (
        <div className="flex flex-col items-center gap-2 py-8 text-center">
          <div className="flex size-10 items-center justify-center rounded-full border border-border bg-panel-2 text-muted-foreground">
            <Receipt className="size-4" aria-hidden />
          </div>
          <p className="text-sm text-foreground">Aucune facture disponible</p>
          <p className="max-w-sm text-xs leading-relaxed text-muted-foreground">
            Aucun service de facturation n'est connecté pour le moment. Les factures mensuelles
            (TND, TVA locale incluse) apparaîtront ici dès qu'elles seront émises.
          </p>
        </div>
      ) : (
        <ul className="flex flex-col divide-y divide-border">
          {invoices.map((inv) => (
            <li key={inv.id} className="flex items-center justify-between gap-3 py-2.5">
              <span className="text-sm text-foreground">{inv.month}</span>
              <span className="font-mono text-sm text-muted-foreground">
                {inv.totalTnd.toFixed(2)} TND · ${inv.totalUsd.toFixed(2)}
              </span>
              <a
                href={inv.downloadUrl}
                className="inline-flex items-center gap-1.5 rounded-md border border-input px-2.5 py-1 text-xs text-foreground transition-colors hover:bg-accent"
                download
              >
                <Download className="size-3.5" aria-hidden /> Télécharger
              </a>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
