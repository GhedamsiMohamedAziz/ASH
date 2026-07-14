# Architecture Complète — Plateforme d'Agents IA Multi-Utilisateurs
### Teams / Slack / Web → Orchestrateur → Sandboxes OpenCode → MCP Gateway → Automatisations Trigger.dev

**Version :** 4.2 — Juillet 2026
**Statut :** Blueprint d'implémentation complet — technique + produit + business

**v4.2 — Comblement des manques critiques :** §30 Commercialisation & Protection (pricing & packaging, responsabilité juridique, support & SLA contractuels, onboarding d'une organisation) ; §15.8 Automatisations événementielles (webhooks entrants) ; renforts sécurité §17 (réponse à incident/breach, antivirus des pièces jointes, chiffrement at-rest des volumes) ; registre des prompts et boucle feedback→évals (§20) ; localisation (§7) ; checklist go-live étendue (Annexe D).

**v4.1 — Visualisations :** 10 diagrammes Mermaid rendus ajoutés (vue d'ensemble, pipeline Prompt Layer, machines à états sandbox & jobs, séquences de bout en bout, répartition des coûts, coûts par tour, courbes de trésorerie, Gantt de la roadmap). Les diagrammes ASCII d'origine sont conservés pour les contextes texte brut.

**v4.0 — Restructuration éditoriale (sans perte de contenu) :** le document est réorganisé en 6 parties logiques + annexes groupées (techniques / business) ; les sections sont renumérotées et **toutes les références croisées ont été réécrites automatiquement**. L'intégralité du contenu v1.0→v3.5 est conservée ; l'historique des versions et la table de correspondance ancienne → nouvelle numérotation sont en **Annexe I**.


---


## Table des matières


**PARTIE I — VISION & PRODUIT**
1. [Résumé exécutif](#1-résumé-exécutif)
2. [Catalogue des capacités de l'agent](#2-catalogue-des-capacités-de-lagent)
3. [Modes de déploiement : Personnel vs Équipe](#3-modes-de-déploiement-personnel-vs-équipe)
4. [Spécification de l'UI Web](#4-spécification-de-lui-web)

**PARTIE II — FONDATIONS : ENTRÉE & CONTRÔLE**
5. [Principes de conception](#5-principes-de-conception)
6. [Diagramme d'architecture global](#6-diagramme-darchitecture-global)
7. [Couche Clients](#7-couche-clients)
8. [API Gateway & Backend Core](#8-api-gateway-backend-core)
9. [Prompt Layer](#9-prompt-layer)

**PARTIE III — EXÉCUTION : AGENTS, OUTILS & AUTOMATISATIONS**
10. [Agent Orchestrator](#10-agent-orchestrator)
11. [Sandboxes Docker](#11-sandboxes-docker)
12. [OpenCode Agent](#12-opencode-agent)
13. [MCP Gateway](#13-mcp-gateway)
14. [Serveurs MCP](#14-serveurs-mcp)
15. [Automatisations & Crons — Trigger.dev](#15-automatisations-crons-triggerdev)

**PARTIE IV — DONNÉES, SÉCURITÉ & FLUX**
16. [Données & Persistance](#16-données-persistance)
17. [Sécurité](#17-sécurité)
18. [Flux de bout en bout](#18-flux-de-bout-en-bout)

**PARTIE V — QUALITÉ & EXPLOITATION**
19. [Observabilité](#19-observabilité)
20. [Stratégie de tests & évals](#20-stratégie-de-tests-évals)
21. [Taxonomie d'erreurs & contrats](#21-taxonomie-derreurs-contrats)
22. [Infrastructure & Déploiement](#22-infrastructure-déploiement)
23. [Scalabilité, HA & DR](#23-scalabilité-ha-dr)
24. [Console Admin & Exploitation (ops solo)](#24-console-admin-exploitation-ops-solo)

**PARTIE VI — DÉCISIONS & TRAJECTOIRE**
25. [Modèle de coûts & capacité](#25-modèle-de-coûts-capacité)
26. [Stack technique récapitulative](#26-stack-technique-récapitulative)
27. [Structure du monorepo](#27-structure-du-monorepo)
28. [Architecture Decision Records](#28-architecture-decision-records)
29. [Roadmap d'implémentation](#29-roadmap-dimplémentation)
30. [Commercialisation & Protection](#30-commercialisation-protection)

**ANNEXES TECHNIQUES**
- [Annexe A — SLO cibles](#annexe-a-slo-cibles)
- [Annexe B — Glossaire](#annexe-b-glossaire)
- [Annexe C — Modèle de consommation tokens (Sonnet 4.6)](#annexe-c-modèle-de-consommation-tokens-sonnet-46)
- [Annexe D — Checklist go-live production](#annexe-d-checklist-go-live-production)
- [Annexe H — Benchmark & politique de sélection des modèles](#annexe-h-benchmark-politique-de-sélection-des-modèles)

**ANNEXES BUSINESS**
- [Annexe E — Marché & valorisation (Tunisie)](#annexe-e-marché-valorisation-tunisie)
- [Annexe F — Plan financier : les 6 premiers mois](#annexe-f-plan-financier-les-6-premiers-mois)
- [Annexe G — Paiement des fournisseurs LLM/cloud depuis la Tunisie](#annexe-g-paiement-des-fournisseurs-llmcloud-depuis-la-tunisie)
- [Annexe I — Historique des versions & correspondance](#annexe-i-historique-des-versions-correspondance)



---

# PARTIE I — VISION & PRODUIT

*Ce que la plateforme est, ce que l'agent sait faire, comment elle se déploie et à quoi elle ressemble.*

---

## 1. Résumé exécutif

La plateforme permet à chaque utilisateur d'une organisation d'interagir avec un **agent IA personnel et isolé** depuis Microsoft Teams, Slack ou une Web App. Chaque agent tourne dans un **sandbox Docker dédié** exécutant **OpenCode**, et accède aux outils de l'entreprise (GitHub, Teams, navigateur, bases de données, Notion, Outlook, SharePoint…) via une **MCP Gateway centralisée** qui applique authentification par utilisateur, permissions et audit.

**Nouveauté v2 :** les agents ne sont plus seulement réactifs. Grâce au **Scheduler MCP** adossé à **Trigger.dev**, un utilisateur peut demander à son agent : *« Chaque lundi à 9h, résume mes PRs GitHub en attente et envoie-moi le récap sur Teams »* — l'agent crée lui-même le cron, la plateforme le ré-exécute de façon durable, sécurisée et auditée, en ré-évaluant les permissions à chaque déclenchement.

**Propriétés clés du système :**

| Propriété | Réalisation |
|---|---|
| Isolation par utilisateur | 1 sandbox Docker (rootless + gVisor) par utilisateur actif |
| Identité propagée de bout en bout | JWT interne signé, du canal d'entrée jusqu'au serveur MCP |
| Contrôle centralisé | Prompt Layer (guardrails, permissions, routing) avant tout agent |
| Zéro secret dans les sandboxes | Tokens OAuth stockés dans un Vault, injectés uniquement côté MCP Gateway |
| Multi-canal, une seule logique | Adaptateurs Teams/Slack/Web normalisant vers un format d'événement unique |
| **Agents proactifs** | **Crons créés par l'agent via Scheduler MCP, exécutés par Trigger.dev, permissions ré-évaluées à chaque run** |
| Auditabilité totale | Chaque appel d'outil et chaque run planifié journalisés (qui, quoi, quand, résultat) |

Le catalogue complet de ce que l'agent sait faire — et de ce qu'il ne peut pas faire par conception — est en **§2**. La plateforme supporte deux modes de déploiement — agent **personnel** par utilisateur (le modèle détaillé dans ce document) et agent **d'équipe partagé** sur les credentials de l'organisation (MVP recommandé) — décrits en **§3**.

---

## 2. Catalogue des capacités de l'agent

La section "produit" du blueprint : ce que l'agent d'un utilisateur sait faire, en langage client. Six familles de capacités — la vraie puissance venant de leur **enchaînement** dans une même tâche.

### 2.1 Les six familles

| # | Famille | Ce que l'agent fait | Fondations |
|---|---|---|---|
| 1 | **Converser & raisonner** | Répond depuis Teams, Slack ou le Web (mentions, DM, slash commands) ; classifie simple/complexe, propose un plan 3-7 étapes, l'exécute en le révisant, s'auto-escalade s'il découvre un besoin d'outils. Se souvient : préférences, procédures apprises, corrections passées, conversations antérieures, qui fait quoi et depuis quand | §7, §9.1-6.2 |
| 2 | **Code & ingénierie** | Cherche et lit du code, crée des branches, committe, ouvre et revoit des PRs, crée et trie des issues, merge (sous approbation). Ex. bout en bout : *"déploie fix/login sur staging"* → CI vérifiée → PR → approbation → merge → notification équipe | GitHub MCP (§14), Sentry en vague 1 (§14.2) |
| 3 | **Bureautique & communication** | Outlook : lire, chercher, résumer, envoyer (sous approbation). Teams/Slack : lire des canaux, poster des récaps. Calendrier : créer des événements, préparer une réunion en croisant mails et documents. SharePoint/OneDrive : chercher, lire, livrer. Notion : comptes-rendus, specs, wikis | M365, Slack, Notion MCP (§14) |
| 4 | **Chercher, lire, extraire** | Web headless : lire des pages, cliquer, remplir des formulaires, télécharger, capturer — veille, vérification, extraction structurée. Bases internes : schémas, SELECT plafonnés, APIs internes. Ex. : *"combien de clients ont churné en juin, par région ?"* → requête → analyse → réponse chiffrée | Browser + Database MCP (§14) |
| 5 | **Produire dans son atelier** | Exécute Python/Node/bash/git/builds dans son sandbox : analyser un CSV, générer un graphique, écrire un script, transformer des fichiers, produire un rapport. Workspace **persistant** : repos, notes de projet et fichiers retrouvés d'une session à l'autre | Sandbox (§11), volume (§11.3) |
| 6 | **Travailler seul, en planifié** | Crée ses automatisations en langage naturel (*"chaque lundi 9h, résume mes PRs"* → cron proposé → approbation → ça tourne). Cas types : brief mails du matin, veille d'erreurs toutes les 4 h, digest hebdo, rapport mensuel — livrés en DM, email ou webhook. Gère ses jobs (liste, pause, run_now, historique) et se souvient d'un run à l'autre | Scheduler MCP + Trigger.dev (§14-15) |

### 2.2 La combinatoire — le vrai produit

*"Regarde les erreurs Sentry de la nuit ; si la nouvelle vient du déploiement d'hier, ouvre une issue GitHub avec la stack trace, assigne l'on-call, préviens #dev — et fais-moi ça tous les matins."* Une seule phrase : cinq connecteurs traversés plus le scheduler, avec les approbations et l'audit à chaque étape. C'est l'enchaînement, pas la capacité unitaire, qui différencie la plateforme d'un chatbot outillé.

### 2.3 Comportements de sécurité permanents

Quelle que soit la tâche, l'agent : demande une **approbation** avant toute action sensible (merge, envoi de mail, écriture) ; respecte un **budget** par tour et par run ; n'agit qu'avec **les droits de son utilisateur** ; masque les secrets dans ses sorties (DLP) ; **journalise** chaque action ; bascule en DM quand une réponse en canal public toucherait des données personnelles ; et confirme les horaires avant de créer un cron.

### 2.4 Impossibilités par conception

Argument de vente autant que limite — chacune est structurelle, pas une consigne :

| L'agent ne peut pas… | Parce que |
|---|---|
| Sortir de son sandbox | Egress réseau limité à la MCP Gateway (§11.2, §17.4) |
| Toucher aux données ou jobs d'un autre utilisateur | Isolation 1 sandbox = 1 user ; scope imposé au `sub` du TASK JWT partout (§13, §14) |
| Détenir un secret ou un token | Zéro secret dans le sandbox ; injection côté Gateway uniquement (§13.2) |
| Écrire en base sans approbation | `tool_policies` fail-closed (§9.4) |
| Dépasser les droits de son utilisateur — même des mois après la création d'un cron | Permissions ré-évaluées **au feu** de chaque run (§15.6, principe n°7) |
| Mémoriser des informations privées sur des tiers | Interdits d'écriture mémoire, testés en adversarial (§9.1.3, §20.2) |
| Dépenser sans limite | Budgets par tour, par run, par mois, par org + kill-switch (§10.2, §15.6) |

**En une phrase** : un collègue numérique qui lit, écrit, code, cherche, analyse et livre dans tous les outils de l'entreprise, qui apprend de son utilisateur, qui travaille aussi quand il dort — et qui demande la permission avant tout ce qui compte.

---

## 3. Modes de déploiement : Personnel vs Équipe

Le blueprint décrit le **Mode A (agent personnel)** : un agent, un sandbox et des tokens OAuth par utilisateur. Le **Mode B (agent d'équipe partagé)** couvre le cas d'un agent unique branché sur les ressources de la société (GitHub de l'org, bases, SharePoint) et utilisé par toute l'équipe depuis Slack/Teams. C'est le **MVP recommandé** : pas de parcours OAuth par utilisateur, valeur immédiate, mémoire commune. Ce n'est **pas une refonte mais une configuration** — les deltas par section sont en §3.6.

### 3.1 Comparaison

| | Mode A — Personnel | Mode B — Équipe partagé |
|---|---|---|
| Credentials outils | Tokens OAuth de chaque utilisateur | **Comptes de service org** : GitHub App (token d'installation scopé aux repos), compte DB read-only, permissions applicatives SharePoint — une entrée Vault par org et par connecteur |
| Identité du demandeur | Détermine tout | **Conservée pour 3 usages : autorisation, approbation, audit** (§3.2) |
| Sandbox | 1 par utilisateur | Pool partagé, **git comme état de vérité** (clone/pull → travail → push) — parallélisme sans conflit de fichiers |
| Mémoire | Privée par utilisateur | **Organisationnelle par défaut** : corrections et notes procédurales profitent à toute l'équipe (le type 7 de §9.1 devient principal, sans circuit de validation — tout le contexte est déjà partagé) |
| Données personnelles (mails, DM, OBO) | Oui | **Exclues** — un agent partagé ne lit pas "mes mails" ; connecteurs délégués désactivés |
| Cible produit | Gouvernance fine, grands comptes | MVP, équipes, déploiement en jours |

### 3.2 La règle d'or : credentials partagés ≠ identité anonyme

Chaque message Slack/Teams porte l'identité de son auteur (`event.user`) — elle est résolue via `identities` exactement comme en Mode A, et continue de servir à trois choses :

1. **Autorisation** — `tool_policies` s'applique au **rôle du demandeur**, pas au bot : un `member` fait lire du code et créer des PRs ; `merge_pr` et `database.write` restent restreints. Sans cela : *confused deputy* — n'importe quel membre du workspace pilote un bot qui a les clés de l'org. Avec des credentials org-wide, les approbations deviennent **plus** importantes (le rayon d'impact d'une injection de prompt est toute la société), pas moins.
2. **Approbation** — voir §3.3 : l'approbateur n'est plus forcément le demandeur.
3. **Audit** — `actor: agent-org`, **`on_behalf_of: usr_mehdi`** sur chaque ligne ; et comme les commits GitHub apparaissent au nom du bot, l'agent ajoute systématiquement `Co-authored-by` + "Requested by @mehdi" dans les PRs — sinon l'audit interne est bon mais l'historique Git est aveugle.

Le TASK JWT porte `sub: agent-org@<org_id>` + claim **`on_behalf_of`** ; la Gateway applique la politique sur `on_behalf_of` et injecte le credential org depuis Vault.

### 3.3 Approbateurs désignés

En mode partagé, Mehdi qui approuve sa propre demande de merge avec les droits de l'org ne protège rien. La colonne `tool_policies.approver_group` désigne qui reçoit la carte Approuver/Refuser : `github.merge_pr → require_approval(approver_group: 'tech-leads')` — la carte part dans le canal des tech leads (ou en DM aux membres du groupe), pas chez le demandeur. `NULL` = comportement Mode A (le demandeur approuve). Toute approbation journalise demandeur **et** approbateur.

### 3.4 Garde-fous spécifiques au Mode B

- **Quotas par demandeur** malgré le budget commun : rate limiting + part de budget par utilisateur, sinon un enthousiaste consomme le budget de l'équipe.
- **Aucun connecteur délégué personnel** (Outlook OBO, DM) : exclus par configuration ; le mode hybride (A+B) reste possible plus tard — agent d'équipe pour les ressources org, agent personnel pour les données individuelles.
- **Mémoire** : les interdits d'écriture §9.1.3 s'appliquent inchangés ; s'y ajoute l'interdiction de mémoriser des attributions individuelles sensibles ("X est lent sur les reviews").
- **Thread multi-utilisateurs** : l'historique du thread est un contexte légitime (déjà visible de tous dans Slack) ; l'identité d'exécution reste **l'auteur du message courant**.

### 3.5 Ce qui se simplifie

Plus de flow OAuth ni de refresh par utilisateur (une entrée Vault org/connecteur, le job `oauth-refresh-sweep` ne gère que les comptes de service) ; la page Connexions (§4.4) devient une page admin d'org ; l'onboarding utilisateur se réduit à la liaison d'identité Slack/Teams.

### 3.6 Deltas par section

| Section | Delta en Mode B |
|---|---|
| §9.1 Memory | Scope `org` par défaut ; types 2-5 partagés ; page "Mémoires" visible de l'équipe (édition réservée aux rôles élevés) |
| §9.4 Permissions | Évaluées sur `on_behalf_of` ; `approver_group` actif |
| §10 Orchestrator | Pool de sandboxes banalisés au lieu du mapping 1:1 ; volume remplacé par clones git éphémères + cache |
| §11 Sandbox | `/workspace` éphémère par tâche ; notes procédurales dans un repo git dédié (`org-agent-notes`) versionné |
| §13 Gateway | Entrée Vault scopée org ; TASK JWT `sub=agent-org` + `on_behalf_of` |
| §14 Connecteurs | GitHub App installation token ; M365 en permissions applicatives restreintes (jamais OBO) ; Slack bot token |
| §15 Automatisations | Les crons appartiennent à l'org (créateur tracé) ; delivery vers canaux d'équipe ; preflight vérifie le statut du **créateur** et bascule la propriété à l'offboarding au lieu de pauser |
| §24 Admin | Vue unique des credentials org ; rotation simplifiée |
| §2.4 Impossibilités | "Toucher aux données d'un autre utilisateur" devient "agir au-delà du rôle du demandeur" — garanti par `on_behalf_of` |

**Positionnement produit** : vendre les deux sur la même plateforme — **Mode Équipe** (MVP, simple, savoir commun) et **Mode Personnel** (gouvernance fine et données individuelles, l'offre grands comptes). La migration B → A est un enrichissement, pas une rupture : les identités et l'audit sont déjà en place.

---

## 4. Spécification de l'UI Web

Prototype React navigable livré séparément (`plateforme-ui.jsx`) ; cette section fixe le contrat produit. Nom de produit provisoire : **Axone**.

### 4.1 Parcours d'authentification

| Écran | Comportement | Sécurité |
|---|---|---|
| **Login** | Email + mot de passe, ou SSO Entra ID / Slack (mêmes providers que la table `identities`) | Rate limiting dédié ; message d'erreur identique compte inexistant / mauvais mot de passe |
| **Register** | Nom, email pro, **organisation** (multi-tenant dès l'inscription), mot de passe ≥ 12 car. | Vérification email obligatoire avant activation |
| **Mot de passe oublié** | Réponse **neutre** ("si un compte existe, un lien a été envoyé"), lien valable 15 min, usage unique | Ne révèle jamais l'existence d'un compte |
| **OTP** | 6 cases auto-avance, backspace intelligent, expiration 10 min, renvoi throttlé | Étape systématique après login/register (email OTP par défaut, TOTP en option) |

### 4.2 Coquille applicative

Sidebar fixe à 5 entrées (Chat, Connecteurs, Mon agent, Profil, Facturation) + **jauge de budget mensuel en permanence** — la philosophie de maîtrise des coûts rendue visible à l'utilisateur. Responsive : sidebar réduite à 64 px et liste de conversations repliée sous 860 px ; `prefers-reduced-motion` respecté.

### 4.3 Chat — mapping du contrat `AgentEvent` vers l'UI

| Événement (§7.4) | Rendu |
|---|---|
| `agent.text.delta` | Bulle agent en streaming token par token |
| `agent.tool.call` / `agent.tool.result` | Ligne monospace compacte `✓ sentry.list_issues — résumé` (cyan = outil, vert/rose = statut) |
| `agent.approval.needed` | **Carte ambre** avec l'outil, le résumé lisible des arguments et les boutons Approuver / Refuser |
| `agent.cron.created` | Chip ⟳ ambre + horaire humain + prochaine exécution |
| `agent.escalated` | Indicateur discret "je regarde dans <outil>, un instant ⏳" |
| `agent.done` | Pied de message : coût du tour, durée |
| `agent.error` | Message d'erreur de la taxonomie §21, formulé utilisateur |

Liste de conversations : celles issues de crons sont marquées ⟳ (ambre) avec leur horaire. Composer : rappel du budget du tour et du principe d'approbation sous le champ de saisie.

### 4.4 Autres pages

- **Connecteurs** : cartes avec statut (Connecté / Non connecté), **type d'identité affiché** (OAuth utilisateur, permissions déléguées, token par projet) et section séparée "Inclus par votre organisation" (Browser, Database, Scheduler) — la distinction connecteurs personnels vs plateforme (§13.2/§14) rendue explicite.
- **Mon agent** : sélection du profil (dev / généraliste / data / ops), toggles d'approbation dont certains **verrouillés par l'organisation** (rendu de la matrice `tool_policies`), liste des automatisations avec pause/reprise, coût par run, quota affiché (n/20).
- **Profil** : identité, canaux liés (Teams / Slack / Web = table `identities`), sécurité (mot de passe, 2FA, sessions actives), **zone RGPD** branchée sur le job `user-erasure` (§15.7).
- **Mémoires** (v3.2) : liste des mémoires de l'agent groupées par type (faits, préférences, procédures, corrections) avec recherche, édition et suppression unitaire ou en masse — la transparence exigée par §9.1.3, et le pendant produit de `memory.forget`.
- **Facturation** : plan et sièges, consommation vs plafond, **répartition interactif / automatisations** (`usage_daily.origin`), graphe 14 jours avec hit rate de cache affiché, factures (TND, TVA locale) téléchargeables.

### 4.5 Design tokens

Identité "salle de contrôle", cohérente avec la carte système : fond `#0A0F1C`, panneaux `#101A2E`, texte `#E8EEF9`. **Sémantique des couleurs stricte** : cyan `#56C8EA` = action/flux, **ambre `#F5B84B` = tout ce qui touche aux automatisations**, rose `#F06A8A` = sécurité/danger, vert `#5EE6A0` = succès/connecté. Typographies : Space Grotesk (titres/UI), Inter (corps), IBM Plex Mono (labels techniques, outils, données). Focus visible au clavier sur tous les éléments interactifs.

---

# PARTIE II — FONDATIONS : ENTRÉE & CONTRÔLE

*Des principes de conception au Prompt Layer : tout ce qui se passe avant l'agent.*

---

## 5. Principes de conception

1. **Identity-first** — L'identité utilisateur (`user_id` canonique) est résolue dès l'entrée (SSO Entra ID / Slack OIDC) et voyage dans un JWT signé à travers toutes les couches. Aucun composant ne fait confiance à un identifiant non signé.
2. **Least privilege partout** — Le sandbox n'a **aucun accès réseau sortant** sauf vers la MCP Gateway. Les tokens tiers (GitHub, Graph API…) ne quittent jamais la Gateway.
3. **Stateless au centre, stateful aux extrémités** — API Gateway, Prompt Layer et MCP Gateway sont stateless (scalables horizontalement). L'état vit dans Postgres/Redis, dans Trigger.dev et dans les volumes de sandbox.
4. **Le sandbox est jetable** — Un sandbox peut être tué à tout moment ; le workspace utilisateur est persisté sur volume, la conversation dans Postgres. Redémarrage = reprise transparente.
5. **Fail-closed** — Si le Prompt Layer, le service de permissions ou la Gateway est indisponible, la requête est refusée (jamais de bypass).
6. **Un événement, un contrat** — Tous les canaux (y compris le scheduler) convergent vers un schéma d'événement unique (`InboundMessage`, versionné) et un schéma de sortie unique (`AgentEvent`), streamé.
7. **Les automatisations sont des citoyens de première classe, jamais des privilèges figés** — Un cron n'embarque **aucun token ni permission**. À chaque déclenchement, la plateforme ré-évalue permissions, guardrails et budgets *au moment de l'exécution* : un utilisateur qui perd un droit voit ses automatisations dégradées ou mises en pause, jamais l'inverse.
8. **Idempotence par défaut** — Toute écriture (API, outil MCP, run planifié) porte une clé d'idempotence ; un retry ne produit jamais de doublon.

---

## 6. Diagramme d'architecture global

Vue d'ensemble (rendu) — le diagramme ASCII détaillé, avec tous les composants, suit :

```mermaid
flowchart TB
    U["Utilisateurs"] --> TE["Teams"]
    U --> SL["Slack"]
    U --> WE["Web App"]
    TE --> AD["Channel Adapters"]
    SL --> AD
    WE --> AD
    AD --> GW["API Gateway"] --> BC["Backend Core"]
    BC --> PL["Prompt Layer<br/>mémoire · plan · guardrails · permissions · routing"]
    PL --> OR["Agent Orchestrator"]
    OR --> SB["Sandboxes OpenCode<br/>1 par utilisateur · gVisor · zéro secret"]
    SB -->|"mTLS + TASK JWT<br/>(seule sortie réseau)"| MG["MCP GATEWAY<br/>AuthZ · secrets · DLP · audit"]
    MG --> SRV["GitHub · M365 · Slack · Browser<br/>Database · Notion · Memory MCP"]
    MG --> SCH["Scheduler MCP"]
    SCH --> AS["Automation Service"] --> TD["Trigger.dev v4<br/>(self-hosted)"]
    TD -.->|"fire cron → ré-injection<br/>dans le pipeline normal"| BC
    VA[("Vault<br/>tokens OAuth")] -.-> MG
    SB -.-> LP["LLM Proxy → Claude Sonnet 4.6"]
    classDef amber fill:#4a3a10,stroke:#F5B84B,color:#F5D89A
    classDef rose fill:#2b1420,stroke:#F06A8A,color:#F7B8C8
    class SCH,AS,TD amber
    class SB,VA rose
```

```
                                    UTILISATEURS
                                         │
              ┌──────────────────────────┼──────────────────────────┐
              ▼                          ▼                          ▼
      ┌──────────────┐          ┌──────────────┐           ┌──────────────┐
      │ MS Teams     │          │ Slack        │           │ Web App      │
      │ (Bot Fwk)    │          │ (Bolt App)   │           │ React + WS   │
      └──────┬───────┘          └──────┬───────┘           └──────┬───────┘
             │ Activity                │ Events API               │ WebSocket/SSE
             ▼                         ▼                          ▼
      ┌─────────────────────────────────────────────────────────────────┐
      │                    CHANNEL ADAPTERS (stateless)                 │
      │   teams-adapter        slack-adapter          web-adapter       │
      │   → normalise en InboundMessage + résolution identité SSO       │
      └────────────────────────────────┬────────────────────────────────┘
                                       ▼
      ┌─────────────────────────────────────────────────────────────────┐
      │                 API GATEWAY  (Kong / Envoy / Traefik)           │
      │   AuthN (JWT), rate limiting, WAF, TLS termination, routing     │
      └────────────────────────────────┬────────────────────────────────┘
                                       ▼
      ┌─────────────────────────────────────────────────────────────────┐
      │                    BACKEND CORE  (FastAPI)                      │◄────┐
      │  conversations / users / files / automations / admin API        │     │
      └────────────────────────────────┬────────────────────────────────┘     │
                                       ▼                                      │
      ┌─────────────────────────────────────────────────────────────────┐     │
      │                        PROMPT LAYER                             │     │
      │  ┌──────────┐ ┌──────────┐ ┌────────────┐ ┌─────────┐ ┌───────┐ │     │
      │  │ Memory   │ │ Planning │ │ Guardrails │ │ Perms   │ │Routing│ │     │
      │  └──────────┘ └──────────┘ └────────────┘ └─────────┘ └───────┘ │     │
      └────────────────────────────────┬────────────────────────────────┘     │
                                       ▼                                      │
      ┌─────────────────────────────────────────────────────────────────┐     │
      │                     AGENT ORCHESTRATOR                          │     │
      └───────────┬───────────────────┬───────────────────┬─────────────┘     │
                  ▼                   ▼                   ▼                   │
        ┌─────────────────┐ ┌─────────────────┐ ┌─────────────────┐           │
        │ SANDBOX  User A │ │ SANDBOX  User B │ │ SANDBOX  User C │           │
        │ OpenCode Agent  │ │ OpenCode Agent  │ │ OpenCode Agent  │           │
        │  └ MCP Client   │ │  └ MCP Client   │ │  └ MCP Client   │           │
        └────────┬────────┘ └────────┬────────┘ └────────┬────────┘           │
                 │  mTLS + JWT (seule sortie réseau autorisée)                │
                 └───────────────────┼───────────────────┘                    │
                                     ▼                                        │
      ┌─────────────────────────────────────────────────────────────────┐     │
      │                        MCP GATEWAY                              │     │
      │  AuthZ par outil, injection tokens (Vault), quotas, audit, DLP  │     │
      └──┬─────────┬─────────┬─────────┬─────────┬─────────┬────────────┘     │
         ▼         ▼         ▼         ▼         ▼         ▼                  │
      ┌───────┐ ┌───────┐ ┌───────┐ ┌───────┐ ┌───────┐ ┌───────────────┐     │
      │GitHub │ │ M365  │ │Browser│ │  DB   │ │Notion/│ │ SCHEDULER MCP │     │
      │  MCP  │ │  MCP  │ │  MCP  │ │  MCP  │ │Slack  │ │ (crons agent) │     │
      └───┬───┘ └───┬───┘ └───┬───┘ └───┬───┘ │ MCP   │ └───────┬───────┘     │
          ▼         ▼         ▼         ▼     └───────┘         ▼             │
      GitHub    MS Graph  Playwright  APIs             ┌────────────────────┐ │
       API      (Teams,   headless    internes         │ AUTOMATION SERVICE │ │
                Outlook,                               │  (API jobs + defs) │ │
                SharePoint)                            └─────────┬──────────┘ │
                                                                 ▼            │
                                                    ┌────────────────────────┐│
                                                    │  TRIGGER.DEV v4 (self- ││
                                                    │  hosted): schedules,   ││
                                                    │  retries, dashboard    ││
                                                    │  + jobs internes       ││
                                                    └───────────┬────────────┘│
                                                                │ fire cron   │
                                                                └─────────────┘
                                                     (POST /internal/scheduled-runs
                                                      → ré-entre dans le pipeline
                                                      normal comme un message)
```

**Lecture du diagramme :** la boucle en bas à droite est la clé de la v2. Trigger.dev ne parle **jamais** directement aux sandboxes ni aux serveurs MCP : quand un cron se déclenche, il ré-injecte simplement un `InboundMessage` (canal `scheduler`) dans le Backend Core. Le run planifié traverse donc **exactement le même pipeline** qu'un message humain — mêmes guardrails, mêmes permissions (ré-évaluées), même audit.

---

## 7. Couche Clients

### 7.1 Microsoft Teams Bot

- **Techno :** Bot Framework SDK v4 (Node.js ou Python) + Azure Bot Service.
- **Enregistrement :** App Registration Entra ID multi-tenant ou single-tenant, manifest Teams (bot + message extension optionnelle).
- **Identité :** l'`aadObjectId` de l'activité Teams est mappé vers le `user_id` canonique via la table `identities`. Premier contact → flow de liaison de compte (SSO silencieux via `TeamsSSOTokenExchange`).
- **Sécurité webhook entrant :** validation du JWT Bot Framework sur chaque activité (métadonnées OpenID de connector, vérification `aud` = App ID du bot, `iss` Bot Framework, tolérance d'horloge 5 min) ; rejet fail-closed.
- **UX :**
  - Réponses en streaming simulé : message initial "⏳ …" puis `updateActivity` toutes les ~1,5 s.
  - Adaptive Cards pour : validation d'actions sensibles (Approuver/Refuser), **approbation de création de crons** (récap horaire + prompt + budget), diffs de code, résultats structurés.
  - Notifications proactives : les résultats de runs planifiés arrivent en message proactif (conversation 1:1 bot↔user, `conversationReference` stockée en base).
  - Support des fichiers entrants (upload → stockage S3 → référence dans `InboundMessage.attachments`).

### 7.2 Slack Bot

- **Techno :** Bolt for JavaScript (Socket Mode en dev, HTTP + Events API en prod).
- **Scopes :** `app_mentions:read`, `chat:write`, `im:history`, `im:write`, `files:read`, `files:write`, `commands`.
- **Sécurité webhook entrant :** vérification de signature Slack (`X-Slack-Signature` HMAC-SHA256 avec le signing secret + timestamp, fenêtre anti-rejeu 5 min), déduplication des retries Slack via `X-Slack-Retry-Num` + event_id en Redis.
- **Identité :** `slack_user_id` + `team_id` → table `identities` (liaison via OpenID Connect Slack au premier usage).
- **UX :** Block Kit pour les cartes d'approbation (dont crons), `chat.update` pour le pseudo-streaming, slash commands (`/agent new`, `/agent status`, `/agent stop`, **`/agent crons`** — liste et gestion rapide des automatisations).

#### 7.2.1 Gestion des mentions : tâche simple vs tâche complexe (v2.2)

**Temps 1 — ACK instantané (< 3 s, contrainte Slack).** Slack ré-émet l'événement si la réponse HTTP dépasse 3 s (d'où la déduplication `event_id`). Le slack-adapter répond donc immédiatement : HTTP 200 + réaction 👀 sur le message + publication de l'`InboundMessage` sur le bus. L'utilisateur a un signal de prise en compte avant même la classification.

**Temps 2 — Classification rapide (Prompt Layer, ~250 ms).** Un modèle léger (jamais le frontier) classe la mention sur des signaux simples : verbes d'action vs question, besoin probable d'outils, pièces jointes, récurrence, longueur.

```
@mention Slack
     │ ACK + 👀 (< 3 s)
     ▼ classification (~250 ms, modèle éco)
     ├── chat_simple ──────► pas de sandbox, LLM direct (modèle éco)
     │                       réponse en thread en 2-5 s, 👀 → ✅
     ├── task_agentique ───► sandbox + plan + progression par jalons
     │                       en thread, approbations Block Kit, 👀 → ✅
     └── ambigu ───────────► démarre en chat_simple,
                             ESCALADE si l'agent découvre un besoin d'outils
```

**Chemin simple** — ex. *"@agent c'est quoi notre convention de nommage des branches ?"* : appel LLM direct via le llm-proxy avec la mémoire utilisateur injectée, réponse dans le thread. Coût ~$0.002, **aucun sandbox réveillé** — essentiel au modèle de coûts §25 car la majorité des mentions sont de ce type.

**Chemin complexe** — ex. *"@agent déploie fix/login sur staging et préviens l'équipe"* :
1. Message immédiat en thread avec le plan (issu du Planning §9.2) : "Je m'en occupe. Plan : ① CI ② PR ③ merge après ton approbation ④ notifier #dev."
2. **Progression par jalons** via `chat.update` à chaque étape franchie — pas de streaming token par token (l'API Slack tolère ~1 update/s, et ça spammerait le canal).
3. Approbations → cartes Block Kit dans le thread.
4. Récap final + liens (PR, logs) + ✅.

**Escalade en cours de tour — la classification est réversible.** Si une requête classée `chat_simple` révèle un besoin d'outils ("vérifie dans le repo…"), l'agent émet `agent.escalated` : le tour est requalifié `task_agentique`, l'Orchestrator réveille le sandbox, et Slack affiche simplement "Je regarde dans le repo, un instant ⏳". Le fail-safe en cas de doute est toujours **démarrer léger puis escalader**, jamais l'inverse (réveiller un sandbox "au cas où" coûte cher et ralentit les réponses simples).

**Cas de bord :**

| Cas | Comportement |
|---|---|
| Tâche longue (> 2-3 min) | Message "Ça va prendre quelques minutes, je te notifie ici ✋" → thread asynchrone ; à la fin, mention `@user` dans le thread pour déclencher sa notification native |
| Message pendant un run | FIFO par conversation : mis en file comme contexte du tour suivant, ou traité comme instruction de correction du tour en cours ("annule", "prends plutôt la branche X") |
| Annulation | Bouton "Arrêter" sur le message de progression + `/agent stop` → `CancelTask` (§10.3) |
| Mention en **canal public** | L'agent agit avec les permissions **du mentionneur** (résolu via `identities`) et répond dans le thread. **Garde-fou confidentialité** : si la tâche touche des données personnelles (mails, DM, fichiers privés), réponse en canal "Je t'envoie ça en DM 👋" et bascule — jamais de données d'un connecteur personnel exposées dans un canal partagé |
| Mentionneur inconnu (compte non lié) | Réponse éphémère avec le lien de liaison de compte (OIDC Slack) — aucun traitement avant liaison |
| Deux tâches en parallèle | Un seul tour actif par conversation ; un second thread = une seconde conversation (limite 5 conversations simultanées/utilisateur, §8.1) |

Le même modèle (ACK, classification, jalons, escalade) s'applique à Teams — seule la mécanique d'affichage change (`updateActivity`/Adaptive Cards au lieu de `chat.update`/Block Kit).

### 7.3 Web App

- **Techno :** React 18 + TypeScript + Vite, TailwindCSS, TanStack Query, Zustand.
- **Temps réel :** WebSocket (fallback SSE) — le seul canal avec **vrai streaming token par token**.
- **Auth :** OIDC (Entra ID / autre IdP) → cookie de session httpOnly + JWT court (15 min) rafraîchi silencieusement.
- **Fonctionnalités :**
  - historique des conversations, explorateur du workspace sandbox (lecture), visualisation des appels d'outils en direct ;
  - gestion des connexions OAuth (page "Connexions" : GitHub, Notion…) ;
  - **page "Automatisations"** : liste des crons de l'utilisateur (horaire lisible, prochaine exécution, historique des runs avec coût, bouton pause/reprise/suppression, édition du prompt) ;
  - console admin (RBAC `admin`) : sandboxes, audit, usage, **vue org des automatisations** (volumétrie, coûts, jobs en échec).

### 7.4 Contrat d'événement normalisé

Tous les adaptateurs — **et l'automation-service** — produisent :

```json
{
  "schema_version": "1.2",
  "message_id": "msg_01H...",
  "user_id": "usr_7f3a...",
  "org_id": "org_acme",
  "channel": "teams | slack | web | scheduler",
  "channel_ref": { "conversation_id": "...", "thread_ts": "...", "activity_id": "...",
                   "job_id": "job_01H...", "scheduled_for": "2026-07-13T07:00:00Z" },
  "conversation_id": "conv_9b2c...",
  "text": "Déploie la branche fix/login sur staging",
  "attachments": [ { "s3_key": "...", "mime": "application/pdf", "name": "spec.pdf" } ],
  "locale": "fr-FR",
  "idempotency_key": "job_01H...:2026-07-13T07:00:00Z",
  "ts": "2026-07-13T10:42:00Z"
}
```

Et consomment un flux d'`AgentEvent` :

```
agent.thinking        → indicateur d'activité
agent.text.delta      → texte streamé
agent.tool.call       → { tool, args_summary, requires_approval }
agent.tool.result     → { tool, status, result_summary }
agent.approval.needed → carte interactive Approuver/Refuser
agent.file.created    → lien de téléchargement signé
agent.cron.created    → { job_id, human_schedule, next_run_at }   (v2)
agent.escalated       → { from: "chat_simple", to: "task_agentique" }  (v2.2)
agent.done            → fin de tour (usage tokens, coût)
agent.error           → erreur formatée utilisateur (code de la taxonomie §21)
```

**Localisation :** l'agent répond dans la langue portée par `locale` ; les cartes d'approbation, notifications proactives et messages d'erreur (taxonomie §21) sont localisés — fr/en/ar au lancement, un enjeu réel pour le marché tunisien.

**Versioning des schémas :** champ `schema_version` obligatoire ; évolutions additives uniquement (jamais de suppression/renommage de champ sur une version majeure) ; consommateurs en "tolerant reader". Les schémas JSON vivent dans `packages/schemas` (source de vérité unique, types générés TS + Pydantic).

---

## 8. API Gateway & Backend Core

### 8.1 API Gateway (Kong ou Envoy Gateway)

| Fonction | Détail |
|---|---|
| TLS termination | Certificats gérés par cert-manager (Let's Encrypt / CA interne) |
| AuthN | Validation JWT (JWKS du service Auth), rejet fail-closed |
| Rate limiting | Par `user_id` : 30 req/min chat, 5 conversations simultanées ; par `org_id` : quotas contractuels |
| WAF | Règles OWASP CRS (ModSecurity plugin) |
| Routing | `/api/v1/chat/*` → backend-core, `/api/v1/admin/*` → backend-core (scope admin), `/webhooks/teams` → teams-adapter, `/webhooks/slack` → slack-adapter |
| Observabilité | Access logs JSON → Loki, traces OpenTelemetry propagées (`traceparent`) |

### 8.2 Backend Core (FastAPI + Python 3.12)

API versionnée (`/api/v1`, politique de dépréciation : 6 mois de préavis, header `Sunset`). Services exposés (REST + WebSocket) :

```
POST   /api/v1/conversations                    # créer une conversation
GET    /api/v1/conversations?cursor=...         # lister
GET    /api/v1/conversations/{id}/messages
POST   /api/v1/conversations/{id}/messages      # envoyer un message (Idempotency-Key requis)
WS     /api/v1/conversations/{id}/stream        # flux AgentEvent
POST   /api/v1/conversations/{id}/approve       # répondre à agent.approval.needed
POST   /api/v1/conversations/{id}/cancel        # interrompre le tour en cours

GET    /api/v1/me                               # profil + connexions OAuth
POST   /api/v1/connections/{provider}/start     # démarrer OAuth (GitHub, Notion...)
GET    /api/v1/connections/{provider}/callback

GET    /api/v1/automations                      # crons de l'utilisateur (v2)
PATCH  /api/v1/automations/{job_id}             # pause / resume / edit (v2)
DELETE /api/v1/automations/{job_id}             # suppression (v2)
GET    /api/v1/automations/{job_id}/runs        # historique des runs (v2)

POST   /internal/scheduled-runs                 # appelé par automation-service uniquement
                                                # (mTLS + service token, non exposé au Gateway)

GET    /api/v1/files/{id}                       # URL signée S3
GET    /api/v1/admin/users | /sandboxes | /audit | /usage | /automations
```

- **Bus interne :** NATS JetStream (ou Redis Streams pour démarrer) — sujets `inbound.messages`, `agent.events.{conversation_id}`, `orchestrator.commands`, `automation.lifecycle`.
- Le Backend Core **ne parle jamais au LLM ni aux sandboxes** directement : il publie sur le bus, le Prompt Layer et l'Orchestrator consomment.
- **Note :** la création/modification de crons par l'agent passe par le **Scheduler MCP** (§14, §15) — les endpoints `/api/v1/automations` servent à l'utilisateur (UI Web, slash commands) pour gérer ce que son agent a créé. Les deux chemins convergent vers l'automation-service.

### 8.3 Contrats API détaillés & protocole temps réel

**Envoi d'un message** — l'API répond en 202 immédiatement (le travail est asynchrone) :

```http
POST /api/v1/conversations/conv_9b2c/messages
Authorization: Bearer <jwt_session>
Idempotency-Key: 7c9e6679-7425-40de-944b-e07fc1f90ae7

{ "text": "Déploie fix/login sur staging", "attachments": [] }

→ 202 Accepted
{ "message_id": "msg_01H8...", "task_id": "task_01H8...", "stream": "/api/v1/conversations/conv_9b2c/stream" }
```

**Enveloppe d'erreur unique** (tous les endpoints) :

```json
{ "error": { "code": "E_SCHED_QUOTA_REACHED", "message": "Vous avez atteint 20 automatisations actives.",
             "trace_id": "4bf92f35...", "retry_after": null } }
```

**Pagination** : cursor opaque (base64 de `(created_at, id)`), `limit` ≤ 100, réponse `{ items: [...], next_cursor: "..." | null }`. Jamais d'offset (coût et dérive sous écriture concurrente).

**Protocole WebSocket** (`/stream`) :

```
Client → { "type": "subscribe", "last_seq": 0 }        # last_seq > 0 = reprise
Serveur → { "type": "agent.text.delta", "seq": 41, "data": {...} }
        → { "type": "agent.done", "seq": 57, "data": { "usage": {...} } }
Ping/pong toutes les 30 s ; absence de pong ×2 → fermeture 1011.
```

- Chaque événement porte un `seq` monotone par conversation. À la reconnexion, le client envoie `last_seq` reçu ; le serveur rejoue le delta depuis NATS JetStream (replay natif) — **aucun événement perdu sur coupure réseau**, aucune duplication (le client ignore `seq` ≤ `last_seq`).
- Codes de fermeture : `4001` JWT expiré (le client se ré-authentifie et reprend), `4003` accès refusé, `1011` erreur serveur (backoff exponentiel 1 s → 30 s).
- Fallback SSE : mêmes événements, reprise via header `Last-Event-ID`.

---

## 9. Prompt Layer

Le cerveau de contrôle **avant** l'agent. Service Python stateless (`prompt-layer`), consomme `inbound.messages`, produit un `AgentTask` validé pour l'Orchestrator. Pipeline en 5 étages exécutés dans cet ordre. **Les messages de canal `scheduler` traversent le même pipeline** — seule différence : pas d'interaction possible avec l'utilisateur en cours de run (les `require_approval` font échouer proprement l'appel d'outil au lieu de suspendre, sauf si le job a une approbation pré-accordée pour un outil précis, voir §15.6).

```mermaid
flowchart LR
    IM["InboundMessage"] --> M["1 · Memory<br/>top-k hybride"] --> P["2 · Planning<br/>classification · plan · budget"] --> G["3 · Guardrails<br/>fail-closed"] --> PE["4 · Permissions<br/>allowed_tools signés"] --> R["5 · Routing<br/>modèle · profil"] --> AT["AgentTask<br/>+ TASK JWT"]
    G -->|"bloqué"| X["E_GUARD_INPUT_BLOCKED"]
    PE -->|"refusé"| Y["E_PERM_TOOL_DENIED"]
```

### 9.1 Memory — architecture mémoire complète

Sept types de mémoire + un état d'automatisation, activés en trois phases :

| # | Type | Stockage | Contenu / rôle | Phase |
|---|---|---|---|---|
| 1 | **Travail** | Redis (`conv:{id}:window`) | 30 derniers tours + résumé glissant (TTL 7 j, résumé re-généré tous les 15 tours) | v1 |
| 2 | **Sémantique** | pgvector (`memories`) | Faits durables : extraits en asynchrone (job `memory-extraction`) **et** enregistrés délibérément par l'agent (Memory MCP) ; dédup cosinus > 0,92 | v1 |
| 3 | **Procédurale** | Volume sandbox (`/workspace/.agent/`) | `NOTES.md` + une note par projet : le *comment faire* appris ("déploiement checkout : CI → tag → ArgoCD, jamais de push direct") — souvent plus utile que les faits | v1 |
| 4 | **Corrections** | `memories` (`kind='correction'`, poids renforcé) | Corrections explicites de l'utilisateur, thumbs down, refus d'approbation répétés (3 refus de `merge_pr` le vendredi ⇒ "pas de merge le vendredi") | v1 |
| 5 | **Épisodique** | pgvector sur chunks de `messages` | Recherche dans les conversations passées ("qu'avait-on décidé pour la migration en mai ?") — injection auto top-k + outil explicite | v2 |
| 6 | **Entités temporelle** | `entities` + `entity_facts` (§9.1.2) | Mini-graphe typé (personnes, projets, repos, clients) avec validité temporelle — raisonner sur "qui était on-call la semaine du bug ?" | v3 |
| 7 | **Organisationnelle** | pgvector, scope `org` | Conventions d'équipe, glossaire, décisions — proposée par les agents, **validée par un humain** avant partage (jamais de promotion automatique) ; converge avec le Knowledge MCP §14.2 | v3 |
| + | **État des automatisations** | `scheduled_jobs.job_memory` (JSONB) | Mémoire entre runs d'un cron : dédup des alertes déjà signalées, marqueur `no_op` intelligent | v2 |

**Récupération au tour** : top-k (k=8) + filtre `user_id`, classement **hybride** `score = 0,65 × cosinus + 0,20 × décroissance_récence (demi-vie 30 j) + 0,15 × fréquence_d'usage` (+ bonus 0,15 si `kind='correction'`), seuil 0,55 ; `expires_at` purge les faits datés ("en congés jusqu'au 15/08"). Injection en trois sections du contexte : `<user_memory>` (faits + corrections), `<procedural_notes>` (extraits des notes du projet actif), `<episodes>` (si pertinence forte). Pour un run planifié, la mémoire est celle de l'utilisateur **au moment du run** — même principe que les permissions.

#### 9.1.1 Memory MCP — la mémoire comme outil audité

Serveur MCP interne derrière la Gateway (pattern MemGPT/Letta), scope imposé au `sub` du TASK JWT :

```jsonc
memory.save   { content, kind: "fact|preference|procedure|correction",
                entities?: ["proj:checkout"], expires_at? }
memory.search { query, kinds?, scope: "memories|episodes", top_k: 8 }
memory.update { memory_id, content }        // versionné : l'ancien contenu est archivé
memory.forget { memory_id | filter }        // suppression définitive, auditée
```

Trois bénéfices : l'agent décide **délibérément** ce qui mérite d'être retenu (meilleure précision que l'extraction passive, qui reste en filet de sécurité) ; chaque écriture passe par l'AuthZ et **l'audit** comme n'importe quel outil ; `memory.forget` est en libre-service pour l'utilisateur. Politique par défaut : `memory.* → allow`, écritures journalisées (`args_hash`).

#### 9.1.2 Mémoire d'entités temporelle (DDL)

```sql
CREATE TABLE entities (
  id        TEXT PRIMARY KEY,               -- ent_01H...
  user_id   TEXT REFERENCES users(id),      -- NULL si scope org
  org_id    TEXT REFERENCES orgs(id),
  kind      TEXT NOT NULL,                  -- person|project|repo|client|system
  name      TEXT NOT NULL,
  aliases   TEXT[] NOT NULL DEFAULT '{}',   -- résolution d'entités à l'extraction
  UNIQUE (org_id, user_id, kind, name)
);

CREATE TABLE entity_facts (
  id          TEXT PRIMARY KEY,
  entity_id   TEXT NOT NULL REFERENCES entities(id),
  predicate   TEXT NOT NULL,                -- 'on_call_de', 'utilise', 'appartient_a'...
  object      TEXT NOT NULL,                -- valeur libre OU 'ent:<id>' (relation)
  source_msg  TEXT,
  confidence  NUMERIC(3,2) NOT NULL DEFAULT 0.80,
  valid_from  TIMESTAMPTZ NOT NULL DEFAULT now(),
  valid_to    TIMESTAMPTZ                   -- NULL = fait courant
);
CREATE INDEX ON entity_facts (entity_id, predicate, valid_to);
```

**Règle d'or : jamais d'UPDATE destructif.** Un fait contredit est **clôturé** (`valid_to = now()`) et le nouveau est ouvert — "Sami est on-call" n'est pas écrasé quand Leila prend le relais, il est daté. L'agent peut ainsi interroger l'état passé, et les contradictions se résolvent par la temporalité plutôt que par la dernière écriture.

#### 9.1.3 Garde-fous & hygiène

- **Interdits d'écriture** : secrets/tokens (mêmes règles DLP §13.5 appliquées à `memory.save` et à l'extraction), catégories sensibles (santé…), et **faits sur des tiers issus de contenus lus** — l'agent qui lit les mails ne stocke jamais "Karim cherche un autre job" ; cas de test dédiés dans le corpus adversarial (§20.2).
- **Transparence produit** : page "Mémoires" dans l'UI (§4.4) — l'utilisateur voit, édite et supprime chaque mémoire ; `user-erasure` purge `memories`, `entities`, `entity_facts` et les notes workspace.
- **Consolidation** : job Trigger.dev `memory-consolidation` (hebdomadaire, §15.7) — fusion des doublons, clôture des contradictions, décroissance des mémoires jamais réutilisées, compaction des notes workspace > 2 000 lignes. Sans ce job, la mémoire devient du bruit en 6 mois.

### 9.2 Planning

- Classifie la requête : `chat_simple` (réponse directe, pas de sandbox) vs `task_agentique` (nécessite outils/sandbox). La classification est effectuée par un modèle léger (Haiku, few-shot, sortie JSON `{class, confidence}` ; `confidence < 0,7` ⇒ classe `ambigu`) en ~250 ms et est **réversible** : un tour `chat_simple` peut être escaladé en `task_agentique` en cours de route (`agent.escalated`) si le besoin d'outils apparaît — voir §7.2.1. Le cas ambigu démarre toujours léger.
- **Détection d'intention d'automatisation** : si la requête exprime une récurrence ("chaque lundi", "tous les matins", "toutes les 2 heures"), le plan inclut explicitement l'usage du Scheduler MCP et la confirmation du cron à l'utilisateur avant création.
- Pour les tâches agentiques : décomposition en plan de haut niveau (3-7 étapes) inséré dans le prompt système de l'agent — l'agent reste libre de réviser le plan, mais le plan initial cadre l'exécution et permet l'affichage de progression côté client.
- Estime un **budget** : tokens max, durée max, outils probables → transmis à l'Orchestrator pour dimensionner le sandbox et poser les timeouts. Pour un run planifié, le budget vient du job (`per_run_budget`), pas de l'estimation.

### 9.3 Guardrails

Deux directions, fail-closed :

**Entrée (avant l'agent) :**
- Détection d'injection de prompt (classifieur + heuristiques sur les pièces jointes).
- Filtrage PII sortant du périmètre (option par org).
- Politique de contenu (catégories bloquées configurables par org).
- **Prompts de crons :** re-scannés à *chaque* déclenchement (la politique org a pu changer depuis la création du job) ; un prompt devenu non conforme → job auto-pausé + notification.

**Sortie (avant l'utilisateur) :**
- Scan DLP des réponses (regex secrets : clés AWS, tokens GitHub, mots de passe → masquage).
- Vérification que les fichiers générés ne contiennent pas de secrets (gitleaks en mode librairie).
- Troncature/refus si la sortie viole la politique.

### 9.4 Permissions

- Modèle **RBAC + ABAC** : rôles (`member`, `power_user`, `admin`) × attributs (département, org, sensibilité de l'outil).
- Matrice `tool_policies` en base : `(org_id, role, tool_pattern) → allow | deny | require_approval`.
  - Ex. : `github.create_pr → allow`, `github.merge_pr → require_approval`, `database.write → deny (member)`, `scheduler.create_cron → require_approval` (défaut), `scheduler.list_crons → allow`.
- Le Prompt Layer calcule l'**ensemble d'outils autorisés** pour ce tour et le signe dans le JWT de tâche (`allowed_tools`, `approval_tools`) — la MCP Gateway re-vérifie (défense en profondeur).
- **Runs planifiés : évaluation au moment du feu.** Les permissions d'un cron ne sont *jamais* figées à la création. Utilisateur désactivé, rôle rétrogradé, outil retiré de la politique org → le run échoue en `E_PERM_REVOKED` et le job est mis en pause avec notification. C'est le principe n°7.

### 9.5 Routing

- **Choix du modèle :** requêtes simples → modèle rapide/économique ; tâches de code longues → modèle frontier ; configurable par org avec fallback automatique si quota/incident fournisseur. Les runs planifiés utilisent par défaut un modèle économique (surchargeable par job si la politique l'autorise). La sélection des modèles par rôle, les benchmarks de référence et le protocole de re-test trimestriel sont en **Annexe H**.
- **Choix de l'agent :** profils OpenCode pré-définis (`dev`, `data-analyst`, `ops`, `generalist`) sélectionnés selon la classification + préférence utilisateur, ou fixés par le job pour un cron.
- Produit l'objet final :

```json
{
  "task_id": "task_01H...",
  "origin": "interactive | scheduled",
  "job_id": "job_01H... (si scheduled)",
  "user_id": "usr_7f3a", "org_id": "org_acme",
  "conversation_id": "conv_9b2c",
  "agent_profile": "dev",
  "model": "frontier-large",
  "system_context": { "memory": "...", "plan": "...", "org_rules": "..." },
  "allowed_tools": ["github.*", "browser.read_*", "scheduler.*"],
  "approval_tools": ["github.merge_pr", "scheduler.create_cron"],
  "budget": { "max_tokens": 120000, "max_seconds": 900, "max_cost_usd": 2.5 },
  "task_jwt": "eyJhbGciOiJFUzI1NiIs..."
}
```

### 9.6 Structure du contexte LLM & stratégie de prompt caching

Le caching est le levier de coût n°1 (voir Annexe C) ; il ne fonctionne que si le préfixe du contexte est **octet-pour-octet stable** entre les appels. Le Prompt Layer impose donc un ordre de blocs strict, du plus stable au plus volatil :

```
┌─ 1. System prompt plateforme (global, versionné)          ─┐
├─ 2. Profil d'agent (stable par profil)                     │ cache_control
├─ 3. Définitions d'outils (tri alphabétique déterministe)   │ (breakpoints)
├─ 4. Règles org (stable par org)                           ─┘
├─ 5. <user_memory> (varie lentement — invalide rarement)
├─ 6. Historique de conversation (append-only → cache-friendly)
└─ 7. Message courant + résultats d'outils du tour
```

Règles imposées par le llm-proxy (et vérifiées par un test de non-régression) :
- **Jamais d'élément volatil dans le préfixe** : pas d'horodatage, pas d'ID de tour, pas de compteur dans les blocs 1-4. La date du jour, si nécessaire, vit dans le bloc 7.
- **Tri déterministe des définitions d'outils** : `allowed_tools` varie par utilisateur/tour ; un ordre alphabétique garantit que deux tours du même utilisateur produisent le même bloc 3.
- **TTL** : 5 min suffit en boucle agentique (itérations espacées de secondes) ; 1 h (écriture à 2×) pour les conversations épisodiques — rentable dès la 2ᵉ lecture.
- **Compaction sans casse** : la compaction de contexte (résumé des vieux tool results) ne réécrit jamais les blocs 1-5 ; elle remplace des segments du bloc 6 en fin de fenêtre uniquement.
- **Cible mesurée** : hit rate ≥ 75 % global (métrique `llm_cache_hit_ratio` par org, §19) ; une org sous 60 % déclenche une investigation (souvent : un adaptateur qui injecte un timestamp).

---

# PARTIE III — EXÉCUTION : AGENTS, OUTILS & AUTOMATISATIONS

*Orchestrateur, sandboxes, OpenCode, MCP Gateway, connecteurs et Trigger.dev.*

---

## 10. Agent Orchestrator

Service Go (performance, concurrence) qui gère le **cycle de vie des sandboxes** et le **dispatch des tâches**.

### 10.1 Machine à états d'un sandbox

```
        create()            task assigned           idle > 10 min
COLD ──────────► WARMING ──────────────► ACTIVE ─────────────► IDLE
                    │                       │  ▲                  │
                    │ healthcheck fail      │  │ nouveau message  │ idle > 60 min
                    ▼                       ▼  │  ou cron fire    ▼
                  FAILED ◄────────────── ERROR │             HIBERNATED
                    │                          │             (container stoppé,
                    └────── kill + recreate ───┘              volume conservé)
                                                                  │ > 30 jours
                                                                  ▼
                                                              DESTROYED
                                                        (volume archivé S3)
```

Version rendue :

```mermaid
stateDiagram-v2
    [*] --> COLD
    COLD --> WARMING : create()
    WARMING --> ACTIVE : task assignée
    WARMING --> FAILED : healthcheck KO
    ACTIVE --> IDLE : inactif > 10 min
    IDLE --> ACTIVE : message ou cron (< 200 ms)
    IDLE --> HIBERNATED : inactif > 60 min
    HIBERNATED --> ACTIVE : réveil (~4 s)
    HIBERNATED --> DESTROYED : > 30 j (volume archivé S3)
    ACTIVE --> ERROR : incident
    ERROR --> ACTIVE : reprise
    FAILED --> COLD : kill + recreate
    DESTROYED --> [*]
```

### 10.2 Responsabilités

- **Pool chaud :** N conteneurs pré-démarrés (image OpenCode) sans identité → assignation à un utilisateur en < 500 ms (montage du volume user + injection du JWT de tâche).
- **Scheduling :** placement bin-packing sur les nœuds workers (via API Docker/containerd sur chaque nœud, ou Kubernetes Jobs/Pods si K8s — voir §22). Limites : CPU 2, RAM 4 Gi, disque 10 Gi, PIDs 512 par sandbox.
- **Quotas & priorités :** max sandboxes simultanés par org, files d'attente FIFO par org. **Les tours interactifs sont prioritaires sur les runs planifiés** (2 classes de priorité) : un cron ne fait jamais attendre un humain. Les runs planifiés en attente > 15 min sont replanifiés (retry Trigger.dev) plutôt que de gonfler la file.
- **Health :** probe HTTP interne du serveur OpenCode toutes les 15 s ; 3 échecs → recréation.
- **Streaming :** relaie les événements SSE d'OpenCode → bus NATS `agent.events.{conversation_id}` → Backend Core → clients.
- **Enforcement du budget :** coupe le sandbox si `max_seconds` ou `max_cost_usd` dépassé, émet `agent.error(E_BUDGET_EXCEEDED)`.

### 10.3 API interne (gRPC)

```proto
service Orchestrator {
  rpc SubmitTask(AgentTask) returns (stream AgentEvent);
  rpc CancelTask(TaskRef) returns (Ack);
  rpc GetSandboxStatus(UserRef) returns (SandboxStatus);
  rpc HibernateSandbox(UserRef) returns (Ack);
  rpc AdminListSandboxes(OrgRef) returns (SandboxList);
}
```

### 10.4 Algorithmes internes

**Dimensionnement du pool chaud.** Cible recalculée toutes les 60 s par le job `pool-warmer` :
`target = max(pool_min, ceil(λ_p95 × T_froid) + marge)` où `λ_p95` = arrivées de nouveaux utilisateurs actifs/min (p95 glissant 1 h) et `T_froid` = temps de création à froid (~8 s ≈ 0,13 min). En pratique : `pool_min = 5` en heures ouvrées, 2 la nuit ; la marge absorbe les rafales de 9 h 00 (corrélée au jitter des crons, §15.6).

**Placement (bin-packing avec score).** Pour chaque nœud éligible :
`score = 0,5×(1−cpu_réservé) + 0,3×(1−mem_réservée) − 0,2×pénalité_étalement` — le meilleur score gagne. La pénalité d'étalement évite de co-localiser plusieurs sandboxes historiquement gourmands (p95 CPU du user, connu de `usage_daily`). Le drain d'un nœud (`platctl sandbox drain`) = cordon + hibernation forcée des IDLE + migration des ACTIVE à la fin de leur tour.

**Séquences de réveil (budget temps) :**

| État initial | Étapes | Cible |
|---|---|---|
| IDLE (conteneur vivant) | dépôt du TASK JWT dans le tmpfs → push du tour à OpenCode | **< 200 ms** |
| HIBERNATED (conteneur stoppé, volume présent) | `start` conteneur → healthcheck (probe 500 ms) → JWT → push | **< 4 s** |
| COLD (rien) | claim d'un conteneur du pool chaud → montage volume user → renommage identité → JWT → push | **< 500 ms** |
| COLD, pool vide | création complète (image chaude sur le nœud) | **< 8 s** (SLO Annexe A) |

Le TASK JWT est déposé dans un **tmpfs** (`/run/secrets/task_jwt`) relu par le shim MCP d'OpenCode à chaque appel : le renouvellement (toutes les ~12 min pour un tour long) ne nécessite ni redémarrage ni variable d'environnement.

**Haute disponibilité.** Deux réplicas en actif/passif via **K8s Lease** (renouvelé toutes les 5 s ; bascule < 15 s). Au démarrage, le nouveau leader reconstruit son état : lecture de la table `sandboxes` (vérité déclarée) puis **réconciliation** avec l'état réel des nœuds (liste des conteneurs) — les divergences (conteneur orphelin, entrée fantôme) sont corrigées et journalisées. Les tours en vol survivent : ils streament via NATS, pas via le process orchestrator.

---

## 11. Sandboxes Docker

### 11.1 Image

```dockerfile
FROM ubuntu:24.04
# Outillage dev standard
RUN apt-get update && apt-get install -y \
    git curl ripgrep jq build-essential python3.12 python3-pip nodejs npm \
    && rm -rf /var/lib/apt/lists/*
# OpenCode (binaire) + profils d'agents
COPY --from=opencode/opencode:latest /usr/local/bin/opencode /usr/local/bin/
COPY profiles/ /etc/opencode/profiles/
# Utilisateur non-root
RUN useradd -m -u 10001 agent
USER agent
WORKDIR /workspace
ENTRYPOINT ["opencode", "serve", "--port", "4096", "--hostname", "0.0.0.0"]
```

### 11.2 Durcissement

| Mesure | Implémentation |
|---|---|
| Runtime isolé | **gVisor (runsc)** — syscalls interceptés en espace utilisateur (alternative : Kata Containers / Firecracker si besoin VM) |
| Rootless | Docker rootless ou user namespaces (`userns-remap`) |
| Capacités | `--cap-drop=ALL`, `--security-opt no-new-privileges` |
| Seccomp | Profil custom (défaut Docker + blocage `ptrace`, `mount`, `bpf`) |
| FS | Image en lecture seule (`--read-only`), `/workspace` = volume dédié user, `/tmp` en tmpfs 512 Mo |
| Réseau | Réseau Docker interne dédié ; **egress uniquement vers mcp-gateway:8443** (iptables/NetworkPolicy) ; pas de DNS externe |
| Ressources | cgroups v2 : cpu=2, mem=4Gi, pids=512, io pondéré |
| Secrets | **Aucun.** Seul le `task_jwt` (15 min) est déposé par l'Orchestrator dans un tmpfs `/run/secrets/task_jwt`, relu à chaque appel MCP — renouvellement sans redémarrage, jamais en variable d'env ni sur disque |
| Images | Build reproductible, SBOM, signature cosign, scan Trivy bloquant en CI |
| Chiffrement at-rest | Volumes workspace **et** snapshots chiffrés (LUKS / chiffrement natif du provider, clés KMS) — les workspaces contiennent des clones de repos privés |

### 11.3 Volume workspace

- 1 volume par utilisateur (`vol-usr_7f3a`), monté sur `/workspace`.
- Contenu : clones de repos, fichiers générés, notes de l'agent (`/workspace/.agent/scratch`).
- Snapshot quotidien (job Trigger.dev `volume-snapshot`) → S3 ; archivage après 30 j d'inactivité.

---

## 12. OpenCode Agent

- Lancé en mode **serveur** (`opencode serve`) : l'Orchestrator lui pousse les tours via son API HTTP locale et consomme le flux d'événements.
- **Profils** (`/etc/opencode/profiles/*.json`) : prompt système du rôle, modèle par défaut, outils MCP activés, règles de style de l'org (injectées depuis `system_context.org_rules`).
- **Fournisseur LLM :** OpenCode est configuré avec un **proxy LLM interne** comme unique provider (`llm-proxy.internal`). Ce proxy (LiteLLM ou équivalent) :
  - route vers le vrai fournisseur selon le champ `model` du task ;
  - compte les tokens/coûts par `user_id`/`org_id`/`job_id` (facturation, y compris coût par automatisation) ;
  - applique le budget du tour ;
  - permet le failover multi-fournisseurs.
- **MCP Client intégré :** OpenCode est configuré avec **un seul serveur MCP distant** — la MCP Gateway :

```json
{
  "mcp": {
    "gateway": {
      "type": "remote",
      "url": "https://mcp-gateway.internal:8443/mcp",
      "headers": { "Authorization": "Bearer ${TASK_JWT}" }
    }
  }
}
```

Ainsi l'agent voit dynamiquement la liste d'outils **filtrée pour cet utilisateur et ce tour** (la Gateway ne présente que `allowed_tools`) — y compris les outils `scheduler.*` s'il y a droit.

---

## 13. MCP Gateway

Composant central de sécurité. Service Node.js/TypeScript (SDK MCP officiel) ou Go, stateless, exposé uniquement sur le réseau interne.

### 13.1 Pipeline d'un appel d'outil

```
Sandbox (MCP Client)
   │ 1. tools/call {name:"scheduler.create_cron", args} + Bearer TASK_JWT (mTLS)
   ▼
[AuthN]  vérifie signature JWT, expiration, audience "mcp-gateway"
   ▼
[AuthZ]  name ∈ allowed_tools ?  → sinon deny (E_PERM_TOOL_DENIED)
         name ∈ approval_tools ? → suspend + événement agent.approval.needed
   ▼
[Args validation]  schéma JSON de l'outil + règles métier
                   (ex: cron_expr valide, intervalle ≥ 15 min, quota jobs non atteint)
   ▼
[Token injection]  Vault: lit le credential adapté (token OAuth user pour GitHub,
                   service token interne pour l'automation-service...)
   ▼
[Dispatch]  → serveur MCP cible (connexion pooled, circuit breaker, timeout 60s,
              Idempotency-Key propagée sur toute écriture)
   ▼
[Result filtering]  DLP sur la réponse (masquage de secrets), taille max 256 Ko
   ▼
[Audit]  append-only: {ts, user, org, tool, args_hash, status, latency, bytes}
   ▼
Retour au sandbox
```

### 13.2 Gestion des identités OAuth par utilisateur

- Chaque connecteur nécessitant un compte utilisateur (GitHub, Notion, Microsoft Graph délégué) suit un **flow OAuth 3-legged** initié depuis la Web App (`/api/v1/connections/{provider}/start`).
- Tokens (access + refresh) chiffrés (AES-256-GCM, clés dans **HashiCorp Vault** transit engine ou KMS cloud) → table `oauth_tokens`.
- La Gateway rafraîchit automatiquement les tokens expirés (mutex Redis par `user_id+provider`) ; un job Trigger.dev `oauth-refresh-sweep` rafraîchit de façon proactive les tokens qui expirent < 24 h pour que **les runs planifiés de nuit ne tombent pas sur un token mort**.
- Si aucun token : l'appel échoue avec `E_CONN_NEEDS_CONNECTION` → l'agent renvoie à l'utilisateur une carte "Connecter GitHub" (deep-link vers la page Connexions). Pour un run planifié, la notification part sur le canal de delivery du job.

### 13.3 Approbations humaines (human-in-the-loop)

- Outil marqué `require_approval` → la Gateway met l'appel en attente (Redis, TTL 10 min), émet `agent.approval.needed` avec résumé lisible des arguments.
- L'utilisateur approuve/refuse via Adaptive Card (Teams), Block Kit (Slack) ou UI Web → `POST /approve` → la Gateway reprend ou annule l'appel.
- **Cas particulier des runs planifiés :** pas d'humain dans la boucle en temps réel. Deux comportements possibles, choisis à la création du job : (a) *fail-fast* — l'outil échoue, le run continue sans l'action, le récap le mentionne ; (b) *pré-approbation ciblée* — lors de l'approbation de création du cron, l'utilisateur peut cocher "autoriser github.merge_pr dans ce job", consigné dans `scheduled_jobs.pre_approved_tools` et re-présenté à chaque modification du job.
- Toute approbation est journalisée (qui a approuvé, quand, arguments exacts).

### 13.4 Format complet du TASK JWT & rotation des clés

```json
{
  "header":  { "alg": "ES256", "kid": "task-2026-07", "typ": "JWT" },
  "payload": {
    "iss": "auth.internal",
    "aud": "mcp-gateway",
    "sub": "usr_7f3a",
    "org": "org_acme",
    "task_id": "task_01H8...",
    "conversation_id": "conv_9b2c",
    "origin": "interactive",
    "job_id": null,
    "allowed_tools":  ["github.*", "browser.read_*", "scheduler.*"],
    "approval_tools": ["github.merge_pr", "scheduler.create_cron"],
    "budget": { "max_cost_usd": 2.5, "max_seconds": 900 },
    "iat": 1783948920, "exp": 1783949820, "jti": "01J8ZK..."
  }
}
```

- **Rotation** : deux clés actives en permanence (`current` + `next`), publiées via JWKS avec `kid` ; rollover mensuel automatisé (job Trigger.dev) — `next` devient `current`, une nouvelle `next` est générée, l'ancienne reste vérifiable 24 h. Aucun redéploiement : la Gateway recharge le JWKS toutes les 5 min.
- **Révocation d'urgence** : blocklist Redis par `jti` (TTL = `exp` restant) alimentée par `platctl`, consultée par la Gateway — utile si un sandbox est suspecté compromis en cours de tour.
- La Gateway rejette tout JWT dont `aud ≠ mcp-gateway`, dont l'horloge dérive > 30 s, ou signé par un `kid` inconnu (fail-closed, jamais de fallback).

### 13.5 Règles DLP (filtrage des résultats)

Appliquées sur chaque réponse d'outil **et** sur la réponse finale de l'agent (guardrails de sortie §9.3) — masquage `«***redacted***»` + événement d'audit `dlp.redacted{rule}` :

| Famille | Exemples de motifs | Note |
|---|---|---|
| Clés cloud | `AKIA[0-9A-Z]{16}` (AWS), clés GCP/Azure | Bloquant |
| Tokens VCS/API | `ghp_`, `gho_`, `github_pat_`, `xoxb-`, `sk-…` | Bloquant |
| Matériel cryptographique | blocs `-----BEGIN … PRIVATE KEY-----`, JWT à 3 segments hors contexte | Bloquant |
| Credentials dans URLs | `scheme://user:pass@host` | Bloquant |
| Empreintes structurelles | entropie > seuil sur chaînes ≥ 32 chars dans des champs nommés `token/secret/key` | Signalement, masquage |

Faux positifs : allow-list par org (ex. identifiants internes ressemblant à des tokens), toute exception étant elle-même auditée. Les règles sont versionnées dans `packages/errors` (partagées Gateway + guardrails) et testées par un corpus dédié en CI.

---

## 14. Serveurs MCP

Chaque serveur MCP est un déploiement indépendant (scaling et pannes isolés), parlant MCP en streamable HTTP, accessible **uniquement** depuis la Gateway (NetworkPolicy).

| Serveur | Backend | Outils exposés (extraits) | Identité utilisée |
|---|---|---|---|
| **GitHub MCP** | GitHub REST + GraphQL | `search_code`, `read_file`, `create_branch`, `commit_files`, `create_pr`, `merge_pr`, `list_issues`, `create_issue`, `pr_review` | Token OAuth utilisateur (ou GitHub App installation token pour lecture org) |
| **Teams/M365 MCP** | Microsoft Graph | `send_teams_message`, `list_channels`, `read_channel`, `send_mail`, `search_mail`, `calendar_create_event`, `sharepoint_search`, `sharepoint_read_file`, `onedrive_upload` | Permissions **déléguées** Graph (token OBO de l'utilisateur) — jamais application-wide par défaut |
| **Slack MCP** | Slack Web API | `send_message`, `search_messages`, `read_channel`, `upload_file` | User token OAuth Slack |
| **Browser MCP** | Playwright (pool de contextes Chromium isolés) | `navigate`, `read_page` (extraction markdown), `screenshot`, `click`, `fill`, `download` | Aucune — sessions éphémères, allow-list de domaines par org, blocage IP privées (anti-SSRF) |
| **Database MCP** | Postgres/MySQL internes + APIs REST internes | `list_schemas`, `describe_table`, `query_readonly` (SELECT only, LIMIT forcé, timeout 30 s), `call_internal_api` | Comptes de service en lecture seule par org ; écritures = serveur séparé + `require_approval` |
| **Notion MCP** | Notion API | `search`, `read_page`, `create_page`, `update_page` | Token OAuth utilisateur |
| **Scheduler MCP** (v2) | automation-service → Trigger.dev | `create_cron`, `list_crons`, `get_cron`, `update_cron`, `pause_cron`, `resume_cron`, `delete_cron`, `run_now`, `get_run_history` | Service token interne ; le `user_id` du TASK_JWT est imposé comme propriétaire — un agent ne voit et ne touche **que** les jobs de son utilisateur |

**Règles communes :** schémas d'arguments stricts (JSON Schema), pagination systématique, réponses tronquées à 256 Ko, idempotency-keys sur les écritures, retries exponentiels sur 429/5xx.

### 14.1 Scheduler MCP — définition des outils

```jsonc
// scheduler.create_cron — require_approval par défaut
{
  "name": "Récap PRs du lundi",
  "schedule": {
    "cron": "0 9 * * 1",            // OU "natural": "chaque lundi à 9h"
    "timezone": "Europe/Paris"       // IANA, DST géré par Trigger.dev
  },
  "prompt": "Liste mes PRs GitHub ouvertes en attente de review, classe-les par urgence, et envoie-moi un résumé.",
  "agent_profile": "dev",            // optionnel
  "delivery": { "channel": "teams", "target": "dm" },   // teams|slack|email|webhook
  "per_run_budget": { "max_cost_usd": 0.50, "max_seconds": 300 },
  "on_approval_needed": "fail_fast", // ou "use_pre_approved"
  "enabled": true
}
// → retourne { job_id, human_schedule: "Chaque lundi à 09:00 (Europe/Paris)",
//              next_runs: ["2026-07-20T07:00:00Z", ...] }
```

Validations effectuées par le serveur (en plus de la Gateway) :
- expression cron valide (pas de champ secondes — granularité minimale : la minute), **intervalle minimal 15 min** (configurable par org) ;
- si `natural` fourni : conversion en cron + les 3 prochaines occurrences sont retournées à l'agent, qui doit les **confirmer à l'utilisateur** avant création (anti-malentendu "tous les lundis" vs "le 1er lundi du mois") ;
- quotas : max **20 jobs actifs/utilisateur**, 200/org (configurables) ;
- fenêtres interdites org ("quiet hours", ex. pas de runs 22h-6h sauf exemption) ;
- `delivery.target` ∈ cibles appartenant à l'utilisateur (jamais le canal d'un tiers) ;
- budget par run ≤ plafond org.

### 14.2 Catalogue de connecteurs additionnels (roadmap d'intégrations)

L'écosystème MCP distant a mûri : la plupart des éditeurs majeurs (Atlassian, Sentry, Linear, HubSpot, Vercel, Cloudflare…) publient désormais des endpoints Streamable HTTP officiels — beaucoup de connecteurs s'ajoutent donc **sans écrire de serveur**. Priorisation recommandée :

| Vague | Connecteur | Type | Identité | Politique par défaut | Profils cibles | Effort |
|---|---|---|---|---|---|---|
| 1 | **Atlassian (Jira+Confluence)** | Remote officiel (Streamable HTTP — SSE déprécié) | OAuth user (refresh rotatif) | lectures allow, écritures require_approval | dev, generalist | N1 |
| 1 | **Sentry** | Remote officiel | Token scopé **par projet** | lecture allow | dev, ops | N1 |
| 1 | **Web Search (Tavily/Brave/Exa)** | Remote | Clé API org | allow | tous | N1 |
| 1 | **Context7** (docs de librairies à jour) | Remote | — | allow (lecture seule) | dev | N1 |
| 1 | **Knowledge MCP interne** (RAG org sur pgvector) | Maison | Service token + filtre org/ACL | allow | tous | N3 |
| 2 | **Figma Dev Mode** | Remote officiel | OAuth user (siège Dev requis) | lecture allow | dev, design | N1 |
| 2 | **Linear** | Remote officiel | OAuth user | lectures allow, écritures require_approval | dev, pm | N1 |
| 2 | **Google Workspace** (Gmail/Drive/Calendar) | Officiel | OAuth délégué user | comme M365 | tous (orgs Google) | N2 |
| 2 | **Vercel / Cloudflare / Netlify** | Remote officiels | OAuth/token user | lectures allow, deploy require_approval | dev, ops | N1 |
| 2 | **GitLab** | Self-host | OAuth user | comme GitHub | dev | N2 |
| 3 | **Salesforce / HubSpot** | Remote officiels (self-host conseillé pour HubSpot) | OAuth user | lectures allow, écritures require_approval | sales | N1-N2 |
| 3 | **Zendesk / Intercom** | Remote/self-host | OAuth user | lectures allow, réponses require_approval | support | N2 |
| 3 | **Stripe** | Self-host (données sensibles) | Clé restreinte par org | rôle finance/admin uniquement ; toute écriture require_approval | finance | N2 |
| 3 | **Datadog / Grafana / PagerDuty** | Remote/self-host | Token scopé | lecture allow ; ack incidents require_approval | ops | N2 |
| 4 | **ServiceNow / Workday** (ITSM/RH) | Self-host | Comptes de service scopés | deny par défaut, ouverture org par org | rh, it | N3 |

Règles transverses issues des retours de production :
- **5 à 9 outils exposés par tour** est la zone optimale — au-delà, la précision de sélection d'outils du LLM chute. Notre Gateway le garantit structurellement : on peut brancher 20+ connecteurs côté plateforme, chaque profil d'agent n'en voit qu'un sous-ensemble.
- **Vendor-maintained d'abord** : ~50 serveurs "tier-1" sont maintenus par leurs éditeurs ; un serveur communautaire = audit du code + version épinglée + exécution derrière la Gateway obligatoire.
- **Self-host tout ce qui touche des données sensibles** (paiements, CRM, bases internes) ; les remotes hébergés conviennent aux connecteurs en lecture peu sensibles.

### 14.3 Onboarding d'un connecteur : processus industrialisé

Trois niveaux d'effort — le coût marginal est faible car auth, permissions, audit, DLP et quotas sont mutualisés dans la Gateway :

| Niveau | Cas | Travail | Durée typique |
|---|---|---|---|
| **N1 — Remote officiel** | Atlassian, Sentry, Linear, Stripe hébergé… | App OAuth chez l'éditeur (secrets → Vault) ; entrée provider dans le flow `/connections` (config, pas de code) ; déclaration Gateway (URL, préfixe d'outils, timeouts, breaker) ; `tool_policies` par défaut ; 3-5 tâches golden set | 1-3 jours |
| **N2 — Open source self-hosted** | GitLab, Zendesk, Datadog… | N1 + déploiement ns `mcp` (Helm), NetworkPolicy (accès Gateway uniquement), cycle de mise à jour | 2-5 jours |
| **N3 — Maison** | Knowledge MCP, APIs internes | Vrai dev, mais modeste : un serveur MCP minimal à 3 outils ≈ 80 lignes de TypeScript avec le SDK de référence ; l'essentiel du temps va au durcissement (schémas stricts, pagination, troncature, tests) | 1-2 sem. |

**Outillage à créer une fois :**
- `services/mcp-servers/_template/` — squelette SDK MCP + client HTTP (retries, breaker) + télémétrie OTel + Dockerfile + chart Helm pré-câblés.
- `docs/connector-onboarding.md` — checklist : ① app OAuth + scopes minimaux ② entrée Vault ③ config Gateway (catalogue, limites) ④ tool_policies ⑤ NetworkPolicy si self-host ⑥ évals golden set ⑦ dashboard Grafana (latence/erreurs) ⑧ runbook connecteur ⑨ annonce utilisateurs + doc d'usage.

**Point de vigilance récurrent :** ce n'est jamais le MCP qui coûte du temps, c'est l'OAuth du provider (refresh tokens rotatifs Atlassian, OBO Microsoft, granularité des scopes GitHub). Documenter chaque spécificité dans la checklist au fil de l'eau.

---

## 15. Automatisations & Crons — Trigger.dev

### 15.1 Pourquoi Trigger.dev (et pas un scheduler maison)

| Besoin | Ce que Trigger.dev v4 apporte |
|---|---|
| Crons dynamiques multi-tenant | Schedules **impératifs** créés à la volée par API (`schedules.create`) avec `externalId` (= notre `job_id`) et `deduplicationKey` (update au lieu de doublon) — exactement le modèle "un schedule par utilisateur/job" |
| Fuseaux horaires | Timezone IANA par schedule, passage heure d'été/hiver géré automatiquement |
| Durabilité | Retries configurables, checkpointing, pas de timeout d'exécution, files et concurrence par queue |
| Exploitation | Dashboard complet (runs, traces, replay), environnements DEV/STAGING/PROD séparés |
| Souveraineté | **Self-hosted** : image Docker officielle + chart Helm Kubernetes — aucune donnée ne sort de notre infra |
| Jobs internes | Les schedules **déclaratifs** (cron dans le code, versionné Git) couvrent nos jobs de plateforme |

Convention adoptée (alignée sur les recommandations Trigger.dev) : **déclaratif pour les jobs internes** (versionnés dans le code), **impératif pour les crons des utilisateurs** (créés dynamiquement par le Scheduler MCP).

### 15.2 Architecture du sous-système

```
        Agent (sandbox)                    Utilisateur (Web/Slack)
              │ scheduler.create_cron            │ PATCH /api/v1/automations/{id}
              ▼                                  ▼
        MCP Gateway ──────────────► AUTOMATION SERVICE (TypeScript)
        (AuthZ+quotas)              │  - API interne jobs (gRPC/REST)
                                    │  - définitions de tâches Trigger.dev
                                    │  - table scheduled_jobs (Postgres)
                                    │
                    ┌───────────────┼────────────────┐
                    ▼               ▼                ▼
             schedules.create  schedules.update  schedules.del / deactivate
                    │
                    ▼
        ┌──────────────────────────────────────────────┐
        │       TRIGGER.DEV v4 (self-hosted)           │
        │  webapp + supervisor + workers (Helm)        │
        │  Postgres dédié + Redis + ClickHouse (runs)  │
        │                                              │
        │  Tâches déployées (automation-service):      │
        │  • agent-scheduled-run   (impératif, users)  │
        │  • memory-extraction     (déclaratif)        │
        │  • volume-snapshot       (déclaratif, 03:00) │
        │  • usage-rollup          (déclaratif, 00:10) │
        │  • oauth-refresh-sweep   (déclaratif, */6h)  │
        │  • sandbox-reaper        (déclaratif, */30m) │
        │  • user-erasure          (à la demande)      │
        │  • audit-export-worm     (déclaratif, 01:00) │
        └───────────────────┬──────────────────────────┘
                            │ fire: payload {scheduleId, externalId=job_id,
                            │        timestamp, timezone, upcoming[]}
                            ▼
                 agent-scheduled-run (worker Trigger.dev)
                            │ 1. charge le job (Postgres), vérifie: active,
                            │    user actif, budget mensuel org, kill-switch
                            │ 2. POST /internal/scheduled-runs (mTLS,
                            │    Idempotency-Key = job_id + timestamp)
                            ▼
                 BACKEND CORE → InboundMessage {channel: "scheduler"}
                            ▼
              PIPELINE NORMAL (Prompt Layer → Orchestrator → Sandbox)
                            │ permissions/guardrails ré-évalués MAINTENANT
                            ▼
                 Résultat → delivery (DM Teams / Slack / email / webhook)
                            │
                            ▼
                 scheduled_runs (statut, coût, résumé) + audit_log
```

**Décision structurante :** le worker Trigger.dev ne fait **aucun travail d'agent** lui-même. Il est un déclencheur durable qui ré-injecte le job dans le pipeline standard, puis attend le verdict (souscription à `agent.events` via NATS ou polling de `scheduled_runs`, timeout = `per_run_budget.max_seconds` + marge). Ainsi :
- les retries Trigger.dev couvrent uniquement les **échecs d'infrastructure** (backend injoignable, file saturée) — backoff exponentiel, 3 tentatives ;
- les **échecs d'agent** (permission révoquée, guardrail, budget, erreur d'outil) ne sont *pas* retryés aveuglément : ils sont enregistrés comme run `failed` et comptent pour l'auto-pause.

### 15.3 Code de la tâche pivot (extrait, `@trigger.dev/sdk`)

```ts
// services/automation-service/trigger/agent-scheduled-run.ts
import { schedules } from "@trigger.dev/sdk";
import { loadJob, recordRun, submitScheduledRun, waitForVerdict } from "../lib";

export const agentScheduledRun = schedules.task({
  id: "agent-scheduled-run",
  retry: { maxAttempts: 3, factor: 2, minTimeoutInMs: 30_000 }, // infra only
  run: async (payload) => {
    const job = await loadJob(payload.externalId!);            // job_id
    if (!job || job.status !== "active") return { skipped: true };

    const gate = await preflight(job);   // user actif ? budget org ? kill-switch ?
    if (!gate.ok) { await pauseJob(job, gate.reason); return gate; }

    const idem = `${job.id}:${payload.timestamp.toISOString()}`;
    const { run_id } = await submitScheduledRun(job, idem);    // POST /internal/...

    const verdict = await waitForVerdict(run_id, job.budget.max_seconds + 60);
    await recordRun(job, run_id, verdict);                     // scheduled_runs

    if (verdict.status === "failed") {
      const failures = await bumpFailureCount(job);
      if (failures >= 3) await pauseJob(job, "consecutive_failures");
      if (isInfraError(verdict.code)) throw new Error(verdict.code); // → retry
    }
    return verdict;
  },
});
```

Création d'un cron par le Scheduler MCP :

```ts
await schedules.create({
  task: agentScheduledRun.id,
  cron: job.cron,                       // "0 9 * * 1"
  timezone: job.timezone,               // "Europe/Paris" — DST auto
  externalId: job.id,                   // job_01H...
  deduplicationKey: job.id,             // update idempotent si re-création
});
```

### 15.4 Cycle de vie d'un job

```
             create_cron (agent)          approbation user (carte)
DRAFT ────────────────────────► PENDING_APPROVAL ────────────► ACTIVE
                                        │ refus                   │
                                        ▼                         │ pause (user/agent/
                                     DELETED                      │  3 échecs/politique)
                                                                  ▼
                          resume ◄────────────────────────── PAUSED
                          (re-vérification quotas+politique)      │ delete
                                                                  ▼
                                                               DELETED
                                                    (schedules.del côté Trigger.dev,
                                                     historique des runs conservé 90 j)
```

Version rendue :

```mermaid
stateDiagram-v2
    [*] --> DRAFT
    DRAFT --> PENDING_APPROVAL : create_cron (agent)
    PENDING_APPROVAL --> ACTIVE : approbation utilisateur
    PENDING_APPROVAL --> DELETED : refus
    ACTIVE --> PAUSED : pause (user · 3 échecs · politique · offboarding)
    PAUSED --> ACTIVE : resume (re-vérification quotas + politique)
    ACTIVE --> DELETED : delete
    PAUSED --> DELETED : delete
    DELETED --> [*] : schedules.del — historique conservé 90 j
```

### 15.5 Notifications & delivery

- Chaque run produit un **récap** : statut, actions effectuées, liens (PRs créées, fichiers), coût, durée.
- Delivery : DM Teams proactif (conversationReference stockée), DM Slack, email (template), ou webhook signé (HMAC) vers un système tiers.
- Politique anti-bruit : si un job en succès n'a "rien à signaler" (l'agent le déclare via un marqueur `no_op`), le message peut être supprimé ou regroupé dans un digest quotidien (préférence par job).
- Échecs : notification immédiate avec le code d'erreur lisible + bouton "Mettre en pause" / "Réessayer maintenant".

### 15.6 Sécurité spécifique aux automatisations

| Risque | Contre-mesure |
|---|---|
| Cron = persistance pour un attaquant (prompt malveillant qui "se ré-exécute") | Création en `require_approval` ; prompt du job **immuable et versionné** (toute édition ⇒ nouvelle approbation) ; re-scan guardrails à chaque run |
| Escalade différée (droits élargis après création) | Permissions calculées **au feu**, jamais stockées ; `pre_approved_tools` restreint à des outils nommés, re-présenté à chaque édition |
| Utilisateur parti de l'entreprise | `preflight` vérifie le statut user (sync SCIM avec l'IdP) → jobs auto-pausés à l'offboarding, purge avec `user-erasure` |
| Emballement de coûts | Budget par run + budget mensuel par job + plafond org ; auto-pause à 3 échecs consécutifs ; kill-switch global (flag `automations.enabled` par org) |
| Tempête de crons (thundering herd à 9h00) | Jitter aléatoire 0-120 s injecté par l'automation-service ; classes de priorité orchestrator (interactif > planifié) ; concurrence par queue Trigger.dev |
| Exfiltration via delivery | `delivery.target` ∈ cibles de l'utilisateur uniquement ; webhooks sortants signés + allow-list de domaines org |
| Rejeu / double exécution | Idempotency-Key = `job_id + timestamp` de bout en bout ; déduplication Redis 24 h côté backend |

### 15.7 Jobs internes de plateforme (consolidation)

Trigger.dev remplace tous les crons ad hoc de la plateforme — un seul endroit pour opérer, tracer et rejouer les jobs :

| Job (déclaratif) | Cron | Rôle |
|---|---|---|
| `memory-extraction` | à la demande (trigger post-tour) | Extraction de mémoires long terme |
| `volume-snapshot` | `0 3 * * *` | Snapshots S3 des volumes workspace |
| `usage-rollup` | `10 0 * * *` | Agrégats `usage_daily` (facturation) |
| `oauth-refresh-sweep` | `0 */6 * * *` | Refresh proactif des tokens expirant < 24 h |
| `sandbox-reaper` | `*/30 * * * *` | Hibernation des sandboxes IDLE, destruction > 30 j |
| `audit-export-worm` | `0 1 * * *` | Export audit → S3 object-lock (WORM) |
| `user-erasure` | à la demande | Purge RGPD (messages, mémoires, volumes, tokens, jobs) |
| `dlq-redrive` | `*/15 * * * *` | Rejeu automatique des DLQ NATS avec backoff ; alerte si échec persistant |
| `cert-expiry-check` | `0 7 * * *` | Inventaire certificats/secrets/apps OAuth expirant < 30 j → digest ops |
| `pool-warmer` | `*/5 * * * *` | Regonfle le pool chaud de sandboxes sous le seuil cible |
| `memory-consolidation` | `0 4 * * 0` | Fusion des doublons mémoire, clôture des contradictions (entity_facts), décroissance, compaction des notes workspace (§9.1.3) |

### 15.8 Automatisations événementielles (v2 produit)

Le sous-système ci-dessus est **time-driven** ; le complément le plus demandé après les crons est **event-driven** : *"quand une PR est ouverte sur ce repo, review-la"*, *"quand un ticket P1 arrive, brief-moi"*. L'architecture l'absorbe sans nouveau chemin de sécurité :

```
GitHub App / Sentry / Slack (webhooks sortants)
        │ signature vérifiée (HMAC / JWT, anti-rejeu 5 min)
        ▼
webhook-ingress (nouveau service, stateless)
        │ matching des event_triggers actifs (pattern sur type + payload)
        │ dédup par delivery_id · debounce configurable (ex. 60 s par PR)
        ▼
InboundMessage { channel: "webhook", channel_ref: { trigger_id, delivery_id } }
        ▼
PIPELINE NORMAL — guardrails, permissions AU FEU, budgets, audit (identique aux crons)
```

```sql
CREATE TABLE event_triggers (
  id             TEXT PRIMARY KEY,          -- trg_01H...
  user_id        TEXT NOT NULL REFERENCES users(id),   -- ou propriété org en Mode B
  org_id         TEXT NOT NULL REFERENCES orgs(id),
  source         TEXT NOT NULL,             -- github|sentry|slack|jira...
  event_pattern  JSONB NOT NULL,            -- {type:"pull_request.opened", repo:"acme/checkout"}
  prompt         TEXT NOT NULL,             -- snapshot immuable versionné (comme les crons)
  delivery       JSONB NOT NULL,
  per_run_budget JSONB NOT NULL,
  status         TEXT NOT NULL DEFAULT 'pending_approval',
  debounce_s     INT NOT NULL DEFAULT 0,
  created_at     TIMESTAMPTZ DEFAULT now()
);
```

Règles héritées du modèle crons, inchangées : création via un outil `scheduler.create_trigger` en `require_approval` ; permissions et guardrails **ré-évalués à chaque événement** ; quotas (20 triggers actifs/user) et budget par run ; auto-pause à 3 échecs. Deux garde-fous propres à l'événementiel : **contrôle de tempête** (rate limit par trigger, ex. 10 déclenchements/h, au-delà → digest + pause proposée) et **payload traité comme `<untrusted>`** dans le contexte — un titre de PR est une surface d'injection de prompt, les guardrails d'entrée s'appliquent au payload lui-même. Le webhook-ingress s'appuie sur Trigger.dev pour la durabilité (retries d'infra, replay).

---

# PARTIE IV — DONNÉES, SÉCURITÉ & FLUX

*Le modèle de données, le modèle de menaces et les séquences de bout en bout.*

---

## 16. Données & Persistance

### 16.1 Schéma Postgres (extrait DDL)

```sql
CREATE TABLE orgs (
  id            TEXT PRIMARY KEY,          -- org_acme
  name          TEXT NOT NULL,
  plan          TEXT NOT NULL DEFAULT 'standard',
  settings      JSONB NOT NULL DEFAULT '{}',  -- guardrails, modèles, automations...
  created_at    TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE users (
  id            TEXT PRIMARY KEY,          -- usr_7f3a...
  org_id        TEXT REFERENCES orgs(id),
  email         CITEXT UNIQUE NOT NULL,
  display_name  TEXT,
  role          TEXT NOT NULL DEFAULT 'member',  -- member|power_user|admin
  status        TEXT NOT NULL DEFAULT 'active',  -- active|suspended|offboarded (SCIM)
  created_at    TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE identities (                  -- mapping canaux → user canonique
  user_id       TEXT REFERENCES users(id),
  provider      TEXT NOT NULL,             -- entra|slack|web
  external_id   TEXT NOT NULL,             -- aadObjectId | slack_user_id
  PRIMARY KEY (provider, external_id)
);

CREATE TABLE conversations (
  id            TEXT PRIMARY KEY,
  user_id       TEXT REFERENCES users(id),
  channel       TEXT NOT NULL,             -- teams|slack|web|scheduler
  title         TEXT,
  status        TEXT NOT NULL DEFAULT 'active',
  created_at    TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE messages (
  id              TEXT PRIMARY KEY,
  conversation_id TEXT REFERENCES conversations(id),
  role            TEXT NOT NULL,           -- user|assistant|tool|system
  content         JSONB NOT NULL,
  tokens_in       INT, tokens_out INT, cost_usd NUMERIC(10,5),
  created_at      TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX ON messages (conversation_id, created_at);

CREATE TABLE memories (
  id          TEXT PRIMARY KEY,
  user_id     TEXT REFERENCES users(id),
  content     TEXT NOT NULL,
  embedding   VECTOR(1024),
  source_msg  TEXT,
  created_at  TIMESTAMPTZ DEFAULT now(),
  expires_at  TIMESTAMPTZ
);
CREATE INDEX ON memories USING hnsw (embedding vector_cosine_ops);
-- + tables entities / entity_facts (mémoire d'entités temporelle) — DDL complet en §9.1.2

CREATE TABLE oauth_tokens (
  user_id       TEXT REFERENCES users(id),
  provider      TEXT NOT NULL,             -- github|notion|msgraph|slack
  access_token  BYTEA NOT NULL,            -- chiffré AES-256-GCM (clé Vault)
  refresh_token BYTEA,
  scopes        TEXT[],
  expires_at    TIMESTAMPTZ,
  PRIMARY KEY (user_id, provider)
);

CREATE TABLE tool_policies (
  org_id         TEXT REFERENCES orgs(id),
  role           TEXT NOT NULL,
  tool_pattern   TEXT NOT NULL,            -- ex: 'scheduler.create_cron'
  effect         TEXT NOT NULL,            -- allow|deny|require_approval
  approver_group TEXT,                     -- mode équipe (§3.3) : NULL = le demandeur approuve
  PRIMARY KEY (org_id, role, tool_pattern)
);

-- ============ v2 : AUTOMATISATIONS ============

CREATE TABLE scheduled_jobs (
  id                    TEXT PRIMARY KEY,          -- job_01H...
  user_id               TEXT NOT NULL REFERENCES users(id),
  org_id                TEXT NOT NULL REFERENCES orgs(id),
  name                  TEXT NOT NULL,
  prompt                TEXT NOT NULL,             -- snapshot immuable
  prompt_version        INT NOT NULL DEFAULT 1,    -- +1 à chaque édition approuvée
  agent_profile         TEXT NOT NULL DEFAULT 'generalist',
  cron                  TEXT NOT NULL,             -- "0 9 * * 1" (pas de secondes)
  timezone              TEXT NOT NULL DEFAULT 'UTC',
  delivery              JSONB NOT NULL,            -- {channel, target}
  per_run_budget        JSONB NOT NULL,            -- {max_cost_usd, max_seconds}
  monthly_budget_usd    NUMERIC(10,2),
  on_approval_needed    TEXT NOT NULL DEFAULT 'fail_fast',  -- |use_pre_approved
  pre_approved_tools    TEXT[] NOT NULL DEFAULT '{}',
  job_memory            JSONB NOT NULL DEFAULT '{}',  -- état persistant entre runs (§9.1)
  trigger_schedule_id   TEXT,                      -- ID côté Trigger.dev
  status                TEXT NOT NULL DEFAULT 'pending_approval',
                        -- draft|pending_approval|active|paused|deleted
  pause_reason          TEXT,
  consecutive_failures  INT NOT NULL DEFAULT 0,
  created_by            TEXT NOT NULL,             -- 'agent' | 'user'
  approved_by           TEXT REFERENCES users(id),
  next_run_at           TIMESTAMPTZ,
  last_run_at           TIMESTAMPTZ,
  created_at            TIMESTAMPTZ DEFAULT now(),
  updated_at            TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX ON scheduled_jobs (user_id, status);
CREATE INDEX ON scheduled_jobs (org_id, status);

CREATE TABLE scheduled_runs (
  id              TEXT PRIMARY KEY,          -- srun_01H...
  job_id          TEXT NOT NULL REFERENCES scheduled_jobs(id),
  trigger_run_id  TEXT,                      -- corrélation dashboard Trigger.dev
  conversation_id TEXT,                      -- conversation créée pour ce run
  scheduled_for   TIMESTAMPTZ NOT NULL,
  started_at      TIMESTAMPTZ, finished_at TIMESTAMPTZ,
  status          TEXT NOT NULL,             -- queued|running|success|failed|skipped
  error_code      TEXT,                      -- taxonomie §21
  cost_usd        NUMERIC(10,5),
  output_summary  TEXT,
  UNIQUE (job_id, scheduled_for)             -- idempotence naturelle
);
CREATE INDEX ON scheduled_runs (job_id, scheduled_for DESC);

-- ==============================================

CREATE TABLE sandboxes (
  user_id     TEXT PRIMARY KEY REFERENCES users(id),
  node        TEXT, container_id TEXT,
  state       TEXT NOT NULL,
  volume_id   TEXT NOT NULL,
  last_active TIMESTAMPTZ
);

CREATE TABLE audit_log (                   -- append-only, partitionné par mois
  id          BIGINT GENERATED ALWAYS AS IDENTITY,
  ts          TIMESTAMPTZ NOT NULL DEFAULT now(),
  user_id     TEXT, org_id TEXT,
  actor       TEXT NOT NULL,               -- agent|user|admin|system|scheduler
  action      TEXT NOT NULL,               -- tool.call|cron.created|cron.run|...
  target      TEXT,
  details     JSONB,
  PRIMARY KEY (ts, id)
) PARTITION BY RANGE (ts);

CREATE TABLE usage_daily (
  day DATE, org_id TEXT, user_id TEXT, model TEXT,
  origin TEXT NOT NULL DEFAULT 'interactive',   -- interactive|scheduled
  tokens_in BIGINT, tokens_out BIGINT, cost_usd NUMERIC(12,4),
  tool_calls INT, sandbox_seconds INT,
  PRIMARY KEY (day, org_id, user_id, model, origin)
);
```

### 16.2 Autres stockages

| Stockage | Usage |
|---|---|
| **Redis** | Fenêtres de mémoire courte, sessions, verrous (refresh OAuth), appels en attente d'approbation, rate limiting, déduplication d'événements |
| **NATS JetStream** | Bus d'événements (messages entrants, AgentEvents, commandes orchestrator, lifecycle automations) avec replay |
| **S3 / Blob** | Pièces jointes, fichiers générés (URLs signées 15 min), snapshots de volumes, exports d'audit WORM |
| **pgvector** | Mémoire long terme + (option) index RAG documentaire par org |
| **Trigger.dev (stack dédiée)** | Postgres + Redis + ClickHouse propres à Trigger.dev (Helm) — état des schedules, runs, traces. Isolé de notre Postgres applicatif : la table `scheduled_jobs` reste **notre** source de vérité métier, Trigger.dev est le moteur d'exécution |

### 16.3 Volumétrie, partitionnement & exploitation

Dimensionnement à la cible v1 (5 000 utilisateurs, 1 500 actifs/jour, 2 000 crons) :

| Table | Débit | Volume annuel | Stratégie |
|---|---|---|---|
| `messages` | ~40 k lignes/j (user+assistant+tool) | ~15 M lignes, 20-30 Go (JSONB) | Index `(conversation_id, created_at)` ; rétention 90 j par défaut → purge par lot nocturne ; pas de partition nécessaire à cette échelle |
| `audit_log` | ~300 k lignes/j (≈ 40 tool calls × 6-7 k tours) | ~110 M lignes | **Partitionné par mois** ; partitions > rétention **détachées** puis archivées S3 (WORM) — jamais de DELETE massif |
| `memories` | ~50/utilisateur | ~250 k vecteurs | HNSW `m=16, ef_construction=64` — trivial à cette échelle ; re-création d'index seulement si > 10 % de lignes mortes |
| `scheduled_runs` | ~6 k/j | ~2,2 M lignes | Rétention 90 j, purge par `job_id` lors des suppressions |
| `usage_daily` | ~5 k lignes/j (agrégats) | ~2 M lignes | Conservé long terme (facturation) |

Réglages d'exploitation :
- **Autovacuum** agressif sur `messages` et `scheduled_runs` (`autovacuum_vacuum_scale_factor = 0.02`), `fillfactor = 90` sur les tables à updates (`sandboxes`, `scheduled_jobs`).
- **Migrations expand/contract** : toute migration est additive dans la release N (nouvelle colonne nullable, double écriture), le nettoyage (`DROP`, `NOT NULL`) n'arrive qu'en N+1 une fois l'ancien code retiré. Lint Atlas en CI : une migration destructive dans la même release = échec du pipeline.
- **PITR** : WAL archivés en continu (RPO 15 min), restauration testée trimestriellement (§24.9).
- Connexions : PgBouncer en transaction pooling devant Postgres (les services FastAPI/Go sont nombreux et bavards).

---

## 17. Sécurité

### 17.1 Chaîne d'identité

```
Teams aadObjectId ─┐
Slack user_id ─────┼─► identities → user_id canonique
Web OIDC sub ──────┘
        │
        ▼
JWT session (15 min, ES256, aud=api)            ← utilisé Web/adapters → API
        │  Prompt Layer : calcule allowed_tools
        ▼
TASK JWT (15 min, ES256, aud=mcp-gateway)       ← seul secret dans le sandbox
  claims: {sub:user_id, org, task_id, origin, job_id?, allowed_tools[],
           approval_tools[], budget}
        │
        ▼
MCP Gateway : re-validation + injection token OAuth provider (jamais exposé)

RUNS PLANIFIÉS : aucune identité stockée dans Trigger.dev — le payload ne
contient que job_id. Le TASK JWT est frappé à chaud par le Prompt Layer au
moment du run, après re-vérification du statut utilisateur (SCIM) et des
permissions courantes.
```

### 17.2 Menaces principales & contre-mesures

| Menace | Contre-mesure |
|---|---|
| Prompt injection via page web / mail / fichier | Guardrails d'entrée ; contenu externe balisé `<untrusted>` dans le contexte ; outils d'écriture en `require_approval` par défaut |
| **Persistance malveillante via cron** | Voir §15.6 : approbation à la création, prompt immuable versionné, re-scan à chaque run, permissions au feu |
| Évasion de sandbox | gVisor + rootless + cap-drop ALL + seccomp + read-only FS ; images signées et scannées ; hôtes sandbox dédiés, séparés du control plane |
| Exfiltration de secrets | Aucun secret dans le sandbox ; egress limité à la Gateway ; DLP sur sorties d'outils et réponses agent |
| Vol de token OAuth | Chiffrement au repos (Vault/KMS), tokens jamais loggés, rotation, scopes minimaux, refresh proactif |
| Abus inter-utilisateurs | Isolation stricte 1 sandbox = 1 user ; toutes les requêtes MCP portent le user_id signé ; le Scheduler MCP impose owner = sub du JWT ; volumes distincts |
| SSRF via Browser MCP / webhooks de delivery | Blocage RFC1918 + metadata endpoints, allow-list de domaines par org, DNS pinning, webhooks sortants signés HMAC |
| Déni de service | Rate limiting multi-niveaux, quotas de sandboxes et de jobs, budgets par tour et par run, jitter sur les crons, circuit breakers |
| Rejeu / falsification (webhooks entrants, événements bus) | Signatures Slack/Bot Framework vérifiées, fenêtre anti-rejeu 5 min ; NATS avec comptes + TLS ; JWT vérifiés à chaque frontière (zero-trust interne) |
| **Malware via pièces jointes** | **Scan antivirus (ClamAV) à l'upload, avant mise à disposition S3/sandbox** — les fichiers utilisateurs finissent dans un environnement qui exécute du code ; fichier bloqué → `E_GUARD_INPUT_BLOCKED` + notification |

### 17.3 Conformité

- Audit log append-only exporté quotidiennement (job `audit-export-worm`, S3 object-lock).
- Rétention configurable par org (conversations 90 j par défaut ; runs planifiés 90 j) ; RGPD : job `user-erasure` purge messages, mémoires, volumes, tokens **et scheduled_jobs/runs**.
- Chiffrement TLS 1.3 partout, mTLS sur sandbox→gateway, gateway→serveurs MCP et automation-service→backend.
- Résidence des données : déploiement par région (EU-only possible) ; Trigger.dev self-hosted ⇒ aucune métadonnée de job ne quitte l'infra ; aucun log de contenu chez les fournisseurs LLM (options no-retention).

### 17.4 Matrice de flux réseau (zero-trust interne)

Tout flux absent de cette matrice est **refusé** par NetworkPolicy. Colonne AuthN = ce que la destination vérifie.

| # | Source | Destination | Port/Proto | AuthN | Chiffrement |
|---|---|---|---|---|---|
| 1 | Internet | API Gateway | 443/HTTPS | JWT session (JWKS) | TLS 1.3 |
| 2 | Teams/Slack (webhooks) | adapters (via Gateway) | 443/HTTPS | Signature Bot Framework / HMAC Slack | TLS 1.3 |
| 3 | API Gateway | backend-core | 8000/HTTP2 | JWT propagé + réseau ingress→core | mTLS (mesh) |
| 4 | backend-core / prompt-layer / orchestrator / automation-service | NATS | 4222 | Comptes NATS + NKeys | TLS |
| 5 | prompt-layer | orchestrator | 9090/gRPC | Service token interne | mTLS |
| 6 | orchestrator | API OpenCode des sandboxes | 4096/HTTP | Réseau sandbox privé (init par l'orchestrator uniquement) | TLS interne |
| 7 | **sandboxes** | **mcp-gateway** | **8443/HTTPS** | **TASK JWT (ES256)** | **mTLS** — *seule sortie autorisée du ns sandboxes* |
| 8 | sandboxes (via OpenCode) | llm-proxy | 4000/HTTP | Token de tour (proxy vérifie task_id/budget) | mTLS |
| 9 | mcp-gateway | serveurs MCP (ns mcp) | 3000/HTTP | Service token + réseau | mTLS |
| 10 | mcp-gateway | Vault | 8200/HTTPS | AppRole + policies | TLS |
| 11 | serveurs MCP | APIs externes (GitHub, Graph…) | 443/HTTPS | Tokens injectés par la Gateway | TLS 1.3 |
| 12 | workers Trigger.dev | backend-core `/internal/scheduled-runs` | 8000 | mTLS + service token dédié — **aucune autre route** | mTLS |
| 13 | automation-service | Trigger.dev webapp API | 3040/HTTPS | Clé API projet (par env) | TLS |
| 14 | tous les services | OTel collector | 4317/gRPC | Réseau observabilité | TLS |
| 15 | llm-proxy | fournisseur LLM | 443/HTTPS | Clé API (Vault) | TLS 1.3 |

Interdits notables, vérifiés par tests réseau automatisés en CI d'infra : sandboxes → Internet, sandboxes → Postgres/Redis, serveurs MCP → Vault, Trigger.dev → sandboxes ou MCP.

### 17.5 Réponse à incident de sécurité (breach)

Un produit qui détient les tokens OAuth d'une entreprise doit avoir ce processus **écrit, outillé et exercé** — pas improvisé le jour J.

| Phase | Actions | Délai cible |
|---|---|---|
| **Détection** | Signaux : anomalies d'audit (volume/horaires/outils inhabituels), canary tokens dans Vault, alertes DLP répétées, échecs d'AuthN en rafale | Alerte page immédiate |
| **Confinement** | Dans l'ordre : kill-switch automations org(s) concernée(s) → révocation des `jti` suspects (blocklist §13.4) → rotation d'urgence des clés TASK JWT → rotation/révocation des tokens OAuth potentiellement exposés (Vault) → isolation des sandboxes suspects (`platctl sandbox kill`) | **< 1 h** |
| **Investigation** | Forensics sur l'audit WORM (immuable par construction) : périmètre exact — quels users, quels outils, quelles données ; snapshot des volumes concernés préservé | < 24 h |
| **Notification** | **RGPD : autorité de contrôle sous 72 h** si données personnelles affectées ; clients concernés sans délai injustifié (template pré-rédigé : périmètre, actions, recommandations) ; transparence sur la page de statut | 72 h max |
| **Post-mortem** | Sans blâme, 5 pourquoi, actions correctives trackées ; mise à jour des runbooks et du corpus de détection | < 1 sem. |

Exercice **tabletop semestriel** (scénario : token GitHub org exfiltré via injection) — la checklist go-live (Annexe D) exige un premier exercice avant l'ouverture commerciale. Contacts pré-établis : CERT tunisien (tunCERT) / autorité de protection des données selon la juridiction du client.

---

## 18. Flux de bout en bout

### 18.1 "Déploie la branche fix/login sur staging" (depuis Teams)

```
 1. User → Teams → teams-adapter : Activity reçue (JWT Bot Framework validé)
 2. adapter : aadObjectId → usr_7f3a ; construit InboundMessage ; publie NATS inbound.messages
 3. prompt-layer : mémoire (top-k) + classification task_agentique + plan (4 étapes)
    + permissions (github.* allow, github.merge_pr require_approval) + routing (profil dev,
    modèle frontier) → AgentTask + TASK_JWT → gRPC SubmitTask(orchestrator)
 4. orchestrator : sandbox usr_7f3a en état IDLE → réveil (200 ms) ; injecte TASK_JWT ;
    pousse le tour à OpenCode
 5. OpenCode : liste les outils via MCP Gateway (voit uniquement les outils autorisés) ;
    exécute le plan ; streame les événements
 6. Chaque tool call : Gateway → AuthZ → token GitHub usr_7f3a (Vault) → GitHub MCP → API
 7. Arrive à github.merge_pr → require_approval → agent.approval.needed
    → Adaptive Card "Merger PR #42 vers staging ? [Approuver][Refuser]"
 8. User approuve → POST /approve → Gateway reprend l'appel → merge OK
 9. Agent conclut ; guardrails sortie OK ; agent.done {coût: $0.31}
10. teams-adapter met à jour le message final ; usage_daily incrémenté ;
    job Trigger.dev memory-extraction déclenché
```

Séquence rendue :

```mermaid
sequenceDiagram
    autonumber
    actor U as Utilisateur (Teams)
    participant AD as teams-adapter
    participant PL as Prompt Layer
    participant OR as Orchestrator
    participant SB as Sandbox OpenCode
    participant MG as MCP Gateway
    participant GH as GitHub API
    U->>AD: "Déploie fix/login sur staging"
    AD->>PL: InboundMessage (identité résolue)
    PL->>OR: AgentTask + TASK JWT (allowed_tools signés)
    OR->>SB: réveil < 500 ms + tour
    SB->>MG: github.create_pr
    MG->>GH: token OAuth de l'utilisateur (Vault)
    SB->>MG: github.merge_pr (require_approval)
    MG-->>U: Adaptive Card — Approuver le merge ?
    U-->>MG: Approuver ✅
    MG->>GH: merge PR #42
    SB-->>U: récap final + coût ($0,31) + audit
```

### 18.2 Création d'un cron par l'agent (v2)

```
 1. User (Slack) : "Chaque matin à 8h30, regarde mes mails Outlook non lus importants
    et fais-moi un brief ici."
 2. prompt-layer : détecte l'intention d'automatisation → plan : [préciser périmètre,
    proposer le cron, créer via scheduler.create_cron, confirmer]
 3. Agent : convertit "chaque matin à 8h30" → cron "30 8 * * *" tz Europe/Paris ;
    répond avec les 3 prochaines occurrences et le budget estimé (~$0.15/run) ;
    demande confirmation du périmètre ("uniquement les non lus marqués importants ?")
 4. User confirme → agent appelle scheduler.create_cron {...}
 5. MCP Gateway : scheduler.create_cron ∈ approval_tools → agent.approval.needed
    → carte Block Kit : "🕗 Nouveau cron : Brief mails — Chaque jour à 08:30
       (Europe/Paris) — Budget $0.15/run — Livraison : ce DM  [Approuver][Refuser]"
 6. User approuve → Scheduler MCP → automation-service :
    a. INSERT scheduled_jobs (status active, approved_by=usr_7f3a)
    b. schedules.create({task:"agent-scheduled-run", cron, timezone,
       externalId: job_id, deduplicationKey: job_id})
 7. agent.cron.created → l'agent conclut : "C'est en place ✅ Premier brief demain
    08:30. Gérable à tout moment via /agent crons ou la page Automatisations."
 8. audit_log : {actor: user, action: cron.approved, target: job_01H...}
```

### 18.3 Exécution nocturne d'un cron (v2)

```
 1. 06:30 UTC : Trigger.dev fire agent-scheduled-run (externalId=job_01H, + jitter 43s)
 2. Worker : loadJob → active ✓ ; preflight : user actif (SCIM) ✓, budget mensuel ✓,
    kill-switch org ✓
 3. POST /internal/scheduled-runs (mTLS, Idempotency-Key job_01H:2026-07-14T06:30Z)
 4. backend-core : crée conversation (channel=scheduler) + InboundMessage(prompt v3 du job)
 5. prompt-layer : guardrails re-scan du prompt ✓ ; permissions AU FEU : msgraph.read_mail
    toujours allow ✓ ; budget du job appliqué ; TASK_JWT frappé (origin=scheduled)
 6. orchestrator : classe de priorité basse ; sandbox HIBERNATED → réveil complet (4 s)
 7. Agent lit les mails via M365 MCP (token OBO rafraîchi la veille par oauth-refresh-sweep),
    rédige le brief
 8. Delivery : DM Slack proactif avec le brief ; agent.done {coût $0.11}
 9. Worker : waitForVerdict → success ; UPDATE scheduled_runs ; failures=0
10. Dashboard Trigger.dev : run vert, trace complète corrélée (trace_id partagé OTel)

Variante échec : à l'étape 5, l'org a retiré msgraph.* aux members →
E_PERM_REVOKED → run failed → notification "Votre brief quotidien est en pause :
l'accès Outlook a été retiré par votre organisation" → job PAUSED (pause_reason).
```

Séquence rendue :

```mermaid
sequenceDiagram
    autonumber
    participant TD as Trigger.dev
    participant W as Worker agent-scheduled-run
    participant BC as Backend Core
    participant PL as Prompt Layer
    participant OR as Orchestrator
    participant SB as Sandbox
    participant MG as MCP Gateway
    TD->>W: fire (externalId=job_id, jitter 0-120 s)
    W->>W: preflight — user actif ? budgets ? kill-switch ?
    W->>BC: POST /internal/scheduled-runs (mTLS · Idempotency-Key)
    BC->>PL: InboundMessage (channel=scheduler)
    PL->>PL: guardrails re-scan + permissions AU FEU + TASK JWT frappé
    PL->>OR: SubmitTask (priorité basse)
    OR->>SB: réveil + tour
    SB->>MG: tool calls (tokens rafraîchis la veille)
    SB-->>BC: agent.done ($0,11)
    BC-->>W: verdict success
    BC->>BC: delivery DM · scheduled_runs · audit
    W->>TD: run vert (3 échecs consécutifs = auto-pause)
```

### 18.4 Première connexion d'un outil

```
Agent appelle notion.search → Gateway : pas de token → E_CONN_NEEDS_CONNECTION
→ Agent : "Je n'ai pas accès à votre Notion. Connectez-le ici : <lien>"
→ User clique → OAuth Notion → callback → token chiffré stocké
→ User : "c'est fait, réessaie" → l'appel réussit.
```

---

# PARTIE V — QUALITÉ & EXPLOITATION

*Observer, tester, gérer les erreurs, déployer, tenir la charge — et administrer en solo.*

---

## 19. Observabilité

| Signal | Outil | Détails |
|---|---|---|
| **Traces** | OpenTelemetry → Tempo/Jaeger | 1 trace = 1 tour ; spans : adapter → prompt-layer (5 étages) → orchestrator → OpenCode → tool calls → serveurs MCP. Les runs planifiés démarrent leur trace dans le worker Trigger.dev (contexte OTel propagé) → corrélation dashboard Trigger.dev ↔ Tempo via `trigger_run_id` |
| **Métriques** | Prometheus + Grafana | Latence P50/P95 par étage, tours/min, sandboxes par état, coût LLM par org/h **ventilé interactive/scheduled**, taux d'erreur par outil MCP, files d'attente par classe de priorité, jobs actifs/pausés, précision de déclenchement des crons (scheduled_for vs started_at), tokens/s streaming |
| **Logs** | Loki (JSON structuré) | Jamais de contenu de conversation en clair dans les logs techniques ; `user_id` hashé hors audit |
| **Alerting** | Alertmanager → Slack/Teams ops | P95 tour > 60 s, taux d'échec outil > 5 %, pool chaud vide, budget org à 80 %, refresh OAuth en échec, **> 5 % de runs planifiés failed sur 1 h**, **retard de déclenchement > 120 s**, DLQ automation non vide |
| **Dashboards produit** | Grafana + usage_daily | Adoption par canal, outils les plus utilisés, coût par utilisateur, taux d'approbation/refus, **top automatisations par coût et par valeur (runs no_op vs utiles)** |
| **Dashboard Trigger.dev** | intégré (self-hosted) | Vue runs/schedules/replay pour l'équipe ops — accès SSO admin uniquement |

**Catalogue de métriques (noms canoniques, préfixe `plat_`) :**

```
plat_turn_first_token_seconds{channel,origin}      histogram   # SLO principal
plat_turn_total{channel,origin,status}             counter
plat_sandbox_wake_seconds{from_state}              histogram
plat_sandbox_pool_available                        gauge
plat_sandboxes{state}                              gauge
plat_mcp_tool_calls_total{tool,status}             counter
plat_mcp_gateway_latency_seconds{tool}             histogram
plat_llm_cost_usd_total{org,model,origin}          counter
plat_llm_cache_hit_ratio{org}                      gauge       # cible ≥ 0,75
plat_cron_fire_delay_seconds                       histogram   # scheduled_for → started_at
plat_scheduled_runs_total{status}                  counter
plat_approval_pending                              gauge
plat_nats_dlq_depth{subject}                       gauge
```

**Requêtes PromQL des SLO (Annexe A) :**

```promql
# P95 premier token (Web), fenêtre 5 min
histogram_quantile(0.95, sum(rate(plat_turn_first_token_seconds_bucket{channel="web"}[5m])) by (le))

# Taux d'échec des runs planifiés sur 1 h (alerte si > 0,05)
sum(rate(plat_scheduled_runs_total{status="failed"}[1h]))
  / sum(rate(plat_scheduled_runs_total[1h]))

# Retard de déclenchement des crons, P95 (alerte si > 120 s)
histogram_quantile(0.95, sum(rate(plat_cron_fire_delay_seconds_bucket[15m])) by (le))

# Burn rate du budget d'erreur dispo API (fenêtres 1 h / 6 h, multi-window multi-burn)
(1 - sum(rate(plat_turn_total{status="ok"}[1h])) / sum(rate(plat_turn_total[1h]))) / 0.001
```

---

## 20. Stratégie de tests & évals

### 20.1 Pyramide de tests classiques

| Niveau | Portée | Outillage |
|---|---|---|
| Unitaires | Chaque service (logique permissions, parsing cron, conversion NL→cron, budgets) | pytest / vitest / go test, couverture cible 80 % sur le code de décision |
| Contrats | Tous les schémas (`InboundMessage`, `AgentEvent`, `AgentTask`, outils MCP) | JSON Schema dans `packages/schemas`, validation croisée TS/Python en CI ; tests de compat ascendante (un consommateur vN doit lire vN-1) |
| Intégration | Pipeline complet sans LLM réel (LLM stub déterministe) | Testcontainers : Postgres + Redis + NATS + Trigger.dev dev ; scénarios : message→sandbox→tool→réponse, création+feu de cron accéléré |
| E2E | Web App + un sandbox réel en staging | Playwright ; parcours critiques : chat, approbation, connexion OAuth (mock provider), page Automatisations |
| Charge | 500 sandboxes, 2 000 msg/min, 1 000 crons/h en pointe | k6 + injecteur de schedules ; validation des SLO Annexe A |
| Chaos | Kill leader orchestrator, kill nœud NATS, Vault sealed, Trigger.dev worker down pendant une fenêtre de crons | Litmus/expériences manuelles ; critère : aucun run perdu (retries/replay), aucun doublon (idempotence) |

### 20.2 Évals d'agents (spécifique LLM)

- **Golden set** : ~150 tâches de référence versionnées (git) couvrant chaque serveur MCP + 20 scénarios de crons (création, modification, refus attendu).
- **Assertions programmatiques** : séquence d'outils appelés, arguments valides, respect des permissions (l'agent ne doit *jamais* tenter un outil hors `allowed_tools` plus de N fois), coût ≤ budget.
- **LLM-as-judge** pour la qualité rédactionnelle des récaps et briefs (score 1-5, seuil 4).
- **Suite adversariale** : corpus de ~500 prompts d'injection (dans pages web, mails, contenus de repos) — taux de compromission cible : 0 sur les actions d'écriture, alerte si > 1 % de fuites de comportement.
- **Gate CI** : toute modification de prompt système, de profil d'agent ou de version de modèle passe le golden set ; régression > 3 % = blocage du déploiement.
- **Registre des prompts** : les prompts systèmes et profils vivent dans `prompt_registry` (id, version, contenu, hash, actif, auteur) — modification = PR revue + gate d'évals, activation par flag, **rollback en une commande** (`platctl prompts rollback <id>`) ; le `prompt_version` utilisé est tracé sur chaque tour (corrélation qualité ↔ version).
- **Boucle feedback → évals** : les thumbs down et les refus d'approbation récurrents génèrent des candidats au golden set (revue humaine hebdo, §24.9) — le jeu d'évals grandit avec les vrais échecs du terrain, pas seulement avec les cas imaginés.

---

## 21. Taxonomie d'erreurs & contrats

Tout composant émet des erreurs de cette taxonomie ; le mapping vers un message utilisateur est centralisé dans les adaptateurs.

| Code | HTTP | Retry ? | Signification / message utilisateur |
|---|---|---|---|
| `E_AUTH_INVALID_TOKEN` | 401 | non | Session expirée → re-login silencieux |
| `E_PERM_TOOL_DENIED` | 403 | non | "Cet outil n'est pas autorisé par votre organisation" |
| `E_PERM_REVOKED` | 403 | non | Permission retirée depuis la création du cron → job pausé |
| `E_CONN_NEEDS_CONNECTION` | 424 | non | "Connectez d'abord <provider>" + deep-link |
| `E_CONN_TOKEN_EXPIRED` | 424 | auto (refresh) | Refresh transparent ; si refresh impossible → carte reconnexion |
| `E_TOOL_UPSTREAM_ERROR` | 502 | oui (expo, 3x) | API tierce en erreur ; circuit breaker au-delà |
| `E_TOOL_TIMEOUT` | 504 | oui (1x) | Outil > 60 s |
| `E_GUARD_INPUT_BLOCKED` | 422 | non | Contenu bloqué par la politique (motif catégorisé, jamais le détail du détecteur) |
| `E_GUARD_OUTPUT_REDACTED` | 200 | — | Réponse livrée avec masquage, signalé à l'utilisateur |
| `E_BUDGET_EXCEEDED` | 402 | non | Budget du tour/run atteint ; propose de relancer ou d'élargir (si politique OK) |
| `E_SANDBOX_UNAVAILABLE` | 503 | oui (queue) | File d'attente ; position communiquée |
| `E_SCHED_QUOTA_REACHED` | 409 | non | "Vous avez atteint 20 automatisations actives" |
| `E_SCHED_INVALID_CRON` | 422 | non | Expression invalide / intervalle < 15 min / quiet hours |
| `E_SCHED_JOB_PAUSED` | 409 | non | Run sauté car job pausé entre le feu et l'exécution |
| `E_RATE_LIMITED` | 429 | oui (après Retry-After) | — |
| `E_INTERNAL` | 500 | oui (idempotent only) | Erreur générique, trace_id fourni au support |

**Règles transverses :** toute écriture porte `Idempotency-Key` (dédup Redis 24 h) ; les retries automatiques ne s'appliquent qu'aux opérations idempotentes ; les événements bus sont livrés at-least-once → tous les consommateurs dédupliquent par `message_id`/`idempotency_key` ; DLQ NATS par sujet avec rejeu outillé.

---

## 22. Infrastructure & Déploiement

### 22.1 Topologie Kubernetes (production)

```
Cluster K8s (3 AZ)
├── ns: ingress          → Kong/Envoy, cert-manager
├── ns: core             → adapters (x3), backend-core (x3), prompt-layer (x3),
│                          llm-proxy (x2), auth-service (x2)
├── ns: orchestration    → orchestrator (x2, leader election), NATS (x3)
├── ns: sandboxes        → node pool DÉDIÉ (taint sandbox=true), RuntimeClass gVisor,
│                          NetworkPolicy: egress → mcp-gateway uniquement
├── ns: mcp              → mcp-gateway (x3), github-mcp (x2), m365-mcp (x2),
│                          browser-mcp (x4, pool Playwright), db-mcp (x2),
│                          notion-mcp, slack-mcp, scheduler-mcp (x2)
├── ns: automation       → automation-service (x2),
│                          Trigger.dev via chart Helm officiel :
│                            webapp (x2), supervisor, workers (HPA 2-10),
│                            postgres-trigger, redis-trigger, clickhouse (runs)
│                          NetworkPolicy: workers → backend-core:/internal uniquement
├── ns: data             → Postgres (CloudNativePG, 1 primary + 2 replicas),
│                          Redis (Sentinel), pgvector
└── ns: observability    → Prometheus, Grafana, Loki, Tempo, Alertmanager
```

- **IaC :** Terraform (VPC, cluster, KMS, S3, DNS) + Helm charts par service + ArgoCD (GitOps).
- **CI/CD :** GitHub Actions — lint/tests/contrats → évals agents (gate) → build images (SBOM + cosign) → scan Trivy → staging auto → prod via ArgoCD (approbation manuelle). Le déploiement de l'automation-service exécute `trigger deploy` (les schedules déclaratifs internes se synchronisent ; les schedules impératifs des users sont intouchés).
- **Environnements Trigger.dev :** DEV/STAGING/PROD séparés — un cron de staging ne peut pas viser la prod.

### 22.2 docker-compose (développement local)

```yaml
services:
  postgres:  { image: pgvector/pgvector:pg16, ports: ["5432:5432"] }
  redis:     { image: redis:7 }
  nats:      { image: nats:2.10, command: "-js" }
  vault:     { image: hashicorp/vault:1.16, environment: [VAULT_DEV_ROOT_TOKEN_ID=dev] }
  # --- Trigger.dev self-hosted (stack dev simplifiée) ---
  trigger:
    image: ghcr.io/triggerdotdev/trigger.dev:v4
    ports: ["8030:3000"]
    depends_on: [postgres, redis]
  # --- Plateforme ---
  backend-core:       { build: ./services/backend-core,  ports: ["8000:8000"] }
  prompt-layer:       { build: ./services/prompt-layer }
  orchestrator:       { build: ./services/orchestrator, volumes: ["/var/run/docker.sock:/var/run/docker.sock"] }
  mcp-gateway:        { build: ./services/mcp-gateway,   ports: ["8443:8443"] }
  github-mcp:         { build: ./services/mcp-servers/github }
  browser-mcp:        { build: ./services/mcp-servers/browser }
  scheduler-mcp:      { build: ./services/mcp-servers/scheduler }
  automation-service: { build: ./services/automation-service }
  web:                { build: ./apps/web, ports: ["3000:3000"] }
```

En dev, les crons ne se déclenchent que lorsque la CLI `trigger dev` de l'automation-service tourne — comportement voulu pour éviter des feux fantômes.

### 22.3 Pipeline CI/CD détaillé & policies d'infra

Étapes GitHub Actions (échec = arrêt, tout est bloquant sauf mention) :

```
1. lint + typecheck            ruff/mypy, eslint/tsc, golangci-lint
2. tests unitaires             pytest / vitest / go test  (couverture ≥ 80 % code de décision)
3. tests de contrats           validation croisée packages/schemas (TS ↔ Py) + compat vN-1
4. évals agents (gate)         golden set 150 tâches + 20 crons ; régression > 3 % = STOP
5. build images                BuildKit, SBOM (syft), signature cosign
6. scan sécurité               Trivy (CRITICAL = STOP), gitleaks sur le repo
7. migrations DB (lint)        Atlas : destructive dans la release = STOP (expand/contract §16.3)
8. déploiement staging         ArgoCD sync auto + tests e2e Playwright + tests réseau (§17.4)
9. trigger deploy (staging)    sync des schedules déclaratifs internes
10. promotion prod             approbation manuelle → ArgoCD sync ; canary 10 % sur backend-core
11. post-deploy                smoke tests, vérification SLO 30 min, rollback auto si burn rate > 14×
```

NetworkPolicy réelle du namespace sandboxes (le verrou du principe n°2) :

```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata: { name: sandbox-lockdown, namespace: sandboxes }
spec:
  podSelector: { matchLabels: { role: sandbox } }
  policyTypes: [Ingress, Egress]
  ingress:
    - from: [{ namespaceSelector: { matchLabels: { name: orchestration } } }]
      ports: [{ port: 4096, protocol: TCP }]        # seul l'orchestrator pousse des tours
  egress:
    - to:
        - namespaceSelector: { matchLabels: { name: mcp } }
          podSelector: { matchLabels: { app: mcp-gateway } }
      ports: [{ port: 8443, protocol: TCP }]         # seule sortie : la Gateway
    - to:
        - namespaceSelector: { matchLabels: { name: core } }
          podSelector: { matchLabels: { app: llm-proxy } }
      ports: [{ port: 4000, protocol: TCP }]         # + le proxy LLM
    - to: [{ namespaceSelector: { matchLabels: { name: kube-system } }, podSelector: { matchLabels: { k8s-app: kube-dns } } }]
      ports: [{ port: 53, protocol: UDP }]           # DNS cluster uniquement (pas de résolution externe)
```

---

## 23. Scalabilité, HA & DR

- **Stateless scale-out :** adapters, backend-core, prompt-layer, mcp-gateway, serveurs MCP, automation-service → HPA sur CPU + profondeur de file NATS.
- **Sandboxes :** ~40-60 sandboxes actifs par nœud 16 vCPU/64 Go ; autoscaling du node pool sur le taux d'occupation du pool chaud. Les pics de crons (heures rondes) sont lissés par le jitter + la classe de priorité basse.
- **Trigger.dev :** workers en HPA (2→10) sur la profondeur de queue ; webapp x2 ; ses datastores (Postgres/Redis/ClickHouse) répliqués. Perte totale de Trigger.dev = **aucun run perdu** : les schedules ratés pendant l'indisponibilité sont rattrapables (replay ciblé) et l'idempotence empêche les doublons au retour.
- **Dimensionnement cible v1 :** 5 000 utilisateurs, 500 sandboxes actifs en pointe, 2 000 jobs actifs (~6 000 runs/jour) → ~10-12 nœuds sandbox + 6 nœuds core + 3 nœuds automation.
- **HA :** Postgres primary+replicas failover auto ; NATS cluster 3 nœuds ; orchestrator actif/passif (leader election) ; multi-AZ systématique.
- **DR :** RPO 15 min (WAL archiving S3 + snapshots volumes + dump quotidien des datastores Trigger.dev), RTO 1 h. `scheduled_jobs` étant notre source de vérité, une reconstruction complète des schedules Trigger.dev est possible par re-création idempotente (`deduplicationKey`) — script `resync-schedules` fourni.

---

## 24. Console Admin & Exploitation (ops solo)

Cette section couvre les deux faces de l'administration : la **console** (le backoffice produit) et l'**exploitation au quotidien**, dimensionnée pour un opérateur unique. Le principe directeur : tout ce qui peut être automatisé, observé ou délégué à la plateforme elle-même doit l'être — l'humain n'intervient que sur les décisions et les incidents réellement exceptionnels.

### 24.1 Modèle de rôles admin

| Rôle | Portée | Notes |
|---|---|---|
| `platform_admin` | Toutes les orgs, toute l'infra | Toi. Claim dédié dans le JWT (distinct des rôles d'org), attribué hors-bande (table `platform_admins`, jamais modifiable via l'API publique) |
| `admin` (org) | Sa propre org uniquement | Gère utilisateurs, policies et budgets de son org |
| Break-glass | Compte d'urgence scellé | Credentials dans un coffre physique/manager de secrets séparé, usage = alerte + audit renforcé |

Accès console : SSO + MFA obligatoire (passkey recommandé), sessions courtes, **chaque action admin écrite dans `audit_log` avec `actor=admin`** — y compris celles du `platform_admin`. Le mode "view-as" (voir la plateforme comme un utilisateur donné) est en lecture seule et journalisé avec motif obligatoire.

### 24.2 Écrans de la console

| Écran | Contenu | Détail qui compte |
|---|---|---|
| **Orgs & utilisateurs** | CRUD orgs, plan, quotas, settings (guardrails, modèles, kill-switch automations) ; utilisateurs avec statut SCIM, rôles, suspension | Mode **view-as** lecture seule audité — l'outil n°1 pour débugger "ça ne marche pas chez moi" |
| **Éditeur de tool_policies** | Matrice org × rôle × pattern d'outil | Mode **simulation** avant application : "quels utilisateurs perdent quels outils ? quels crons vont se mettre en pause ?" — évite 80 % des incidents auto-infligés |
| **Connecteurs** | Santé par serveur MCP (latence P95, taux d'erreur, état du circuit breaker), secrets d'apps OAuth avec dates d'expiration, activation par org | Bouton "tester le connecteur" (appel de sonde en identité de service) |
| **Sandboxes** | Liste temps réel par état, conso CPU/RAM, occupation du pool chaud | Actions hibernate/kill/drain par nœud |
| **Automations (vue plateforme)** | Top jobs par coût, jobs en échec, jobs pausés par raison, volumétrie par org | Pause en un clic, lien direct vers le run Trigger.dev corrélé |
| **Audit & usage** | Explorateur d'audit (filtres user/outil/action/date, export CSV/S3), dashboards coûts interactive vs scheduled | Vues pré-enregistrées : "toutes les approbations de la semaine", "tous les E_PERM_*" |
| **Flags & maintenance** | Feature flags (Unleash ou table `feature_flags`), mode maintenance | La bannière maintenance est diffusée sur les trois canaux (Teams/Slack/Web) via les adapters |

### 24.3 API admin (extension du Backend Core)

```
GET/POST/PATCH /api/v1/admin/orgs | /orgs/{id}/settings | /orgs/{id}/quotas
GET/PATCH      /api/v1/admin/users/{id}            # rôle, suspension
POST           /api/v1/admin/users/{id}/view-as    # session lecture seule, motif requis
GET/PUT        /api/v1/admin/policies/{org}        # + POST /policies/{org}/simulate
GET            /api/v1/admin/connectors/health
POST           /api/v1/admin/connectors/{id}/probe | /rotate-secret
GET            /api/v1/admin/sandboxes  + POST .../{user}/hibernate|kill
GET            /api/v1/admin/automations?status=failed&org=...
POST           /api/v1/admin/automations/{job}/pause
GET            /api/v1/admin/audit?user=&tool=&from=&to=   (+ export)
GET            /api/v1/admin/usage/summary?groupby=org|user|origin
POST           /api/v1/admin/maintenance  {enabled, message}
GET/PUT        /api/v1/admin/flags
```

Toutes ces routes exigent le claim `platform_admin` (ou `admin` restreint à `org_id` propre), passent par le même Gateway (rate limiting dédié) et émettent des événements d'audit.

### 24.4 `platctl` — le CLI d'exploitation

Pour un ops solo, le CLI prime sur la console : scriptable, utilisable en incident, versionné avec la plateforme. Il consomme l'API admin (mêmes contrôles, même audit).

```
platctl status                        # santé globale en un écran (SLO, files, pool, breakers)
platctl sandbox list|kill|drain       # gestion sandboxes / vidage d'un nœud
platctl jobs pause --org acme         # kill-switch automations ciblé (ou --all)
platctl schedules resync              # reconstruit les schedules Trigger.dev depuis
                                      # scheduled_jobs (idempotent via deduplicationKey)
platctl dlq list|redrive [--subject]  # inspection / rejeu des files mortes
platctl connectors health|probe <id>  # état des serveurs MCP
platctl maintenance on --message "…"  # mode maintenance multi-canal
platctl user offboard usr_xxx         # déclenche user-erasure (confirmation requise)
platctl budget set --org acme --monthly 500
platctl audit tail --filter tool=github.merge_pr
```

### 24.5 Philosophie d'exploitation solo

1. **Managed partout où c'est possible** — Postgres managé, S3, K8s managé : le temps va à la logique métier, pas aux failovers de bases.
2. **Tout en code, zéro action manuelle non tracée** — GitOps strict (ArgoCD) : un déploiement = un commit, un rollback = un revert ; jamais de `kubectl edit` en prod (les accès directs au cluster sont audités et exceptionnels).
3. **Auto-remédiation avant alerte** — les jobs internes Trigger.dev (§15.7) traitent l'ordinaire : `sandbox-reaper`, `oauth-refresh-sweep`, `dlq-redrive`, `cert-expiry-check`, `pool-warmer`. Une alerte qui revient deux fois = candidat à l'automatisation.

### 24.6 Politique d'alerting bi-niveau

| Niveau | Canal | Contenu | Règle |
|---|---|---|---|
| **Page** (réveille) | Push/appel | Violations de SLO visibles utilisateur uniquement : API down ; P95 premier token > 30 s soutenu ; pool chaud vide **et** file croissante ; Postgres primary down ; Vault sealed | **5 alertes max.** Chaque page doit être actionnable et pointer son runbook |
| **Ticket** (attend le matin) | Digest quotidien Teams/Slack | Tout le reste : taux d'échec d'un connecteur, budget org à 80 %, retard de crons, DLQ non vide après redrive, certificats < 30 j | Jamais de notification unitaire — agrégé et priorisé |

### 24.7 Runbooks

Dossier `docs/runbooks/`, un fichier par incident type, format fixe : **Symptôme → Diagnostic (≤ 3 commandes `platctl`/PromQL) → Remédiation → Vérification → Post-mortem (5 pourquoi)**. Les dix à écrire en priorité :

1. Fournisseur LLM en panne (vérifier le failover LiteLLM, forcer la bascule)
2. Workers Trigger.dev down pendant une fenêtre de crons (replay ciblé + contrôle d'idempotence : zéro doublon attendu)
3. Vault sealed (unseal, vérifier l'impact sur refresh OAuth en cours)
4. Nœud sandbox saturé/défaillant (`platctl sandbox drain`, vérifier le rebalancing)
5. Secret d'app OAuth expiré (rotation, invalidation des connexions impactées, communication)
6. Partition NATS (état du cluster, rejeu JetStream, contrôle des DLQ)
7. Failover Postgres (promotion réplique, contrôle RPO, resync)
8. Certificat expiré (cert-manager, mTLS interne)
9. DLQ qui gonfle malgré redrive (identifier le message poison, quarantaine)
10. Org qui explose son budget (kill-switch, analyse usage_daily, contact client)

### 24.8 Dogfooding : l'org `org-platform`

La plateforme s'administre en partie **avec elle-même**. Une org interne `org-platform` où l'agent du `platform_admin` dispose d'un Database MCP en lecture seule sur les métriques/usage et du Scheduler MCP :

| Cron | Horaire | Contenu du brief |
|---|---|---|
| `brief-sante` | 08:00 j ouvrés | SLO de la nuit, runs planifiés en échec, coûts d'hier vs moyenne, breakers ouverts, certificats/secrets < 30 j |
| `rapport-hebdo` | lundi 08:30 | Coûts par org + anomalies, top automatisations, adoption par canal, capacité sandbox |
| `pre-checklist-releases` | avant fenêtre de déploiement | État staging, évals golden set, migrations en attente |

Bénéfice double : l'ops quotidien se réduit à lire un brief dans Teams, et tu es **l'utilisateur zéro** des crons — toute régression du sous-système d'automatisations se voit sur ton propre brief avant d'atteindre les clients.

### 24.9 Rituels minimaux

- **Hebdo (30 min)** : revue du digest d'audit (approbations, E_PERM, view-as) + tri des tickets du digest.
- **Mensuel** : revue des coûts par org, des policies orphelines, des connecteurs sans usage.
- **Trimestriel** : test de restauration réel (un cron Trigger.dev le rappelle et provisionne l'environnement de test), rotation des secrets planifiée, relecture des runbooks après incidents.

---

# PARTIE VI — DÉCISIONS & TRAJECTOIRE

*Coûts, stack, monorepo, décisions d'architecture et plan d'exécution.*

---

## 25. Modèle de coûts & capacité

Hypothèses : 5 000 utilisateurs provisionnés, 1 500 actifs/jour, 8 tours interactifs/actif/jour, 2 000 crons actifs (~6 000 runs/jour, budget moyen $0.12/run).

| Poste | Calcul | Ordre de grandeur mensuel |
|---|---|---|
| LLM interactif | 1 500 × 8 × 30 tours × ~$0.05/tour moyen (mix routing éco/frontier 80/20) | ~$18 000 |
| LLM planifié | 6 000 × 30 runs × $0.12 plafonné, réel ~$0.06 (modèle éco par défaut) | ~$10 800 plafond / ~$5 400 réel |
| Nœuds sandbox | 12 × 16 vCPU/64 Go | ~$4 500 |
| Nœuds core + data + automation | 9 nœuds + Postgres managé éventuel | ~$3 500 |
| Stockage (S3, volumes, ClickHouse) | snapshots + fichiers + traces | ~$800 |
| Trigger.dev | self-hosted → coût = infra ci-dessus uniquement | $0 licence |
| **Total** | | **~$32-38k/mois ≈ $6-8 / utilisateur provisionné** |

```mermaid
pie showData
    title Répartition des coûts mensuels — cible v1 (~$32k/mois réel)
    "LLM interactif" : 18000
    "LLM planifié (crons)" : 5400
    "Nœuds sandbox" : 4500
    "Core + data + automation" : 3500
    "Stockage" : 800
```

Leviers de réduction intégrés à l'architecture : routing de modèles (§9.5), digests anti-bruit (§15.5), hibernation agressive (§10.1), budgets multi-niveaux, suivi `usage_daily.origin` pour facturer/piloter séparément l'interactif et le planifié.

---

## 26. Stack technique récapitulative

| Couche | Choix principal | Alternative |
|---|---|---|
| Bots | Bot Framework SDK / Bolt | — |
| Web | React + TS + WebSocket | Next.js |
| Gateway API | Kong | Envoy Gateway, Traefik |
| Backend/Prompt Layer | Python 3.12 + FastAPI | Node NestJS |
| Orchestrator | Go | Rust |
| Bus | NATS JetStream | Redis Streams, Kafka |
| Sandbox runtime | Docker + gVisor | Kata/Firecracker |
| Agent | OpenCode (serveur) | — |
| LLM proxy | LiteLLM | proxy maison |
| MCP Gateway/serveurs | TypeScript (SDK MCP) | Go |
| **Jobs & crons** | **Trigger.dev v4 self-hosted** | Temporal, BullMQ, K8s CronJobs |
| **Automation service** | **TypeScript + @trigger.dev/sdk** | — |
| DB | Postgres 16 + pgvector | + Qdrant si volumétrie vecteurs |
| Cache | Redis 7 | Valkey |
| Secrets | HashiCorp Vault | KMS cloud + SOPS |
| Observabilité | OTel + Prometheus + Grafana + Loki + Tempo | Datadog |
| Infra | K8s + Terraform + Helm + ArgoCD | Nomad |

---

## 27. Structure du monorepo

```
platform/
├── apps/
│   ├── web/                      # React (chat, connexions, automatisations, admin)
│   ├── teams-adapter/
│   └── slack-adapter/
├── services/
│   ├── backend-core/             # FastAPI REST+WS + /internal/scheduled-runs
│   ├── prompt-layer/             # memory, planning, guardrails, perms, routing
│   ├── orchestrator/             # Go, gRPC, gestion sandboxes
│   ├── llm-proxy/                # config LiteLLM
│   ├── auth-service/             # OIDC, JWT, JWKS
│   ├── automation-service/       # (v2)
│   │   ├── trigger/              #   agent-scheduled-run.ts + jobs internes
│   │   ├── api/                  #   API jobs (create/update/pause/resync)
│   │   └── trigger.config.ts
│   ├── mcp-gateway/
│   └── mcp-servers/
│       ├── github/  ├── m365/  ├── slack/
│       ├── browser/ ├── database/ ├── notion/
│       └── scheduler/            # (v2) façade MCP → automation-service
├── sandbox/
│   ├── Dockerfile                # image OpenCode durcie
│   └── profiles/                 # dev.json, data-analyst.json, ops.json...
├── packages/
│   ├── schemas/                  # InboundMessage, AgentEvent, AgentTask, ScheduledJob
│   ├── errors/                   # taxonomie §21 partagée TS/Py
│   └── shared-ts/ shared-py/     # clients bus, télémétrie, JWT, idempotence
├── evals/
│   ├── golden/                   # 150 tâches de référence + 20 scénarios crons
│   └── adversarial/              # corpus injection
├── infra/
│   ├── terraform/  ├── helm/  └── argocd/
├── db/migrations/
└── docs/  (ce document + ADRs)
```

---

## 28. Architecture Decision Records

| ADR | Décision | Raison | Alternatives écartées |
|---|---|---|---|
| 001 | Une MCP Gateway unique devant tous les serveurs MCP | Point unique d'AuthZ, d'injection de secrets et d'audit ; l'agent ne voit qu'un endpoint | Connexion directe sandbox→serveurs (surface d'attaque, secrets diffusés) |
| 002 | gVisor pour les sandboxes | Bon ratio isolation/perf/simplicité, compatible K8s RuntimeClass | Firecracker (plus lourd à opérer), containers bruts (isolation insuffisante) |
| 003 | NATS JetStream comme bus | Léger, replay, faible latence, simple à opérer | Kafka (surdimensionné à ce stade), Redis Streams (retenu comme option de départ) |
| 004 | **Trigger.dev pour crons & jobs** | Schedules dynamiques multi-tenant natifs (externalId/dedup), timezones DST, retries durables, dashboard, self-hosted Docker/Helm | Temporal (puissant mais coût opérationnel et modèle mental élevés), BullMQ (pas de vrai scheduling multi-tenant durable), K8s CronJobs (statiques, pas d'API user) |
| 005 | Le worker de cron ré-injecte dans le pipeline standard au lieu d'appeler l'agent directement | Un seul chemin de sécurité (guardrails/permissions/audit) à maintenir et à tester | Exécution directe depuis Trigger.dev (bypass des contrôles, duplication de logique) |
| 006 | Permissions des crons évaluées au feu, jamais figées | Empêche l'escalade différée et la persistance post-offboarding | Snapshot des permissions à la création (dangereux), tokens stockés dans le job (interdit) |
| 007 | Postgres+pgvector pour la mémoire | Une base de moins à opérer, transactions avec le reste du modèle | Vector DB dédiée (à reconsidérer > 50 M vecteurs) |
| 008 | Orchestrator en Go | Concurrence massive, latence faible, binaire statique | Python (GIL/latence), Rust (vélocité d'équipe) |
| 009 | OpenCode en mode serveur dans le sandbox | Agent éprouvé, API/événements prêts, profils configurables | Agent maison (coût), SDK embarqué dans l'orchestrator (couplage) |
| 010 | JWT courts (15 min) partout, zero-trust interne | Limite l'impact d'un vol de token ; pas d'état de session au centre | Sessions serveur (état), tokens longs (risque) |
| 011 | **Ordre de build « gouvernance d'abord » (wedge M0)** au lieu de P0→P7 | Livrer d'abord la moitié sécurité-critique la plus dure à copier — celle qui referme un pilote grand-compte régulé — et différer l'infra sandbox/scheduler coûteuse ; cadence alignée sur le runway (Annexe F) | Ordre naturel des phases (repousse le moat vendable), tout-en-parallèle (dilue le focus, brûle la trésorerie avant validation) |
| 012 | **Arêtes réelles (LLM, connecteurs) derrière une interface stub commune, swap par config** | Le chemin dev/test reste hors-ligne (stub, sans clé) ; passer en réel = `provider: anthropic` / injecter un backend, zéro changement de code au-dessus du seam (§G.4) ; `RunsStore`/`Backend`/`GithubBackend` enfichables | Client réel codé en dur (tests exigent une clé et un réseau), branchements `if provider ==` dispersés (non testables, dérive) |
| 013 | **Fail-closed par défaut sur toute la couche auth, gardé sur `OLMA_ENV=prod`** | Un défaut ouvert (secret dev connu, `exp` absent, membership d'approbation présumé, credential env ambiant) est une porte dérobée ; en prod le service refuse de démarrer / rejette plutôt que d'admettre | Défauts permissifs « pratiques » (fuite de deputy confus, auto-approbation, token éternel), garde uniquement documentée (non appliquée) |
| 014 | **Table de prix = donnée dans `config.yaml`, mais garde-fou de dérive `reference_prices.py`** | Le prix pilote l'admission budgétaire et la facturation ; un chiffre périmé sur-rejette et sur-facture. La table reste le seam de swap, mais le chargeur refuse de démarrer si un modèle Anthropic dévie de la référence canonique | Prix codés en dur (fige le seam), pas de garde (le bug 15/75 vs 5/25 passe silencieusement en prod) |
| 015 | **Boucle de ré-approbation : le Prompt Layer re-mint, l'outil passe de `approval_tools` à `allowed_tools`** | Le Gateway ne renvoie que `needs_approval` et n'exécute jamais un outil gaté inline ; après accord humain, on re-mint un TASK JWT frais où seul l'outil approuvé est promu, puis on ré-invoque via le Gateway — le minting reste dans le Prompt Layer | Le backend mute la liste de tokens lui-même (minting hors du seul émetteur), ré-invocation sans re-mint (le Gateway reboucle éternellement sur `needs_approval`) |
| 016 | **`fire_job` enregistre la clé d'idempotence uniquement au succès (dedup-on-success)** | Enregistrer la clé avant `build_task` fait qu'un échec de build (prompt qui trip un guardrail) marque le fire comme « traité » : le retry Trigger.dev tombe sur la branche doublon et l'occurrence est perdue à jamais. On enregistre après la production effective de la tâche | Marquer à l'entrée (at-most-once-on-attempt, fires perdus silencieusement), pas de dedup (double exécution au retry) |

---

## 29. Roadmap d'implémentation

| Phase | Durée | Contenu | Critère de sortie |
|---|---|---|---|
| **0 — Fondations** | 2 sem. | Monorepo, schémas d'événements, compose dev (incl. Trigger.dev), auth-service, Postgres+Redis+NATS | `docker compose up` fonctionnel, JWT bout en bout |
| **1 — Cœur vertical** | 4 sem. | Web App chat + backend-core + prompt-layer minimal + orchestrator + 1 sandbox OpenCode + MCP Gateway + GitHub MCP | Démo : tâche GitHub complète depuis le Web avec streaming |
| **2 — Multi-canal** | 3 sem. | Teams adapter (SSO + Adaptive Cards + approbations), Slack adapter, signatures webhooks | Même tâche depuis Teams et Slack |
| **3 — Contrôle** | 3 sem. | Permissions/tool_policies, approbations, guardrails E/S, audit log, Vault + flows OAuth, **console admin v1 (orgs, policies, audit)** | Politique `require_approval` démontrée, audit exportable |
| **4 — Intelligence** | 3 sem. | Memory (court+long terme), planning, profils d'agents, llm-proxy multi-modèles + budgets | Personnalisation visible, coûts suivis par org |
| **5 — Automatisations** | 3 sem. | automation-service + Trigger.dev self-hosted, tâche pivot, Scheduler MCP, page Automatisations, delivery proactif Teams/Slack, jobs internes migrés | Démo §18.2 + §18.3 de bout en bout ; permissions au feu prouvées (test de révocation) |
| **6 — Étendue MCP** | 3 sem. | M365 MCP (Graph délégué), Browser MCP durci, Database MCP, Notion, Slack MCP | 7 connecteurs en prod interne |
| **7 — Prod-ready** | 4 sem. | K8s + gVisor, GitOps, observabilité complète, pool chaud, hibernation, évals en gate CI, load tests (500 sandboxes + 1 000 crons/h), pentest, **console admin complète + `platctl` + runbooks + org-platform (§24)** | SLO tenus (Annexe A), dispo 99,9 % |

**Total : ~25 semaines** pour une v1 production avec une équipe de 4-6 ingénieurs.

```mermaid
gantt
    title Roadmap d'implémentation — ~25 semaines (départ indicatif août 2026)
    dateFormat YYYY-MM-DD
    axisFormat %d/%m
    section Fondations
    P0 Fondations (monorepo, schémas, compose)      :done, 2026-08-03, 2w
    section Cœur produit
    P1 Cœur vertical (chat→sandbox→GitHub)          :2026-08-17, 4w
    P2 Multi-canal (Teams, Slack)                   :2026-09-14, 3w
    P3 Contrôle (permissions, audit, OAuth, admin)  :2026-10-05, 3w
    P4 Intelligence (mémoire, planning, budgets)    :2026-10-26, 3w
    section Extension
    P5 Automatisations (Trigger.dev, Scheduler MCP) :2026-11-16, 3w
    P6 Étendue MCP (M365, Browser, DB, Notion)      :2026-12-07, 3w
    section Production
    P7 Prod-ready (K8s, gVisor, SLO, pentest)       :crit, 2026-12-28, 4w
```

---

## 30. Commercialisation & Protection

Le pont entre le blueprint technique et un produit vendable : prix, contrats, support, onboarding. *(Volet juridique : principes à faire valider par un avocat — pas un conseil juridique.)*

### 30.1 Pricing & packaging

Principes : facturer le **siège actif** (pas le siège provisionné), quota d'usage inclus par siège avec plafonds visibles dans l'UI (§4), dépassement transparent au réel + marge. Cohérence économique : coût ~$2/actif/jour (Annexe C) × 30-50 % de sièges actifs ⇒ marge brute ≥ 55 % aux prix ci-dessous.

| Offre | Cible | Prix indicatif | Inclus |
|---|---|---|---|
| **Équipe** (Mode B, SaaS) | PME/équipes, MVP | 250 €/mois/org + **30-45 €/siège actif/mois** (min. 10) | Connecteurs org, 20 automatisations/org, budget d'usage/siège, support standard |
| **Personnel** (Mode A, SaaS) | Grands comptes, gouvernance fine | **50-70 €/siège/mois** | Connecteurs personnels OAuth, mémoire privée, approbations fines, SSO/SCIM, audit exportable |
| **Souverain** (self-hosted) | Banques, secteur public | Licence annuelle **60-150 k TND / 30-80 k€** selon sièges + 20 %/an maintenance | Déploiement datacenter client, option modèle on-prem (Annexe H), formation ops |
| **Pilote / POC** | Entrée grands comptes | 15-40 k TND / 8-20 k€ (Annexe F) | 2-3 mois, périmètre borné, déductible de la 1ʳᵉ année |

Dépassement d'usage : facturé au coût LLM réel + 20 %, jamais de coupure sèche en cours de tâche (fin de tour puis blocage doux + notification). Remises : annuel −15 %, design partner −30 % contre étude de cas.

### 30.2 Responsabilité juridique des actions de l'agent

Le sujet que tout acheteur bancaire posera en premier. Position contractuelle à inscrire dans les CGV :

- **L'approbation humaine transfère la responsabilité** : toute action exécutée après une approbation explicite (carte Approuver, `pre_approved_tools`, `approver_group`) est réputée action du client ; l'audit horodaté (qui a approuvé, quoi, quand — §13.3, §3.2) en est la preuve contractuelle.
- **Limitation de responsabilité** : plafonnée aux redevances des 12 derniers mois ; exclusion des dommages indirects ; pas d'engagement de résultat sur les contenus générés (obligation de moyens + garde-fous documentés §17).
- **Propriété intellectuelle** : le code et les contenus générés pour le client lui appartiennent ; la plateforme, les prompts et le savoir-faire restent à l'éditeur.
- **DPA type** annexé : rôles (client = responsable de traitement, éditeur = sous-traitant), liste des sous-traitants ultérieurs (cloud, fournisseur LLM en option no-retention), mesures techniques (renvoi vers §17), assistance à l'exercice des droits (`user-erasure`), notification d'incident (§17.5).
- **Assurances** : RC professionnelle + cyber **avant le premier client bancaire** — souvent une exigence de leur procurement, pas une option.

### 30.3 Support client & SLA contractuels

Distinction à formaliser : les **SLO internes** (Annexe A, 99,9 %) pilotent l'ingénierie ; les **SLA contractuels** engagent — toujours en dessous des SLO pour garder une marge.

| Élément | Standard (Équipe) | Premium (Personnel/Souverain) |
|---|---|---|
| Disponibilité contractuelle | 99,5 % (crédits de service au-delà) | 99,7 % |
| P1 — plateforme inutilisable | Réponse 4 h ouvrées | 2 h, 7 j/7 |
| P2 — fonction dégradée | 1 jour ouvré | 4 h ouvrées |
| P3 — question/anomalie mineure | 3 jours ouvrés | 1 jour ouvré |
| Canaux | In-app + email | + Slack Connect / Teams partagé |

Outillage : bouton "Signaler un problème" in-app (attache automatiquement `trace_id` + contexte, jamais le contenu de conversation sans consentement) → ticketing ; **page de statut publique** alimentée par Alertmanager (incidents + maintenances) ; thumbs down récurrents → ticket proactif + candidat golden set (§20.2).

### 30.4 Onboarding d'une organisation

Le parcours que le premier client vivra — à outiller comme un produit :

| Jour | Étape | Détail |
|---|---|---|
| J0 | Contrat + DPA signés | Offre choisie, plafonds et politiques par défaut convenus |
| J1 | Création de l'org | `platctl org create` : quotas, guardrails, modèles autorisés, kill-switch armé |
| J1-J2 | Installation des apps | Manifest Teams (admin consent Entra) et/ou app Slack dans le tenant **client** ; vérification des webhooks signés |
| J2 | Identités | SSO (OIDC) + provisioning SCIM (statuts actif/offboardé alimentent le preflight §15) |
| J2-J3 | Connecteurs | Mode B : comptes de service (GitHub App sur l'org, DB read-only…) dans Vault ; Mode A : campagne de liaison OAuth utilisateurs |
| J3 | Politiques | Revue `tool_policies` avec le client (simulateur §24.2) — écritures en `require_approval`, `approver_group` désignés |
| J4 | Pilote encadré | 5-10 utilisateurs champions, cas d'usage cibles, budget pilote plafonné |
| J5+ | Élargissement | Brief hebdo automatique au sponsor (un cron, évidemment) : adoption, tâches réussies, coûts |

Critère de sortie d'onboarding : 10 tâches réelles réussies + 1 automatisation en production + sponsor autonome sur la console org.

---

# ANNEXES TECHNIQUES


---

## Annexe A — SLO cibles

| SLO | Cible |
|---|---|
| Premier token streamé (Web) | P95 < 3 s |
| Réveil sandbox (IDLE→ACTIVE) | P95 < 500 ms |
| Création sandbox à froid (pool vide) | P95 < 8 s |
| Latence ajoutée par la MCP Gateway | P95 < 80 ms |
| Précision de déclenchement d'un cron (hors jitter volontaire) | P95 < 60 s |
| Cron fire → premier événement agent | P95 < 10 s |
| Taux de runs planifiés perdus (ni exécutés ni marqués failed) | 0 |
| Doublons de runs planifiés | 0 (idempotence) |
| Disponibilité API | 99,9 % |
| Perte de données conversations | 0 (RPO 15 min infra) |

---

## Annexe B — Glossaire

| Terme | Définition |
|---|---|
| **AgentTask** | Objet validé produit par le Prompt Layer, contrat d'exécution d'un tour (interactif ou planifié) |
| **TASK JWT** | Jeton court (15 min) porté par le sandbox, seule identité qu'il possède ; contient les outils autorisés |
| **MCP** | Model Context Protocol — protocole standard exposant des outils aux agents |
| **MCP Gateway** | Proxy MCP unique appliquant AuthZ, injection de secrets, DLP et audit |
| **Scheduler MCP** | Serveur MCP permettant à l'agent de gérer les crons de son utilisateur |
| **Job / scheduled_job** | Définition métier d'une automatisation (prompt, cron, delivery, budgets) — source de vérité en Postgres |
| **Run / scheduled_run** | Une exécution datée d'un job |
| **Schedule impératif** | Schedule Trigger.dev créé dynamiquement par API (un par job utilisateur) |
| **Schedule déclaratif** | Schedule défini dans le code (jobs internes de plateforme), synchronisé au déploiement |
| **Preflight** | Vérifications au feu d'un cron avant ré-injection (user actif, budgets, kill-switch) |
| **Permissions au feu** | Ré-évaluation des droits au moment de chaque run, jamais à la création |
| **Pool chaud** | Conteneurs sandbox pré-démarrés sans identité, assignés en < 500 ms |
| **Delivery** | Canal de livraison du résultat d'un run planifié (DM Teams/Slack, email, webhook) |
| **Kill-switch** | Flag org désactivant instantanément toutes les automatisations |
| **Memory MCP** | Serveur MCP interne exposant la mémoire de l'agent comme un outil audité (`memory.save/search/update/forget`) |
| **Mémoire procédurale** | Notes persistantes du workspace (`/workspace/.agent/`) capturant le *comment faire* appris |
| **Graphe d'entités temporel** | Faits typés avec `valid_from`/`valid_to` — un fait contredit est clôturé, jamais écrasé |

---

## Annexe C — Modèle de consommation tokens (Sonnet 4.6)

Modèle bottom-up branché sur la section 25 ; le modèle principal de la plateforme est **Claude Sonnet 4.6** ($3 / M tokens input, $15 / M output ; contexte 1M au tarif standard ; cache lu à 10 % du prix d'entrée, écrit à 1,25× ; Batch API −50 % ; thinking facturé en output → `effort: medium` par défaut dans les profils).

### C.1 Coût par type de tour

Dans une boucle agentique, **chaque itération renvoie tout le contexte accumulé** — le cumul d'input est la variable dominante, et le préfixe se répétant d'une itération à l'autre, le hit rate de cache intra-tour atteint naturellement 75-85 % si le contexte respecte la structure §9.6.

| Type de tour | Itérations | Input cumulé | Output (incl. thinking) | Coût brut | Coût avec cache (~80 %) |
|---|---|---|---|---|---|
| `chat_simple` | 1 | ~2,5 k | ~350 | $0,013 | ~$0,009 |
| Agentique moyen (PR, brief mails) | ~12 | ~250 k | ~12 k | ~$0,93 | **~$0,40** |
| Agentique lourd (déploiement, refactor) | ~25 | ~600 k | ~20 k | ~$2,10 | **~$0,90** |
| Run planifié (cron) | ~8 | ~120 k | ~5 k | ~$0,44 | **~$0,18** |
| Classification / extraction mémoire | 1 | ~0,8 k | ~60 | $0,003 | $0,003 |

```mermaid
xychart-beta
    title "Coût par type de tour (USD) — barres gauches : sans cache · droites : avec cache"
    x-axis ["Chat simple", "Agent moyen", "Agent lourd", "Run cron"]
    y-axis "USD par tour" 0 --> 2.2
    bar [0.013, 0.93, 2.10, 0.44]
    bar [0.009, 0.40, 0.90, 0.18]
```

Les budgets du document ($2,50/tour interactif, $0,50/run) offrent donc une marge ×2-3 sur les coûts moyens réels.

### C.2 Profil journalier & scénarios mensuels

Hypothèse par utilisateur actif/jour : 6 tours simples + 3 agentiques moyens + 0,5 lourd ≈ **1,05 M tokens input cumulé + 48 k output** → ~$3,90 brut, **~$2,00 avec caching**.

| | Démarrage | Croissance | Traction |
|---|---|---|---|
| Actifs/jour (22 j ouvrés) | 10 | 30 | 100 |
| Crons actifs (1 run/j, 30 j) | 15 | 50 | 180 |
| Input total/mois | ~290 MTok | ~880 MTok | ~3,0 GTok |
| Output total/mois | ~13 MTok | ~40 MTok | ~135 MTok |
| Interactif (avec cache) | ~$460 | ~$1 390 | ~$4 600 |
| Crons (avec cache) | ~$80 | ~$270 | ~$970 |
| Overhead (classif., mémoire, guardrails) ~12 % | ~$65 | ~$200 | ~$670 |
| **Total mensuel avec caching** | **~$600** | **~$1 850** | **~$6 200** |
| Total sans caching (référence) | ~$1 150 | ~$3 450 | ~$11 500 |
| Coût / actif / mois | ~$60 | ~$62 | ~$62 |

Ordres de grandeur à retenir : **~$2 / utilisateur actif / jour · ~$60 / actif / mois · caching = facture ÷2**.

### C.3 Leviers de réduction (par impact décroissant)

1. **Prompt caching structurel** (§9.6) — levier n°1, ÷2 sur la facture ; le llm-proxy pose les `cache_control` et surveille `plat_llm_cache_hit_ratio` par org.
2. **Routing réel** — classification et extraction mémoire sur Haiku 4.5 ($1/$5) : invisible pour l'utilisateur, réduit l'overhead de ~60 %.
3. **`effort: medium` par défaut** — 30 k tokens de thinking coûtent $0,45 à eux seuls ; `high` réservé au profil `dev` lourd.
4. **Batch −50 %** pour les jobs asynchrones sans boucle d'outils (digests, extraction mémoire, rollups).
5. **Compaction de contexte** (OpenCode) — borne le coût des tâches lourdes sans invalider le cache (§9.6).
6. **Digests anti-bruit des crons** (§15.5) — un run `no_op` regroupé ne coûte pas de delivery ni de relance.

---

## Annexe D — Checklist go-live production

À valider intégralement avant l'ouverture aux premières orgs externes (fin de Phase 7). Chaque ligne a un propriétaire et une preuve (lien vers test, dashboard ou document).

**Sécurité**
- [ ] Pentest externe réalisé, criticités corrigées, re-test passé
- [ ] Corpus adversarial (injection) : 0 compromission sur actions d'écriture (§20.2)
- [ ] Tests réseau automatisés verts : matrice §17.4 respectée, interdits vérifiés
- [ ] Rotation des clés TASK JWT exercée en réel ; blocklist `jti` testée
- [ ] Compte break-glass scellé, procédure testée, alerte d'usage vérifiée
- [ ] Scan images : 0 CRITICAL ; signatures cosign vérifiées à l'admission (policy controller)
- [ ] Antivirus pièces jointes (ClamAV) actif sur la chaîne upload → S3 → sandbox (§17.2)
- [ ] Chiffrement at-rest des volumes workspace et snapshots vérifié (§11.2)
- [ ] Exercice tabletop de réponse à incident réalisé ; template de notification 72 h prêt (§17.5)

**Données & résilience**
- [ ] Restauration PITR testée de bout en bout (RPO ≤ 15 min, RTO ≤ 1 h mesurés)
- [ ] `resync-schedules` exercé : reconstruction Trigger.dev depuis `scheduled_jobs`, zéro doublon
- [ ] Job `user-erasure` validé sur un utilisateur de test (toutes les tables + volumes + tokens)
- [ ] Chaos : perte du leader orchestrator, d'un nœud NATS et des workers Trigger.dev pendant une fenêtre de crons — aucun run perdu, aucun doublon

**SLO & charge**
- [ ] Load test k6 : 500 sandboxes, 2 000 msg/min, 1 000 crons/h — SLO Annexe A tenus
- [ ] Alerting : les 5 pages déclenchent réellement (test d'incendie) ; digest quotidien reçu
- [ ] Dashboards SLO + coûts opérationnels et revus (hit rate cache ≥ 75 % constaté)

**Produit & exploitation**
- [ ] Runbooks 1-10 rédigés et joués au moins une fois à blanc (§24.7)
- [ ] `org-platform` active : brief santé quotidien reçu depuis 2 semaines
- [ ] Politiques par défaut revues (écritures en require_approval partout)
- [ ] Parcours d'onboarding utilisateur testé sur les 3 canaux (liaison identité, 1re connexion OAuth, 1er cron)

**Conformité & contrats**
- [ ] Option no-retention activée chez le fournisseur LLM, DPA signé
- [ ] Rétentions par table configurées (§16.3) et documentées client
- [ ] Export d'audit WORM vérifié (object-lock effectif)
- [ ] Mentions RGPD + registre de traitement à jour ; résidence EU validée si requise

**Commercial & juridique (§30)**
- [ ] Grille tarifaire publiée ; plafonds et dépassements visibles dans l'UI
- [ ] CGV avec clause de transfert de responsabilité par approbation + limitation de responsabilité ; DPA type prêt
- [ ] Assurance RC pro + cyber souscrite
- [ ] Page de statut publique en ligne ; SLA contractuels < SLO internes ; support outillé (trace_id auto)
- [ ] Parcours d'onboarding org J0-J5 testé sur un client pilote

---

## Annexe H — Benchmark & politique de sélection des modèles

*État du terrain mi-2026 — chiffres directionnels, à re-vérifier trimestriellement. Le golden set interne (§20.2) reste l'arbitre final.*

### H.1 Pourquoi les leaderboards publics ne suffisent plus

Trois faits établis en 2026 imposent la prudence : (1) **le scaffold domine les scores** — un même modèle varie de 12 points sur SWE-bench Pro selon le harnais d'agent utilisé, rendant les comparaisons brutes entre scaffolds invalides ; (2) des soupçons de **contamination** des données d'entraînement pèsent sur SWE-bench Verified pour tous les frontiers (SWE-bench Pro = successeur plus résistant) ; (3) les 8 grands benchmarks ont été cassés par **reward hacking** (Berkeley/RDI, avril 2026) — préférer les évaluations tierces (Epoch AI, BenchLM) et sa propre éval held-out. Conséquence : les leaderboards servent à **présélectionner 3-4 candidats**, le golden set interne tranche.

### H.2 Benchmarks pertinents par rôle de la plateforme

| Besoin (§9.5) | Benchmark de référence | Ce qu'il mesure |
|---|---|---|
| Boucles agentiques + outils MCP | **τ²-bench**, GAIA | Agents conversationnels avec outils — le plus proche du pipeline |
| Profil `dev` | **SWE-bench Verified/Pro**, Terminal-Bench | Résolution d'issues GitHub réelles, autonomie CLI |
| Browser MCP | WebArena, OSWorld | Navigation et actions web |
| Tours simples / classification | Latence + coût uniquement | Un point de qualité ne vaut pas 10× le prix ici |

### H.3 État du terrain par tier (mi-2026)

- **Frontier** (les ~20 % de tâches dures) : Opus 4.7 a mené SWE-bench Verified à 87,6 % (GPT-5.3-Codex 85,0 %) au printemps ; snapshots récents : Grok 4.5 86,6 %, GPT-5.5 82,6 %, Opus 4.7 82 % — la tête change chaque trimestre, l'écart réel entre frontiers est faible. GPT-5.x-Codex domine Terminal-Bench global, Gemini 3.x Pro passe devant sur le sous-ensemble le plus dur ; Anthropic balaie le haut de GAIA/HAL. Génération Anthropic courante : Opus 4.8 + tier Fable 5.
- **Équilibre — le défaut de la plateforme, choix confirmé** : Sonnet 4.6 à 79,6 % SWE-bench Verified, ~1 point derrière Opus 4.6 pour **1/5 du prix** ; consensus praticiens 2026 comme meilleur ratio quotidien.
- **Éco** (classification, extraction mémoire, tours simples) : Haiku 4.5 ($1/$5), Gemini Flash, GPT-mini — critère : latence < 300 ms et coût, pas le score.
- **Open-weights — l'angle souverain** : Qwen 3 Coder ($0,30/$1,50, poids ouverts), DeepSeek V4-Flash ($0,14/$0,28), Kimi/GLM — crédibles en production, servis via vLLM sur le datacenter du client pour les déploiements où **aucun token ne sort** (banques, secteur public). Compter 15-25 points de moins que Sonnet sur l'agentique dure : trade-off souveraineté/capacité à vendre explicitement.

### H.4 Configuration de routing recommandée (llm-proxy)

| Rôle | Primaire | Fallback | Justification |
|---|---|---|---|
| Classification (~250 ms) + extraction mémoire | Haiku 4.5 | Gemini Flash | Coût/latence |
| Tours simples | Haiku 4.5 | Sonnet 4.6 | Escalade si confidence < 0,7 |
| Agentique standard + crons (**défaut**) | **Sonnet 4.6** | GPT-5.x (cross-provider) | Meilleur ratio ; résilience incident fournisseur |
| Escalade frontier (profil dev lourd, sur budget) | Opus 4.8 | Gemini 3.x Pro | Tâches dures ; très long contexte architectural |
| Déploiements souverains on-prem | Qwen 3 Coder / DeepSeek via vLLM | — | Zéro sortie de tokens |

Deux contraintes propres au projet : le fallback **cross-provider** n'est pas un luxe (incident fournisseur = plateforme morte sinon), et la **disponibilité Bedrock** des primaires compte double — c'est la route de paiement en TND (Annexe G) ; vérifier chaque candidat fallback.

### H.5 Protocole de bench interne (l'arbitre)

Golden set (150 tâches + 20 scénarios crons, §20.2) exécuté sur 3-4 candidats, cinq mesures : taux de réussite ; **coût réel par tâche réussie** (pas par token — un modèle moins cher qui boucle 2× coûte plus cher) ; P95 premier token ; respect des `allowed_tools` (tentatives hors périmètre) ; taux d'approbations inutiles demandées. **Re-test trimestriel** — le modèle gagnant de fin d'année n'est probablement pas encore sorti, et l'architecture rend la bascule indolore (une ligne de config llm-proxy).

---

# ANNEXES BUSINESS


---

## Annexe E — Marché & valorisation (Tunisie)

*Ordres de grandeur pour cadrer les décisions — pas un conseil financier. Données écosystème : Startup Genome/GSER 2025, Smart Capital/CDC, bilans Startup Act.*

### E.1 Le terrain

Écosystème réel mais petit : 1 000+ startups labellisées, valeur d'écosystème ~241 M$ (+205 % en 3 ans), fonds de fonds **ANAVA** (~200 M€ cible, libellé en euros) irriguant les fonds locaux, Tunisie classée n°3 MENA pour le talent abordable. Points durs assumés : tickets seed locaux modestes (~0,4-1 M$ constatés), profondeur de capital post-seed limitée, fuite des cerveaux. Référence de plafond atteignable : InstaDeep (levée 100 M$+ puis acquisition mondiale).

### E.2 Positionnement

La défendabilité n'est pas "agents IA" (copiable) mais la **couche de gouvernance** : permissions au feu, isolation par utilisateur, audit, self-hosted — une barrière réglementaire longue à répliquer, et l'argument qui ouvre les comptes souverains locaux (banques, assurances, télécoms, secteur public). Stratégie de référence : **construire à Tunis (coût ÷3-4 vs Europe), crédibiliser par 1-2 clients souverains locaux, vendre en Europe/Golfe** où $60/actif/mois de coûts (Annexe C) se transforment en marges saines à 300-600 €/siège/an.

### E.3 Valorisation par jalons

| Jalon | Pre-money plausible | Interlocuteurs |
|---|---|---|
| Démo solide + label Startup Act | ~$0,5-2 M | Fonds seed locaux (véhicules ANAVA), Flat6Labs |
| 2-3 pilotes payants (dont 1 lighthouse banque/télécom), ~$100-200 k ARR | ~$3-6 M | Fonds régionaux MENA + premiers fonds européens |
| $500 k-1 M ARR majoritairement export, structure duale | ~$8-20 M | VCs Europe/Golfe (10-20× ARR infra IA early-stage) |

### E.4 Trajectoire à 18 mois

| | Prudent | Réaliste | Optimiste |
|---|---|---|---|
| Grands comptes TN / export / PME | 2 / 0 / 4 | 3-4 / 2 / 8 | 5 / 4-6 / 12 |
| ARR | ~$80 k | ~$250-400 k | ~$700 k-1 M |
| Levée | non (bridge local) | seed $0,5-1,5 M | seed $1,5-3 M |
| Pre-money plausible | ~$1-2 M | ~$4-8 M | ~$10-20 M |

Unités économiques : grand compte TN self-hosted 60-150 k TND/an (50-200 sièges plafonnés) ; export mid-market 20-50 k€/an ; marge brute cible 55-70 % (caching + routing en place). **Les 4 métriques qui fixent la valorisation** : rétention nette des pilotes convertis (≥ 100 % avec expansion), marge brute ≥ 60 %, part d'ARR en devises, pipeline qualifié ≥ 3× l'ARR visé à M24.

### E.5 Risques pays & parades

Exposition de change structurelle (revenus TND / coûts USD) → facturer les grands comptes en devise quand possible + Annexe G ; pas de région hyperscaler locale → self-hosted sur datacenter local pour les clients souverains, région UE pour l'export (l'architecture le permet nativement) ; rétention des talents → leviers Startup Act 2.0 (salaires partiellement en devises, stock-options incluant les filiales étrangères).

---

## Annexe F — Plan financier : les 6 premiers mois

*Modèle mensuel complet et paramétrable : `plan-tresorerie-6mois.xlsx` (hypothèses, pipeline, 3 feuilles de flux, synthèse + graphique + sensibilité). Chiffres ci-dessous = sorties du modèle.*

### F.1 Principes

Les 6 premiers mois ne vendent pas un SaaS à l'échelle (v1 prod ≈ semaine 25) : les revenus viennent de **pilotes payants, design partners et non-dilutif**. Règles : vendre sur maquette dès M1 (cycles grands comptes TN : 3-5 mois), **jamais de POC gratuit** (< 10 k TND = non crédible), plafonner l'usage des pilotes (coût LLM ≤ 10 % du prix — budgets natifs de la plateforme). Prix pratiqués : POC grand compte TN 15-40 k TND / 2-3 mois ; design partner UE 8-20 k€ / 3 mois ; PME 0,5-1,5 k TND/mois plafonné.

### F.2 Les 3 scénarios (fenêtre M1-M6, TND)

Conditions modélisées : acompte 50 % à la signature, solde à la livraison + DSO (TN 60 j, UE 30 j) — d'où l'écart structurel signé/encaissé.

| | Prudent | Réaliste | Optimiste |
|---|---|---|---|
| Deals | 2 LOI, 0 signé | 1 POC banque 25 k (M4) + 1 DP UE 10 k€ (M3) + 2 PME | 2 POC TN 30 k (M3, M5) + 1 DP UE 18 k€ (M2) + 4 PME |
| **Signé** | 0 | 62 500 | 130 300 |
| **Encaissé** | **0** | **50 000** | **100 300** |
| Non-dilutif (bourse fondateur + prix) | 18 000 | 18 000 | 33 000 |
| Burn (équipe 1→3 ing., infra/LLM, divers) | 63 800 | 94 400 | 111 600 |
| **Trésorerie fin M6** (apport 30 k inclus) | **−15 800** | **+3 600** | **+51 700** |
| **Point bas de trésorerie** | −15 800 | **−3 650 (M5)** | +13 200 |

```mermaid
xychart-beta
    title "Trésorerie cumulée M1-M6 (TND) — Prudent · Réaliste · Optimiste"
    x-axis [M1, M2, M3, M4, M5, M6]
    y-axis "TND" -20000 --> 70000
    line [17700, 7400, 1600, -4200, -10000, -15800]
    line [13200, -1600, 4850, 5850, -3650, 3600]
    line [13200, 28550, 32550, 17550, 64700, 51700]
```

*Lecture des courbes (repère au M6) : en bas le Prudent (−15,8 k), au milieu le Réaliste (+3,6 k), en haut l'Optimiste (+51,7 k). Le creux du Réaliste au M5 (−3 650) est le point qui dimensionne l'apport initial.*

### F.3 Enseignements du modèle

1. **Le prudent est insolvable avec 30 k TND d'apport** → dimensionner l'apport initial à 40-50 k TND (c'est le point bas qui dicte le cash de départ, pas la fin M6).
2. **Le design partner UE porte le scénario réaliste** (33,5 k des 50 k encaissés : il paie à 30 j, son solde rentre dans la fenêtre ; le solde bancaire TN tombe au M8).
3. **Hiérarchie des risques (sensibilité)** : DP non signé −33 500 > DSO export à 60 j −16 750 > POC banque décalé de 2 mois −12 500 > remise de 30 % −3 750 > 1 PME en moins −2 000. Conséquence : **céder sur le prix, jamais sur la date de signature**, et deux fers au feu export dès M1.
4. **Indicateurs avancés (fin M3)** : 3 propositions de POC envoyées + 2 discussions export avancées, sinon trajectoire mécaniquement "prudent" — corriger à M3, pas à M5. Pipeline à semer (réaliste) : 18 comptes TN → 6 RDV → 3 propositions → 1 signature ; 6 intros export → 1 DP.
5. Le non-dilutif (bourse fondateur Startup Act, prix de concours, subventions Smart Capital) est souvent **supérieur aux revenus du scénario prudent** : à activer dès M1, en parallèle du build.

---

## Annexe G — Paiement des fournisseurs LLM/cloud depuis la Tunisie

*Le dinar n'est pas librement convertible ; les coûts LLM sont récurrents et en USD. Voies légales, à valider avec banquier et expert-comptable (régime de change évolutif par circulaires BCT).*

### G.1 Les 5 voies

| Voie | Capacité | Quand |
|---|---|---|
| **Carte Technologique Internationale** (circ. BCT 2015-05) | 10 000 TND/an (personne morale) — couvre hébergement, licences, outils dev, abonnements | Dev M1-M4 uniquement : le scénario Démarrage (~$600/mois ≈ 22 k TND/an, Annexe C) crève ce plafond dès M5-M6 |
| **CTI + label Startup Act** | **100 000 TND/an** pour les sociétés labellisées (~$32 k/an) | Dès le label — couvre Démarrage et début de Croissance |
| **Compte spécial en devises (Startup Act)** | Alimenté librement par capital, CA et dividendes en devises ; paiements internationaux libres | La vraie réponse : chaque € export paie directement Anthropic/AWS — boucle auto-entretenue |
| **Revendeur cloud local facturant en TND** | Claude via **Amazon Bedrock** ou **Microsoft Foundry (Azure)** revendu par un partenaire local ; marge 5-15 % | À tout moment ; supprime le risque de change ET simplifie la fiscalité (facture tunisienne) |
| **Structure duale** (holding étrangère + SARL R&D) | La holding contracte fournisseurs et clients internationaux ; la SARL facture la R&D en devises | Quand l'export domine (M12-18+) ; chantier prix de transfert |

### G.2 Revendeurs identifiés & annuaires

- **Route AWS/Bedrock : LinSoft** (Tunis, filiales Casablanca/Alger) — partenaire AWS officiel (conseil, intégration, commercialisation, formation autorisée), listé dans l'AWS Partner Solutions Finder.
- **Route Azure/Foundry : SPG** (Tunis) — distributeur Microsoft depuis 1992, **Microsoft Indirect Cloud Solution Provider / grossiste Cloud Afrique francophone** (marketplace KATY) ; les modèles Claude sont disponibles dans Microsoft Foundry, et dans le programme CSP la devise du client est fixée par le contrat avec le partenaire → facture en TND possible. SPG étant grossiste, il oriente parfois vers un revendeur agréé de son réseau.
- Élargir : AWS Partner Solutions Finder (filtre Tunisie), annuaire Microsoft "Trouver un fournisseur de solutions", Google Cloud Partner Directory (tissu plus mince — souvent via Maroc/France) ; opérateurs télécoms locaux à sonder au cas par cas.

### G.3 Checklist de négociation revendeur

① Revendez-vous la **consommation pay-as-you-go** (Bedrock/Foundry), pas seulement des licences ? — éliminatoire · ② Activation de l'accès aux **modèles Claude** en région UE ? · ③ Facture tunisienne **en TND, TVA locale**, taux de change figé quand ? · ④ **Marge** (référence 5-15 % ; au-delà, comparer à l'API directe via CTI 100 k) · ⑤ **Propriété du compte** et réversibilité (transfert, accès IAM admin) · ⑥ Alertes/plafonds de consommation, engagement minimum, délais de paiement.

### G.4 Fiscalité & réversibilité

Achat direct de services numériques étrangers = en principe **TVA sur services importés en autoliquidation** + retenue à la source éventuelle selon convention fiscale — à cadrer avec l'expert-comptable dès le premier abonnement (redressement classique). La facture locale du revendeur simplifie ce volet. Position de force structurelle : le **llm-proxy (§12)** route indifféremment API Anthropic directe / Bedrock / Foundry — le choix du canal de paiement est réversible en une ligne de config, et le revendeur se remet en concurrence chaque année.

Séquence recommandée : M1-M3 CTI standard + dossier de label déposé → dès le label, CTI 100 k + compte spécial en devises → devis revendeur Bedrock en parallèle → arbitrage au coût total.

---

## Annexe I — Historique des versions & correspondance

### I.1 Correspondance de numérotation (v4.0)

| N° v4.0 | N° v1-v3.5 | Section |
|---|---|---|
| 1 | 1 | Résumé exécutif |
| 2 | 28 | Catalogue des capacités de l'agent |
| 3 | 29 | Modes de déploiement : Personnel vs Équipe |
| 4 | 27 | Spécification de l'UI Web |
| 5 | 2 | Principes de conception |
| 6 | 3 | Diagramme d'architecture global |
| 7 | 4 | Couche Clients |
| 8 | 5 | API Gateway & Backend Core |
| 9 | 6 | Prompt Layer |
| 10 | 7 | Agent Orchestrator |
| 11 | 8 | Sandboxes Docker |
| 12 | 9 | OpenCode Agent |
| 13 | 10 | MCP Gateway |
| 14 | 11 | Serveurs MCP |
| 15 | 12 | Automatisations & Crons — Trigger.dev |
| 16 | 13 | Données & Persistance |
| 17 | 14 | Sécurité |
| 18 | 15 | Flux de bout en bout |
| 19 | 16 | Observabilité |
| 20 | 17 | Stratégie de tests & évals |
| 21 | 18 | Taxonomie d'erreurs & contrats |
| 22 | 19 | Infrastructure & Déploiement |
| 23 | 20 | Scalabilité, HA & DR |
| 24 | 26 | Console Admin & Exploitation (ops solo) |
| 25 | 21 | Modèle de coûts & capacité |
| 26 | 22 | Stack technique récapitulative |
| 27 | 23 | Structure du monorepo |
| 28 | 24 | Architecture Decision Records |
| 29 | 25 | Roadmap d'implémentation |

Les annexes A-H conservent leurs lettres. Les références de section dans l'historique ci-dessous ont été converties vers la numérotation v4.0.

### I.2 Historique des versions

**v4.2 :** §30 Commercialisation & Protection (pricing, juridique, SLA, onboarding org) ; §15.8 automatisations événementielles ; §17.5 réponse à incident ; antivirus §17.2 ; chiffrement volumes §11.2 ; registre de prompts et boucle feedback→évals §20.2 ; i18n §7.4 ; checklist Annexe D étendue.
**v4.1 :** ajout de 10 diagrammes Mermaid rendus (vue d'ensemble §6, pipeline §9, états sandbox §10.1 et jobs §15.4, séquences §18.1/§18.3, pie des coûts §25, barres coût/tour Annexe C, courbes de trésorerie Annexe F, Gantt §29) ; correction du mois du point bas de trésorerie Réaliste (M5).
**v4.0 :** restructuration en 6 parties + annexes groupées, renumérotation complète avec réécriture automatique des références croisées, historique déplacé ici.


### I.3 Journal de build (implémentation) — juillet 2026

> Cette sous-section suit l'**état d'implémentation** du blueprint (le spec reste v4.2). Le
> monorepo n'est pas un dépôt git ; état reconstruit via l'index vectoriel (`vectordb/`).

**Stratégie retenue (revue CEO).** Construction du **wedge M0 « gouvernance d'abord »** plutôt
que l'ordre P0→P7 : on livre d'abord la moitié sécurité-critique (celle qui referme un pilote
grand-compte régulé), on diffère l'infra sandbox/scheduler coûteuse. Cadence adaptée au runway
(Annexe F) : vendre sur démo, pas sur plateforme finie.

**État : 101/102 tickets faits, 1 en cours (AX-091, SLO production), 0 todo. 37 suites de tests vertes** (`make test-all`, ~390 tests Python/TypeScript/Go). Passerelle go-live : 14/14 (`tools/go_live_gate.sh`).

**Chaîne de gouvernance — chaque maillon construit + vérifié indépendamment :**
Slack (signature+normalisation) → classification + `tool_policies` → **TASK JWT signé** (HS256,
compat py↔ts vérifiée) → autorisation Gateway + audit → injection credential (Vault, AES-256-GCM,
jamais dans le sandbox) → **DLP** en sortie → connecteur → approbation (pas d'auto-approbation §3.3)
→ **révocation à l'instant du fire** (§18.3, `E_PERM_REVOKED`) → audit persisté → agent d'équipe
Mode B (protection deputy confus §3.2).

**Arêtes réelles (money/blast-radius), derrière leurs interfaces stub :**
- **llm-proxy `AnthropicBackend`** — SDK `anthropic`, import paresseux (le chemin stub reste
  hors-ligne), toute erreur fournisseur → `BackendError` (fallback §9.5). Bascule live :
  `provider: anthropic` + `ANTHROPIC_API_KEY`.
- **GitHub `RestBackend`** — `fetch` natif (sans dépendance), token par appel depuis
  `ctx.credential` (fallback env uniquement derrière `OLMA_STANDALONE_DEMO=1`), mapping
  statut GitHub → taxonomie §21, `repo`/`path` validés+encodés.

**Passe de durcissement (revues CEO + ingénierie, chaque correctif testé) :**
- **Sécurité :** DLP couvre désormais le chemin d'ERREUR + les formes `ghs_`/`gho_`/`sk-ant-` ;
  garde SSRF navigateur parse les hôtes (IP décimales/hex, CIDR privés, IPv6, metadata bloqués) ;
  approbations fail-closed ; secrets d'auth + `exp` du TASK JWT fail-closed sous `OLMA_ENV=prod`.
- **Correction :** prix Opus 4.8 corrigé 15/75 → **5/25** + garde-fou de dérive
  (`reference_prices.py`, refus de démarrer si dérive) ; tour intégré émet toujours
  `agent.error`+`agent.done` ; `fire_job` n'enregistre la clé d'idempotence qu'au succès
  (plus de fire perdu silencieusement) via `RunsStore` enfichable (Postgres injectable = dedup
  durable) ; `resume` propage le kill-switch ; validation des entrées du pipeline.
- **Boucle d'approbation complétée :** `reapprove_task_jwt` + `/internal/reapprove` promeuvent
  un outil approuvé de `approval_tools` vers `allowed_tools` et le ré-invoquent via le Gateway
  (était un trou stubbé).

**Vérifications réelles cette itération :** OpenCode tourne vraiment (`TestRealOpenCodeServer`) ;
test de charge k6 réel (9 447 req, p95 267 ms < SLO, 0 % d'échec) ; scan gitleaks (fuite de clé
réelle trouvée + corrigée) ; **démo hors-ligne reproductible** `make demo-governance` (les 4
services stub, tour + boucle de ré-approbation de bout en bout, sans clé) ; **vue Journal d'audit**
dans l'UI web (§4.4 — qui a agi, pour le compte de qui, verdict, caviardages DLP).

**Bloqueurs honnêtes (entrées externes requises, pas du code) :** un tour réellement live exige
une `ANTHROPIC_API_KEY` (plafonnée) + un `GITHUB_TOKEN` scopé à un dépôt jetable ; **AX-091**
(99,9 % sur 7 jours) exige une fenêtre de production mesurée. Tout le reste est construit,
durci et testé.


**Changelog v3.5 :**
- **§3** Modes de déploiement : **Mode A (agent personnel)** — le modèle du blueprint — et **Mode B (agent d'équipe partagé)**, credentials de l'organisation + identité du demandeur conservée pour l'autorisation, les approbations et l'audit. Approbateurs désignés, claim `on_behalf_of`, mémoire organisationnelle par défaut, pool de sandboxes avec git comme état de vérité, table des deltas par section.
- Colonne `approver_group` ajoutée à `tool_policies` (§16.1) ; pointeur dans le résumé exécutif.

**Changelog v3.4 :**
- **Annexe H** Benchmark & politique de sélection des modèles LLM : limites des leaderboards publics (scaffolds, contamination, reward hacking), benchmarks pertinents par rôle, état du terrain mi-2026 par tier (frontier / équilibre / éco / open-weights souverain), configuration de routing recommandée pour le llm-proxy, protocole de bench interne trimestriel.
- Pointeur ajouté dans le Routing (§9.5) vers l'Annexe H.

**Changelog v3.3 :**
- **§2** Catalogue des capacités de l'agent : les 6 familles de capacités avec exemples bout en bout, la combinatoire, les comportements de sécurité permanents et les impossibilités par conception — la section à mettre entre les mains d'un prospect ou d'un investisseur.

**Changelog v3.2 (architecture mémoire complète) :**
- **§9.1 réécrite** : 7 types de mémoire (travail, sémantique, procédurale/workspace, corrections, épisodique, entités temporelle, organisationnelle) + mémoire d'état des automatisations, avec phasage v1/v2/v3.
- **Memory MCP** (§9.1.1, §14) : la mémoire devient un outil audité — `memory.save/search/update/forget` derrière la Gateway.
- **Mémoire d'entités temporelle** (§9.1.2) : DDL `entities`/`entity_facts` avec `valid_from`/`valid_to` — les faits contredits sont clôturés, jamais écrasés.
- Garde-fous mémoire (§9.1.3) : DLP à l'écriture, interdiction des faits sur des tiers, page "Mémoires" dans l'UI (§4.4), job `memory-consolidation` hebdomadaire (§15.7), colonne `scheduled_jobs.job_memory` pour l'état entre runs.

**Changelog v3.1 (volet produit & business) :**
- **§4** Spécification de l'UI Web : parcours d'authentification (login/register/forgot/OTP), les 5 pages applicatives, mapping `AgentEvent` → composants d'interface, design tokens (prototype React livré séparément : `plateforme-ui.jsx`).
- **Annexe E** Marché & valorisation (Tunisie) : écosystème chiffré, positionnement, jalons de valorisation, trajectoire à 18 mois, métriques déterminantes, risques pays.
- **Annexe F** Plan financier des 6 premiers mois : 3 scénarios signé/encaissé/burn/trésorerie, sensibilités, indicateurs avancés (modèle détaillé : `plan-tresorerie-6mois.xlsx`).
- **Annexe G** Paiement des fournisseurs LLM/cloud depuis la Tunisie : les 5 voies légales, revendeurs identifiés, checklist de négociation, points fiscaux.

**Changelog v3.0 (passe de profondeur technique) :**
- **§8.3** Contrats API détaillés : exemples requête/réponse, pagination cursor, protocole WebSocket complet (séquences, reprise `last_seq`, codes de fermeture).
- **§9.6** Structure du contexte LLM & stratégie de prompt caching (ordre des blocs, `cache_control`, règles anti-invalidation, hit rate cible ≥ 75 %). Scoring mémoire hybride (§9.1) et détail du classifieur (§9.2).
- **§10.4** Algorithmes de l'Orchestrator : dimensionnement du pool chaud, placement bin-packing, séquences de réveil chronométrées, leader election et reconstruction d'état.
- **§13.4-10.5** Format complet du TASK JWT, rotation des clés de signature, règles DLP concrètes.
- **§16.3** Volumétrie chiffrée par table, partitionnement, réglages pgvector/autovacuum, migrations expand/contract.
- **§17.4** Matrice de flux réseau complète (source → destination, port, authn).
- **§19** Catalogue de métriques Prometheus nommées + requêtes PromQL des SLO.
- **§22.3** Pipeline CI/CD étape par étape + NetworkPolicy sandbox réelle.
- **Annexe C** Modèle de consommation tokens Sonnet 4.6 (coûts par tour, 3 scénarios, leviers). **Annexe D** Checklist go-live.
- Renouvellement du TASK JWT sans redémarrage : tmpfs `/run/secrets/task_jwt` relu à chaque appel (§11.2).

**Changelog v2.2 :**
- Nouvelle sous-section **§7.2.1 Gestion des mentions Slack** : ACK < 3 s, classification simple/complexe, progression par jalons, **escalade en cours de tour** (classification réversible), table des cas de bord (canaux publics & confidentialité, tâches longues, annulation, messages concurrents).
- Événement `agent.escalated` ajouté au contrat `AgentEvent` (§7.4) ; escalade documentée dans le Planning (§9.2).

**Changelog v2.1 :**
- Nouveau catalogue de **connecteurs MCP additionnels** priorisé (§14.2) et **processus d'onboarding industrialisé** d'un connecteur : niveaux d'effort, template, checklist (§14.3).
- Nouvelle section **Console Admin & Exploitation solo** (§24) : écrans de la console, API admin, CLI `platctl`, politique d'alerting bi-niveau, auto-remédiation, runbooks, dogfooding via l'org interne `org-platform`.
- Nouveaux jobs internes Trigger.dev : `dlq-redrive`, `cert-expiry-check`, `pool-warmer` (§15.7).

**Changelog v2.0 :**
- Intégration de **Trigger.dev v4 (self-hosted)** comme moteur d'automatisations : crons créés par les agents, jobs internes de plateforme, retries durables.
- Nouveau serveur **Scheduler MCP** : l'agent peut créer, lister, modifier, mettre en pause et supprimer des tâches planifiées pour son utilisateur.
- Nouvelles sections : Stratégie de tests & évals d'agents (§20), Taxonomie d'erreurs & contrats (§21), Modèle de coûts & capacité (§25), Architecture Decision Records (§28), Glossaire (Annexe B).
- Sécurité des webhooks entrants détaillée (Slack signing, Bot Framework JWT), versioning d'API et de schémas d'événements, idempotence généralisée.
# ASH
