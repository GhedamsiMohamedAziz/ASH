// Shared placeholder primitive (§4.2) for routes not yet built. The 4 page agents replace their
// route's content directly in src/routes/<Name>Page.tsx — once real, that file stops importing
// this. Keep it dependency-light: no data fetching, no page-specific logic.
import { Hourglass } from "lucide-react";

export function ComingSoon({ title, description }: { title: string; description?: string }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center">
      <div className="flex size-12 items-center justify-center rounded-full border border-border bg-panel-2 text-muted-foreground">
        <Hourglass className="size-5" aria-hidden />
      </div>
      <h1 className="font-heading text-lg font-semibold tracking-tight text-foreground">{title}</h1>
      <p className="max-w-sm text-sm leading-relaxed text-muted-foreground">
        {description ?? "Cette page arrive bientôt."}
      </p>
      <span className="rounded-full border border-amber/30 bg-amber/10 px-3 py-1 font-mono text-[11px] text-amber">
        à venir
      </span>
    </div>
  );
}
