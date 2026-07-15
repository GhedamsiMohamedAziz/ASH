// Single source of truth for the 5-entry sidebar (§4.2) + router registration. Sidebar.tsx and
// router.tsx both map over ROUTES — nothing else needs to know the path list.
//
// Convention for the 4 remaining pages: the placeholder route component already exists at
// src/routes/<Name>Page.tsx (ConnecteursPage, MonAgentPage, ProfilPage, FacturationPage) and is
// already wired into ROUTES below — build the real page by editing that file's body in place.
// No router/sidebar change needed unless you're adding a genuinely new top-level route.
import type { ComponentType } from "react";
import { MessageSquare, Plug, RotateCw, UserRound, CreditCard } from "lucide-react";
import { ChatPage } from "./ChatPage.tsx";
import { ConnecteursPage } from "./ConnecteursPage.tsx";
import { MonAgentPage } from "./MonAgentPage.tsx";
import { ProfilPage } from "./ProfilPage.tsx";
import { FacturationPage } from "./FacturationPage.tsx";

export interface RouteDef {
  path: string;                                  // segment under the shell, e.g. "chat" → /chat
  label: string;                                  // sidebar label (fr, §4.2)
  icon: ComponentType<{ className?: string }>;
  element: ComponentType;
  automation?: boolean;                           // amber accent — automation-related nav entry (§4.5)
}

export const ROUTES: RouteDef[] = [
  { path: "chat", label: "Chat", icon: MessageSquare, element: ChatPage },
  { path: "connecteurs", label: "Connecteurs", icon: Plug, element: ConnecteursPage },
  { path: "mon-agent", label: "Mon agent", icon: RotateCw, element: MonAgentPage, automation: true },
  { path: "profil", label: "Profil", icon: UserRound, element: ProfilPage },
  { path: "facturation", label: "Facturation", icon: CreditCard, element: FacturationPage },
];

export const DEFAULT_ROUTE = "/chat";
