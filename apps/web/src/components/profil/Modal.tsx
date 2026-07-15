// Minimal accessible dialog, scoped to the Profil page's RGPD confirm flow — no @radix-ui/react-dialog
// in this app's dependencies yet, and pulling one in for a single confirm dialog is out of scope
// here, so this is a small hand-rolled `role="dialog"` primitive: focus-trapped-enough (autofocus +
// Escape + backdrop click), keyboard accessible, aria-labelled by its title.
import { useEffect, useRef, type ReactNode } from "react";
import { X } from "lucide-react";

export function Modal({
  open,
  onClose,
  title,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
}) {
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    // Focus the panel itself so Tab immediately reaches its first interactive control.
    panelRef.current?.focus();
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="profil-modal-title"
        tabIndex={-1}
        className="flex w-full max-w-md flex-col gap-4 rounded-xl border border-rose/30 bg-panel p-5 shadow-lg outline-none"
      >
        <div className="flex items-center justify-between gap-2">
          <h2 id="profil-modal-title" className="font-heading text-sm font-semibold tracking-tight text-foreground">
            {title}
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Fermer"
            className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-panel-2 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <X className="size-4" />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
