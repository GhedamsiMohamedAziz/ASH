// Shared section shell for the Profil page (§2.6): icon + title + description header over a
// bordered card. `accent="rose"` is reserved for the security/RGPD zones (§4.5 "rose =
// sécurité/danger") — every other section uses the neutral card chrome.
import type { ComponentType, ReactNode } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";

export function SectionCard({
  icon: Icon,
  title,
  description,
  accent = "default",
  children,
  className,
}: {
  icon: ComponentType<{ className?: string }>;
  title: string;
  description?: string;
  accent?: "default" | "rose";
  children: ReactNode;
  className?: string;
}) {
  return (
    <Card className={cn("w-full min-w-0", accent === "rose" && "border-rose/30 bg-rose/[0.03]", className)}>
      <CardHeader className="gap-1.5 border-b p-4">
        <CardTitle className="flex items-center gap-2 font-heading text-sm tracking-tight">
          <Icon className={cn("size-4", accent === "rose" ? "text-rose" : "text-cyan")} aria-hidden />
          {title}
        </CardTitle>
        {description && <p className="text-xs leading-relaxed text-muted-foreground">{description}</p>}
      </CardHeader>
      <CardContent className="flex flex-col gap-4 p-4">{children}</CardContent>
    </Card>
  );
}
