// Minimal accessible switch used only by the approval-policy rows on /mon-agent. Not promoted to
// components/ui/ — scoped to this page per the build brief. Relies on the global
// `:focus-visible { outline: 2px solid var(--cyan) }` rule in tokens.css rather than a bespoke
// ring, so it stays visually consistent with every other interactive element in the app.
import { cn } from "@/lib/utils";

export function Toggle({ checked, onChange, disabled, label, activeClassName }: {
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
  label: string;
  activeClassName?: string; // override the "on" track colour (defaults to amber for this page)
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => !disabled && onChange(!checked)}
      className={cn(
        "relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border transition-colors",
        disabled ? "cursor-not-allowed opacity-50" : "cursor-pointer",
        checked ? (activeClassName ?? "border-amber bg-amber/70") : "border-border bg-panel-2"
      )}
    >
      <span
        aria-hidden
        className={cn(
          "inline-block size-3.5 translate-x-1 rounded-full bg-background shadow transition-transform",
          checked && "translate-x-4"
        )}
      />
    </button>
  );
}
