# PLAN DE DÉVELOPPEMENT — DE A À Z
### Plateforme d'agents IA multi-utilisateurs · extrait 100 % technique du blueprint v4.2 + Annexe J

**Périmètre :** ce document ne contient que du *comment construire*. Aucun contenu produit, business, tarifaire, marché ou historique de versions. Chaque section renvoie au § du blueprint qui fait foi.

**Légende d'état** (source : Annexe J, réconciliation 2026-07-14) : ⬜ non commencé · 🟦 partiel / stub / bloqué-environnement · 🟩 fait + testé.

> **Passe de vérification code ↔ doc (2026-07-15).** Les marqueurs ont été confrontés au code réel, puis une passe de correction a fermé 3 des écarts (tests rejoués : web **11/11**, backend-core **68 passed / 4 skipped**).
>
> **Écarts corrigés (✅ 2026-07-15) :** (3) reprise WebSocket `last_seq` — désormais réelle (`events.ts applyIncomingEvent` + suivi par ref dans `Chat.tsx`, dedup `seq ≤ last_seq`), L1 2.3/2.9 **atteints** ; (4) onglet Audit — mock `DEMO_AUDIT` **supprimé**, fetch réel de `/conversations/{id}/audit` par défaut, dégradation propre en état vide si backend indispo ; (5) routes backend-core `automations` (CRUD + runs, owner-scopé), `admin/*` (5 collections, gated `_require_admin`), `/internal/scheduled-runs` (gated service-token, publie `channel=scheduler`) — **implémentées + testées** (`test_automations.py`, 17 tests). *Réserve :* les 5 collections `admin/*` renvoient des pages vides bien formées (`TODO(§24.x)` — pas encore de source de données câblée).
>
> **2ᵉ passe de correction (✅ 2026-07-15) :** (2b) **seam Redis du TaintLedger implémenté** — `RedisTaint` côté Gateway (`taint.ts`, `SET NX EX 900` monotone) *et* prompt-layer (`redis_taint.py`), tous deux gated par `REDIS_URL`, **in-memory reste le défaut** (offline/keyless intact) ; les deux pointent sur le même Redis en prod (clé `taint:{task_id}`, TTL aligné sur le TASK JWT). Tests : gateway **17/17**, prompt-layer **167**. (7) **type d'identité connecteur rendu** — chip mono dérivé de la table §14 (`identityTypeLabel`, ADR-017-safe : métadonnée statique, pas un statut inventé). (8) **`admin/audit` + `admin/usage` sur données réelles** — lecture `audit_log` / `usage_daily` via `PgStore`, curseur opaque réutilisé, dégradation vide sans `DATABASE_URL` (validé contre un Postgres jetable : **80 passed**).
>
> **3ᵉ passe (✅ 2026-07-15) :** (1b) **ES256/JWKS livré comme seam config-gated** — `verifyES256` (shared-ts, `crypto` natif, JWKS + `kid`), mint ES256 côté prompt-layer (`task_jwt.py`), agrément inter-langage prouvé par vecteur de test commis ; **HS256 reste le défaut** (offline). Revue de sécurité : **risque FAIBLE, 0 critique/haut/moyen** (pas de confusion d'algo / downgrade / `alg:none`, fail-closed partout) ; 1 durcissement appliqué (`hasOwnProperty` sur le lookup `kid`). Tests : gateway **20**, shared-ts **12**, prompt-layer **173**. (5c) **les 5 `admin/*` sur données réelles** (voir §3.2). *Reste, non-code :* la rotation JWKS live (rechargement /5 min) est chargée-au-boot pour l'instant ; le round-trip OIDC réel (Entra/Slack) ; l'enveloppe KMS.

**Écart restant (⚠️ dette de style, non bloquant) :** (6) `xcheck.ts` vérifie le JWT/traceparent, pas les schémas. Le noyau identité/RLS/billing (L4, L5) est conforme.

**Sommaire**
- [0. Invariants d'architecture](#0)
- [1. L0 — Socle](#l0)
- [2. L1 — Frontend](#l1)
- [3. L2 — Backend](#l2)
- [4. L3 — OpenCode + Trigger.dev + MCP + Slack](#l3)
- [5. L4 — Chaîne d'identité](#l4)
- [6. L5 — Quota + Billing](#l5)
- [7. L6 — Qualité, exploitation, go-live](#l6)
- [8. Ordre d'exécution & dépendances](#ordre)
- [Annexe 1 — Taxonomie d'erreurs](#a1) · [Annexe 2 — SLO & métriques](#a2) · [Annexe 3 — Checklist go-live](#a3) · [Annexe 4 — Écarts de contrat à trancher](#a4)

---

<a id="0"></a>
## 0. Invariants d'architecture

Ces huit règles ne se négocient pas. Chaque lot en est une déclinaison ; toute PR qui en viole une est rejetée, quel que soit le gain fonctionnel.

| # | Invariant | Imposé où | Conséquence si violé |
|---|---|---|---|
| 1 | **Identity-first** — le `user_id` canonique est résolu à l'entrée et voyage dans un JWT **signé**. Aucun composant ne fait confiance à un identifiant non signé. | §5.1, §17.1 | Deputy confus, audit aveugle |
| 2 | **Fail-closed** — Prompt Layer / permissions / Gateway indisponible ⇒ **refus**, jamais de bypass. En prod (`OLMA_ENV=prod`), un secret d'auth absent ou un `exp` manquant ⇒ **le service refuse de démarrer**. | §5.5, ADR-013 | Porte dérobée |
| 3 | **Zéro secret dans le sandbox** — seul le TASK JWT (15 min, tmpfs) y vit. Les tokens tiers ne quittent jamais la Gateway. | §5.2, §11.2, §13.2 | Exfiltration de credentials org |
| 4 | **Egress sandbox = `mcp-gateway:8443` + `llm-proxy:4000`, rien d'autre.** Pas d'Internet, pas de Postgres, pas de Redis, pas de DNS externe. | §17.4, §22.3 | Évasion, exfiltration |
| 5 | **Un seul chemin de sécurité** — crons et webhooks **ré-injectent** un `InboundMessage` dans le pipeline normal. Le worker ne fait aucun travail d'agent. | ADR-005 | Deux chemins de contrôle à maintenir = un chemin non testé |
| 6 | **Permissions évaluées au feu, jamais figées.** Un cron n'embarque aucun token ni permission. | ADR-006, §9.4 | Escalade différée, persistance post-offboarding |
| 7 | **Idempotence partout** — et `fire_job` n'enregistre la clé **qu'au succès** (dedup-on-success). | §5.8, ADR-016 | Occurrences perdues à jamais |
| 8 | **La détection n'est pas une frontière** — le taint est posé **mécaniquement** depuis les métadonnées d'outil, jamais inféré du contenu par un classifieur. Idem RLS : l'isolation tenant est imposée par Postgres, pas par le code applicatif. | §17.6.1, §16.4 | Un bug applicatif fait fuiter une autre org |

**Contrats de bord (à figer avant toute ligne de code) :**
- `InboundMessage` et `AgentEvent` sont les **seuls** formats d'entrée/sortie, tous canaux confondus (`teams|slack|web|scheduler|webhook`).
- `schema_version` obligatoire ; évolutions **additives uniquement** (jamais de suppression/renommage sur une version majeure) ; consommateurs en *tolerant reader*.
- Toute écriture porte `Idempotency-Key`. Les retries automatiques ne s'appliquent **qu'aux opérations idempotentes**.
- Les événements bus sont livrés **at-least-once** → tous les consommateurs dédupliquent par `message_id` / `idempotency_key`.

---

<a id="l0"></a>
## 1. L0 — Socle (bloquant pour tout le reste)

| # | Étape | Livrable | État |
|---|---|---|---|
| 0.1 | Monorepo | `platform/` : `apps/` · `services/` · `sandbox/` · `packages/` · `evals/` · `infra/` · `db/migrations/` · `docs/` | 🟩 |
| 0.2 | Schémas partagés | `packages/schemas/` — `InboundMessage`, `AgentEvent`, `AgentTask`, `ScheduledJob`. Source de vérité unique → codegen **TS + Pydantic** (réel : `gen.py`, `test_schemas.py`). ⚠️ **Écart vérifié :** `xcheck.ts` vérifie en réalité le **JWT/traceparent** inter-langage, pas les schémas ; la compat « vN lit vN-1 » est un test *tolerant-reader / champ additif*, pas une fixture de version antérieure. | 🟩 (nuances) |
| 0.3 | Taxonomie d'erreurs | `packages/errors/` — codes §21 partagés TS/Py, corpus de test dédié. Partagée **Gateway + guardrails** (les règles DLP y vivent aussi). | 🟩 |
| 0.4 | Compose dev | pgvector · Redis · NATS (`-js`) · Vault dev · Trigger.dev v4 · les 8 services. **En dev, les crons ne se déclenchent que si `trigger dev` tourne** — voulu, évite les feux fantômes. | 🟩 |
| 0.5 | Migrations | Atlas + **lint expand/contract** : toute migration est additive en release N (colonne nullable + double écriture) ; le `DROP`/`NOT NULL` arrive en N+1. **Destructive dans la même release = build rouge.** | 🟩 |
| 0.6 | CI | `lint → unit (≥ 80 % sur le code de décision) → contrats → évals gate (régression > 3 % = STOP) → build (SBOM syft + cosign) → Trivy (CRITICAL = STOP) → gitleaks → migration-lint → staging → trigger deploy → prod (approbation manuelle, canary 10 %) → post-deploy (rollback auto si burn rate > 14×)` | 🟩 |
| 0.7 | Seams de swap | **ADR-012** : toute arête réelle (LLM, connecteurs, RunsStore, Backend) derrière une **interface stub commune**, swap **par config**, zéro `if provider ==` dispersé. Le chemin dev/test reste **hors-ligne, sans clé**. | 🟩 |

> **Dette ouverte (J.3)** : `gitleaks` lève un faux positif sur l'UUID d'exemple `Idempotency-Key: 7c9e6679-…` du README (détecté `generic-api-key`). Ajouter la ligne à `.gitleaks.toml`. C'est le seul rouge de `make test-all` (36/37 vertes).

---

<a id="l1"></a>
## 2. L1 — Frontend (Web App)

**Stack :** React 18 + TypeScript + Vite · TailwindCSS · TanStack Query · Zustand · shadcn/ui · WebSocket (fallback SSE).
**Nom de produit provisoire :** Axone.

### 2.1 Parcours d'authentification (§4.1)

| Écran | Comportement | Sécurité |
|---|---|---|
| Login | Email + pwd, ou SSO Entra ID / Slack (mêmes providers que `identities`) | Rate limiting dédié ; **message d'erreur identique** compte inexistant / mauvais mot de passe |
| Register | Nom, email pro, **organisation** (multi-tenant dès l'inscription), pwd ≥ 12 car. | Vérification email avant activation |
| Mot de passe oublié | Réponse **neutre** ("si un compte existe, un lien a été envoyé"), lien 15 min, usage unique | Ne révèle **jamais** l'existence d'un compte |
| OTP | 6 cases auto-avance, backspace intelligent, expiration 10 min, renvoi throttlé | Systématique après login/register (email par défaut, TOTP en option) |

**État :** la porte d'entrée existe (`LoginControl` en barre haute, presets `usr_mehdi`/`usr_sarah`, token RS256 stocké en `localStorage`, envoyé en Bearer ; déconnexion → repli `usr_dev`). 🟩 — Le vrai parcours OIDC (Entra/Slack) remplace `/oidc/dev-login` ; l'étape de mint est déjà en place.

### 2.2 Coquille applicative (§4.2)

Sidebar fixe 5 entrées — **Chat · Connecteurs · Mon agent · Profil · Facturation** — plus une **jauge de budget mensuel permanente** (la maîtrise des coûts rendue visible à l'utilisateur, pas cachée dans une page d'admin). Responsive : sidebar à 64 px et liste de conversations repliée sous 860 px. `prefers-reduced-motion` respecté. Focus clavier visible sur **tous** les éléments interactifs.

### 2.3 Protocole temps réel (§8.3)

```
Client  → { "type": "subscribe", "last_seq": 0 }      # last_seq > 0 = reprise
Serveur → { "type": "agent.text.delta", "seq": 41, "data": {...} }
        → { "type": "agent.done",       "seq": 57, "data": { "usage": {...} } }
Ping/pong 30 s ; absence de pong ×2 → fermeture 1011.
```
- Chaque événement porte un **`seq` monotone par conversation**. À la reconnexion, le client envoie son `last_seq` ; le serveur rejoue le delta depuis **NATS JetStream** (replay natif). **Aucun événement perdu sur coupure réseau, aucune duplication** (le client ignore `seq ≤ last_seq`).
- Codes de fermeture : `4001` JWT expiré (re-auth silencieuse puis reprise), `4003` accès refusé, `1011` erreur serveur (backoff exponentiel 1 s → 30 s).
- Fallback SSE : mêmes événements, reprise via `Last-Event-ID`.

> ✅ **Corrigé (2026-07-15) :** la reprise `last_seq` est désormais réelle. `events.ts` expose `applyIncomingEvent(ev, lastSeq)` (dedup `seq ≤ last_seq`, avance `last_seq`) ; `Chat.tsx` suit `last_seq` dans un `useRef` persistant entre reconnexions et l'envoie dans le `subscribe` (plus de `0` en dur). Rejeu out-of-order après reconnexion entièrement dédupliqué. 3 tests ajoutés dans `test/events.test.ts` (11/11 verts). Mode démo intact.

### 2.4 Mapping `AgentEvent` → UI (§4.3)

| Événement | Rendu |
|---|---|
| `agent.thinking` | indicateur d'activité |
| `agent.text.delta` | bulle en **streaming token par token** — le Web est le **seul** canal à vrai streaming |
| `agent.tool.call` / `agent.tool.result` | ligne monospace compacte `✓ sentry.list_issues — résumé` (cyan = outil, vert/rose = statut) |
| `agent.approval.needed` | **carte ambre** : outil, résumé lisible des arguments, boutons Approuver / Refuser. **Index-safe** : clé `approvalId`, jamais un index de tableau |
| `agent.file.created` | lien de téléchargement signé (15 min) |
| `agent.cron.created` | chip ⟳ ambre + horaire humain + prochaine exécution |
| `agent.escalated` | indicateur discret « je regarde dans \<outil\>, un instant ⏳ » |
| `agent.done` | pied de message : **coût du tour + latence du tour** |
| `agent.error` | message de la taxonomie §21, formulé utilisateur |

Liste de conversations : celles issues de crons sont marquées **⟳ ambre** avec leur horaire. Composer : rappel du budget du tour et du principe d'approbation sous le champ de saisie.

### 2.5 Panneau droit à onglets (shadcn `Tabs`) 🟩

- **Audit** — qui a agi, **pour le compte de qui** (`on_behalf_of`), verdict, caviardages DLP. ✅ **Corrigé (2026-07-15) :** mock `DEMO_AUDIT` supprimé, `live` par défaut → fetch réel de `/conversations/{id}/audit` (shape identique à `AuditEntry`) ; état vide propre si backend indispo (principe proxy tolérant ADR-017).
- **Mémoires** — groupées par type (faits, préférences, procédures, corrections), recherche, édition, suppression unitaire ou en masse. **Badge « non fiable »** sur toute mémoire `source_trust = untrusted`. ✅ *réel* : fetch `/api/v1/memories`, `groupMemories`, badge sur `source_trust==="untrusted"`.
- **Connecteurs** — statut **réel** (lu depuis `/me`), **type d'identité affiché**, section séparée « Inclus par votre organisation » (Browser, Database, Scheduler), bouton **Connecter**. ✅ **Corrigé (2026-07-15) :** chip mono par connecteur (OAuth utilisateur / Permissions déléguées / Compte de service / Service token…) via `identityTypeLabel` dérivé de la table §14. ADR-017-safe (métadonnée statique du provider, **pas** un statut inventé). Le champ `/me` dédié reste un TODO backend (dérivation client en attendant).

### 2.6 Autres pages (§4.4)

- **Mon agent** — profil (dev / généraliste / data / ops), toggles d'approbation dont certains **verrouillés par l'organisation** (rendu direct de la matrice `tool_policies`), liste des automatisations (pause/reprise, coût par run, quota **n/20**).
- **Profil** — identité, canaux liés (table `identities`), sécurité (pwd, 2FA, sessions actives), **zone RGPD** branchée sur le job `user-erasure`.
- **Facturation** — voir L5.5.

### 2.7 Design tokens (§4.5)

Identité « salle de contrôle » : fond `#0A0F1C`, panneaux `#101A2E`, texte `#E8EEF9`.
**Sémantique de couleur stricte** — cyan `#56C8EA` = action/flux · **ambre `#F5B84B` = tout ce qui touche aux automatisations** · rose `#F06A8A` = sécurité/danger · vert `#5EE6A0` = succès/connecté.
Typographies : Space Grotesk (titres/UI) · Inter (corps) · IBM Plex Mono (labels techniques, outils, données).

### 2.8 Deux interdits produit

1. **Ne jamais inventer un statut de connecteur côté client** (ADR-017). `connected: false` tant qu'aucun token OAuth n'est stocké. Un statut inventé est un mensonge produit.
2. **Les cartes d'approbation d'egress affichent les arguments bruts**, jamais un résumé généré par le modèle (§17.6.4) — un résumé pourrait masquer exactement l'exfiltration qu'on demande à l'humain de repérer.

### 2.9 Critère de sortie L1

Chat streamé de bout en bout avec reprise `last_seq` après coupure réseau ; carte d'approbation fonctionnelle ; les 3 onglets du panneau droit lisent des données réelles (pas de mock).

> ✅ **Statut vérifié (2026-07-15) : atteint.** Reprise `last_seq` réelle (2.3) et onglet Audit sur données réelles (2.5, mock supprimé) ; les 3 onglets lisent du réel. Reste cosmétique : affichage du *type d'identité* connecteur (2.5).

---

<a id="l2"></a>
## 3. L2 — Backend

**Stack :** API Gateway (Kong / Envoy) → `backend-core` (FastAPI, Python 3.12) → `prompt-layer` (Python, stateless) → `orchestrator` (Go, gRPC). Bus **NATS JetStream**.

### 3.1 API Gateway (§8.1)

| Fonction | Détail |
|---|---|
| TLS | cert-manager (Let's Encrypt / CA interne) |
| AuthN | Validation JWT (JWKS de l'auth-service), **rejet fail-closed** |
| Rate limiting | Par `user_id` : **30 req/min chat, 5 conversations simultanées** ; par `org_id` : quotas contractuels |
| WAF | OWASP CRS (ModSecurity) |
| Routing | `/api/v1/chat/*` → backend-core · `/api/v1/admin/*` → backend-core (scope admin) · `/webhooks/teams` → teams-adapter · `/webhooks/slack` → slack-adapter |
| Observabilité | Access logs JSON → Loki ; `traceparent` OTel propagé |

### 3.2 backend-core (§8.2–8.3)

API versionnée `/api/v1`, dépréciation 6 mois avec header `Sunset`.

```
POST   /api/v1/conversations
GET    /api/v1/conversations?cursor=...
GET    /api/v1/conversations/{id}/messages
POST   /api/v1/conversations/{id}/messages      # Idempotency-Key requis → 202
WS     /api/v1/conversations/{id}/stream
POST   /api/v1/conversations/{id}/approve
POST   /api/v1/conversations/{id}/cancel
GET    /api/v1/me                                # profil + connexions OAuth (statut RÉEL)
POST   /api/v1/login                             # proxy auth-service (ADR-018)
POST   /api/v1/connect                           # proxy Gateway /v1/connect (PAT)
POST   /api/v1/connections/{provider}/start | GET .../callback
GET    /api/v1/memories                          # proxy → prompt-layer /internal/memory/list
GET    /api/v1/automations | PATCH|DELETE /{job_id} | GET /{job_id}/runs
GET    /api/v1/files/{id}                        # URL signée S3, 15 min
GET    /api/v1/admin/users|sandboxes|audit|usage|automations
POST   /internal/scheduled-runs                  # mTLS + service token — JAMAIS exposé au Gateway
```

> ✅ **Corrigé (2026-07-15) :** routes ajoutées dans `backend-core/app/main.py` — `GET /api/v1/automations` + `PATCH|DELETE /{job_id}` + `GET /{job_id}/runs` (owner-scopé via `current_identity`, 404 sans fuite d'existence) ; `GET /api/v1/admin/users|sandboxes|audit|usage|automations` (gated `_require_admin` : 401 sans token, 403 sans rôle admin) ; `POST /internal/scheduled-runs` (monté hors `/api/v1`, gated `_require_service_token` X-Service-Token `hmac.compare_digest`, rejette tout JWT user, publie un `InboundMessage {channel:"scheduler"}` → 202). Nouvelles méthodes store (`list/get/update/soft_delete_scheduled_job`, `list_scheduled_runs`) + modèles (`AutomationPatch`, `ScheduledRunSubmission`). Tests : `test_automations.py` (17). **✅ MAJ (2026-07-15) : les 5 collections `admin/*` lisent désormais des données réelles.** `admin/audit`/`admin/usage` (`audit_log`/`usage_daily`) ; `admin/users` (table `users`, colonnes sûres uniquement — `id, org_id, email, name, status, created_at`, **jamais** de hash/secret ni `role`), `admin/automations` (vue **org-wide** de `scheduled_jobs`, distincte du `/automations` owner-scopé qui reste inchangé), `admin/sandboxes` (table `sandboxes` jointe via `users` pour l'org-scope, `sandboxes` n'ayant pas d'`org_id`). Scope : `_admin_org_scope` — un `admin` d'org ne voit que son org (fail-closed), un `platform_admin` voit tout. Curseur opaque réutilisé partout, dégradation vide sans `DATABASE_URL`. Tests `test_admin_data.py` + `test_admin_directory.py` — **83 passed / 9 skipped** hors DB, **92 passed** contre un Postgres live (isolation cross-org prouvée).

**Contrats imposés :**
- `POST /messages` → **202 Accepted** `{message_id, task_id, stream}`. Le travail est asynchrone.
- **Enveloppe d'erreur unique** : `{ "error": { "code", "message", "trace_id", "retry_after" } }`.
- **Pagination cursor opaque** (base64 de `(created_at, id)`), `limit ≤ 100`, réponse `{items, next_cursor}`. **Jamais d'offset** (coût + dérive sous écriture concurrente).
- Le backend-core **ne parle jamais au LLM ni aux sandboxes** : il publie sur le bus, le Prompt Layer et l'Orchestrator consomment.
- **ADR-017** : le read-model du control-room traverse backend-core **en proxy** vers le Prompt Layer, jamais en direct. L'UI n'a qu'un seul origin ; backend-core reste le point d'agrégation d'identité ; le `source_trust` remonte tel quel du `TaintLedger`. **Proxy tolérant aux pannes** : liste vide si le Prompt Layer est down, le panneau rend au lieu de casser.

### 3.3 Données (§16)

17 tables. Points qui comptent :

```sql
CREATE TABLE identities (                  -- mapping canaux → user canonique
  user_id     TEXT REFERENCES users(id),
  provider    TEXT NOT NULL,               -- entra|slack|web
  external_id TEXT NOT NULL,               -- aadObjectId | slack_user_id
  PRIMARY KEY (provider, external_id)
);

CREATE TABLE tool_policies (
  org_id         TEXT REFERENCES orgs(id),
  role           TEXT NOT NULL,
  tool_pattern   TEXT NOT NULL,            -- 'scheduler.create_cron'
  effect         TEXT NOT NULL,            -- allow|deny|require_approval
  approver_group TEXT,                     -- NULL = le demandeur approuve
  PRIMARY KEY (org_id, role, tool_pattern)
);

CREATE TABLE audit_log (                   -- append-only
  ts TIMESTAMPTZ NOT NULL DEFAULT now(),
  id BIGINT GENERATED ALWAYS AS IDENTITY,
  user_id TEXT, org_id TEXT,
  actor TEXT NOT NULL,                     -- agent|user|admin|system|scheduler
  action TEXT NOT NULL, target TEXT, details JSONB,
  PRIMARY KEY (ts, id)
) PARTITION BY RANGE (ts);                 -- partitionné par MOIS
```

| Table | Débit cible v1 | Stratégie |
|---|---|---|
| `messages` | ~40 k/j | index `(conversation_id, created_at)`, rétention 90 j, purge par lot nocturne |
| `audit_log` | ~300 k/j → ~110 M/an | **partitions détachées** puis archivées S3 (WORM) — **jamais de DELETE massif** |
| `memories` | ~250 k vecteurs | HNSW `m=16, ef_construction=64` ; ré-indexation seulement si > 10 % de lignes mortes |
| `scheduled_runs` | ~6 k/j | rétention 90 j |
| `usage_daily` | ~5 k/j | **conservé long terme** (facturation) |

Réglages : autovacuum agressif (`scale_factor = 0.02`) sur `messages` et `scheduled_runs` ; `fillfactor = 90` sur `sandboxes` et `scheduled_jobs` ; **PgBouncer en transaction pooling** ; **PITR** (WAL continu, RPO 15 min), restauration testée trimestriellement.

### 3.4 RLS — isolation multi-tenant imposée par la base (§16.4) 🟩

L'isolation entre organisations **n'est pas laissée à la couche applicative** : un bug applicatif ne doit pas pouvoir faire fuiter une autre org. `db/migrations/0004_tenant_isolation.sql`, en trois pièces :

1. **`org_id` sur les 10 tables tenant** (conversations, messages, memories, entities, entity_facts, scheduled_jobs, scheduled_runs, oauth_tokens, audit_log, usage_daily) — ajouté par migration *expand* avec backfill dénormalisé depuis la ligne parente.
2. **Rôle applicatif non-superuser** `olma_app` : les services s'y connectent, **jamais** avec le propriétaire (qui contournerait RLS). `FORCE ROW LEVEL SECURITY` impose la policy même au propriétaire.
3. **Policy `tenant_isolation`** : `USING (org_id = current_setting('app.org_id', true))` **et** `WITH CHECK` identique — lecture **et** écriture bornées à l'org. `app.org_id` est posé par le pool **à chaque check-out, depuis le claim `org` du JWT vérifié**, jamais depuis un paramètre de requête. `current_setting(..., true)` renvoie NULL si non posé → `org_id = NULL` ne matche rien → **une session sans org ne voit rien** (fail-closed).

**Test de traversée obligatoire en CI** (`test_rls_isolation.py`) : (1) `org_B` voit **0 ligne** de `org_A` ; (2) `WITH CHECK` bloque un insert forgé cross-org ; (3) `org_A` voit bien les siennes ; (4) **le test échoue si on retire la RLS** — prouvant que la RLS *est* la frontière, pas un filtre applicatif accessoire. Skip sans `DATABASE_URL` (le chemin hors-ligne reste intact).

### 3.5 Prompt Layer — pipeline 5 étages (§9)

Service Python **stateless**, consomme `inbound.messages`, produit un `AgentTask` validé.

```
InboundMessage → 1·Memory → 2·Planning → 3·Guardrails → 4·Permissions → 5·Routing → AgentTask + TASK JWT
                                  ↓ bloqué                    ↓ refusé
                       E_GUARD_INPUT_BLOCKED         E_PERM_TOOL_DENIED
```

**Les messages de canal `scheduler` traversent le même pipeline.** Seule différence : pas d'humain dans la boucle → les `require_approval` font échouer proprement l'appel (ou consomment une pré-approbation ciblée).

**1 · Memory** — 7 types (travail Redis · sémantique pgvector · **procédurale** `/workspace/.agent/NOTES.md` — le *comment faire* appris, souvent plus utile que les faits · corrections · épisodique · entités temporelle · organisationnelle) + `scheduled_jobs.job_memory` (état entre runs).
Récupération : top-k (k=8), score **hybride** `0,65×cosinus + 0,20×récence(demi-vie 30 j) + 0,15×fréquence` (+0,15 si `kind='correction'`), seuil 0,55, `expires_at` purge les faits datés. Injection en 3 sections : `<user_memory>` · `<procedural_notes>` · `<episodes>`.
**Memory MCP** (§9.1.1) : `memory.save|search|update|forget` — l'agent décide **délibérément** ce qui mérite d'être retenu (meilleure précision que l'extraction passive, qui reste en filet de sécurité), chaque écriture passe par l'AuthZ **et l'audit**.
**Entités temporelles (§9.1.2) — règle d'or : jamais d'UPDATE destructif.** Un fait contredit est **clôturé** (`valid_to = now()`), le nouveau est ouvert. Les contradictions se résolvent par la temporalité, pas par la dernière écriture.
**Interdits d'écriture (§9.1.3) :** secrets (règles DLP appliquées à `memory.save`), catégories sensibles, et **faits sur des tiers issus de contenus lus** — l'agent qui lit les mails ne stocke **jamais** « Karim cherche un autre job ». Cas de test dédiés dans le corpus adversarial.

**2 · Planning** — classifieur léger (Haiku, few-shot, JSON `{class, confidence}`, ~250 ms). `confidence < 0,7` ⇒ `ambigu`. **Réversible** : `chat_simple` → `task_agentique` via `agent.escalated`. **Le fail-safe est toujours : démarrer léger puis escalader**, jamais l'inverse (réveiller un sandbox « au cas où » coûte cher et ralentit les réponses simples).
Détection d'intention d'automatisation (« chaque lundi », « tous les matins ») → le plan inclut le Scheduler MCP **et la confirmation à l'utilisateur avant création**.

**3 · Guardrails** — fail-closed, deux directions. Entrée : détection d'injection, filtrage PII, politique de contenu, **re-scan des prompts de crons à chaque déclenchement** (la politique org a pu changer). Sortie : DLP, gitleaks en mode librairie sur les fichiers générés, troncature/refus.

**4 · Permissions** — RBAC + ABAC. `tool_policies (org_id, role, tool_pattern) → allow | deny | require_approval`. Calculées **pour ce tour**, signées dans le TASK JWT (`allowed_tools`, `approval_tools`). La Gateway re-vérifie (**défense en profondeur**).

**5 · Routing** — modèle (éco / équilibre / frontier, fallback **cross-provider** obligatoire : incident fournisseur = plateforme morte sinon) + profil OpenCode. Produit :

```json
{
  "task_id": "task_01H...", "origin": "interactive|scheduled", "job_id": null,
  "user_id": "usr_7f3a", "org_id": "org_acme", "conversation_id": "conv_9b2c",
  "agent_profile": "dev", "model": "frontier-large",
  "system_context": { "memory": "...", "plan": "...", "org_rules": "..." },
  "allowed_tools":  ["github.*", "browser.read_*", "scheduler.*"],
  "approval_tools": ["github.merge_pr", "scheduler.create_cron"],
  "budget": { "max_tokens": 120000, "max_seconds": 900, "max_cost_usd": 2.5 },
  "task_jwt": "eyJhbGciOiJFUzI1NiIs..."
}
```

### 3.6 Prompt caching — levier de coût n°1 (§9.6)

Le caching **divise la facture par deux**. Il ne fonctionne que si le préfixe est **octet-pour-octet stable**. Ordre de blocs imposé, du plus stable au plus volatil :

```
1. System prompt plateforme (global, versionné)   ┐
2. Profil d'agent (stable par profil)             │ cache_control
3. Définitions d'outils (tri ALPHABÉTIQUE)        │ (breakpoints)
4. Règles org (stable par org)                    ┘
5. <user_memory>          (varie lentement)
6. Historique             (append-only → cache-friendly)
7. Message courant + résultats d'outils du tour
```

**Règles vérifiées par un test de non-régression :**
- **Aucun élément volatil dans les blocs 1-4** : pas d'horodatage, pas d'ID de tour, pas de compteur. La date du jour, si nécessaire, vit dans le bloc 7.
- **Tri alphabétique déterministe des définitions d'outils** — `allowed_tools` varie par user/tour ; l'ordre garantit que deux tours du même utilisateur produisent le même bloc 3.
- TTL 5 min en boucle agentique, 1 h (écriture à 2×) pour les conversations épisodiques.
- **La compaction ne réécrit jamais les blocs 1-5** ; elle remplace des segments du bloc 6 en fin de fenêtre uniquement.
- Cible mesurée `plat_llm_cache_hit_ratio ≥ 0,75`. Une org sous 0,60 déclenche une investigation — **c'est presque toujours un adaptateur qui injecte un timestamp**.

### 3.7 Orchestrator (Go) (§10)

**Machine à états :** `COLD → WARMING → ACTIVE → IDLE (>10 min) → HIBERNATED (>60 min, conteneur stoppé, volume conservé) → DESTROYED (>30 j, volume archivé S3)`. `FAILED` → kill + recreate.

**Budgets de réveil (SLO) :**

| État initial | Séquence | Cible |
|---|---|---|
| IDLE | dépôt du TASK JWT dans le tmpfs → push du tour | **< 200 ms** |
| COLD, pool chaud dispo | claim conteneur → montage volume → identité → JWT → push | **< 500 ms** |
| HIBERNATED | `start` → healthcheck (probe 500 ms) → JWT → push | **< 4 s** |
| COLD, pool vide | création complète (image chaude sur le nœud) | **< 8 s** |

**Pool chaud** : `target = max(pool_min, ceil(λ_p95 × T_froid) + marge)`, recalculé /60 s par `pool-warmer`. `pool_min = 5` en heures ouvrées, 2 la nuit — la marge absorbe la rafale de 9h00 (corrélée au jitter des crons).
**Placement bin-packing** : `score = 0,5×(1−cpu_réservé) + 0,3×(1−mem_réservée) − 0,2×pénalité_étalement`. La pénalité évite de co-localiser plusieurs sandboxes historiquement gourmands (p95 CPU du user, connu de `usage_daily`).
**Priorités** : **interactif > planifié** (2 classes). Un cron **ne fait jamais attendre un humain**. Runs planifiés en attente > 15 min → replanifiés (retry Trigger.dev) plutôt que de gonfler la file.
**HA** : 2 réplicas actif/passif (K8s Lease, renouvelée /5 s, bascule < 15 s). Au démarrage, le nouveau leader **reconstruit son état** : lecture de `sandboxes` (vérité déclarée) puis **réconciliation** avec l'état réel des nœuds ; divergences corrigées et journalisées. **Les tours en vol survivent** : ils streament via NATS, pas via le process orchestrator.
**Enforcement du budget** : coupe le sandbox si `max_seconds` ou `max_cost_usd` dépassé → `agent.error(E_BUDGET_EXCEEDED)`.

**gRPC :** `SubmitTask(AgentTask) → stream AgentEvent` · `CancelTask` · `GetSandboxStatus` · `HibernateSandbox` · `AdminListSandboxes`.

### 3.8 Boucle de ré-approbation — ADR-015

**Le piège qu'il faut avoir compris avant d'écrire une ligne :** la Gateway ne renvoie que `needs_approval` et **n'exécute jamais** un outil gaté inline. Après l'accord humain, c'est le **Prompt Layer** qui **re-mint** un TASK JWT frais où **seul l'outil approuvé** est promu de `approval_tools` vers `allowed_tools` ; puis on ré-invoque via la Gateway.

- Si le backend mute lui-même la liste → le minting sort de son unique émetteur (faille).
- Si on ré-invoque **sans re-mint** → la Gateway reboucle **éternellement** sur `needs_approval`.

Implémenté : `pipeline.reapprove_task_jwt` + `/internal/reapprove`. 🟩

### 3.9 Critère de sortie L2

Tâche complète depuis le Web avec streaming ; `require_approval` démontré de bout en bout (y compris la ré-approbation) ; test RLS vert **et rouge quand on retire la RLS** ; hit rate de cache ≥ 0,75 mesuré.

---

<a id="l3"></a>
## 4. L3 — OpenCode + Trigger.dev + MCP + Slack bot

### 4.1 Sandbox (§11)

```dockerfile
FROM ubuntu:24.04
RUN apt-get update && apt-get install -y \
    git curl ripgrep jq build-essential python3.12 python3-pip nodejs npm \
    && rm -rf /var/lib/apt/lists/*
COPY --from=opencode/opencode:latest /usr/local/bin/opencode /usr/local/bin/
COPY profiles/ /etc/opencode/profiles/
COPY opencode.json /etc/opencode/
RUN useradd -m -u 10001 agent
USER agent
WORKDIR /workspace
ENTRYPOINT ["opencode", "serve", "--port", "4096", "--hostname", "0.0.0.0"]
```

**Durcissement (§11.2) — non négociable :**

| Mesure | Implémentation |
|---|---|
| Runtime | **gVisor (runsc)** — syscalls interceptés en espace utilisateur |
| Rootless | Docker rootless ou `userns-remap` |
| Capacités | `--cap-drop=ALL`, `--security-opt no-new-privileges` |
| Seccomp | profil custom (défaut + blocage `ptrace`, `mount`, `bpf`) |
| FS | image `--read-only`, `/workspace` = volume user, `/tmp` tmpfs 512 Mo |
| Réseau | **egress uniquement `mcp-gateway:8443` + `llm-proxy:4000`. Pas de DNS externe.** |
| Ressources | cgroups v2 : cpu=2, mem=4Gi, pids=512 |
| Secrets | **Aucun.** Seul `task_jwt` (15 min) en tmpfs `/run/secrets/task_jwt`, **relu à chaque appel MCP** → renouvellement (tour long : ~/12 min) **sans redémarrage**, jamais en variable d'env ni sur disque |
| Images | build reproductible, SBOM, signature cosign, scan Trivy bloquant |
| At-rest | **volumes workspace ET snapshots chiffrés** (LUKS / natif provider, clés KMS) — les workspaces contiennent des clones de repos privés |

**Volume** : 1 par utilisateur (`vol-usr_7f3a`) → `/workspace`. Snapshot quotidien (`volume-snapshot`, 3h) → S3 ; archivage après 30 j d'inactivité.

### 4.2 OpenCode (§12)

- Mode **serveur** (`opencode serve`) : l'Orchestrator pousse les tours via l'API HTTP locale `:4096` et consomme le flux d'événements.
- **Profils** `/etc/opencode/profiles/*.json` (`dev`, `data-analyst`, `ops`, `generalist`) : prompt système du rôle, modèle par défaut, outils MCP activés, `org_rules` injectées depuis `system_context`.
- **Provider LLM unique : `llm-proxy.internal`** (LiteLLM). Il route selon le champ `model`, **compte tokens/coûts par `user_id`/`org_id`/`job_id`**, applique le budget du tour, permet le failover multi-fournisseurs.
- **Un seul serveur MCP déclaré — la Gateway** (`sandbox/opencode.json`) :

```json
{ "mcp": { "gateway": {
    "type": "remote",
    "url": "https://mcp-gateway.internal:8443/mcp",
    "headers": { "Authorization": "Bearer ${TASK_JWT}" } } } }
```

L'agent voit donc dynamiquement la liste d'outils **filtrée pour cet utilisateur et ce tour** (la Gateway ne présente que `allowed_tools`).

**État :** config 🟩 (`sandbox/opencode.json` déclare exactement 1 MCP remote — la Gateway — avec `Bearer {env:TASK_JWT}` ; test Go `TestOpenCodeConfigShape`, `opencode_config_test.go:36` — ⚠️ le test réel s'appelle ainsi, **pas** `TestRealOpenCodeServer`, et il ne lance volontairement **aucun** conteneur) · **lancement conteneur 🟦 bloqué-environnement** (`runner.py` est un consommateur de bus en modes stub/intégré, pas de lancement conteneur) → le tour agentique reste simulé côté runner.

### 4.3 MCP Gateway (§13)

**Pipeline d'un appel d'outil :**

```
Sandbox (MCP Client) — tools/call + Bearer TASK_JWT (mTLS)
 → [AuthN]            signature, exp, aud="mcp-gateway"
 → [AuthZ]            ∈ allowed_tools ? sinon E_PERM_TOOL_DENIED
                      ∈ approval_tools ? → suspend + agent.approval.needed
 → [Args validation]  JSON Schema + règles métier (cron valide, intervalle ≥ 15 min, quota…)
 → [Taint gate]       tour contaminé + egress_class=public ? → reclassement (§17.6.3)
 → [Token injection]  Vault : credential adapté (token OAuth user, service token…)
 → [Dispatch]         serveur MCP cible — pool, circuit breaker, timeout 60 s,
                      Idempotency-Key propagée sur toute écriture
 → [Result filtering] DLP (masquage) + taille max 256 Ko
 → [Audit]            append-only {ts, user, org, tool, args_hash, status, latency, bytes}
 → retour sandbox
```

**TASK JWT (§13.4) :** *(design cible ci-dessous)*

> ✅ **Seam ES256 câblé (2026-07-15, ADR-012) :** l'algorithme du TASK JWT est désormais un **seam config-gated**. **HS256 avec le secret partagé de dev (`dev-task-jwt-secret`) reste le DÉFAUT** — le chemin offline/keyless dev + test est inchangé. `TASK_JWT_ALG=ES256` active la signature **P-256/ECDSA (JOSE ES256)** côté prompt-layer (`services/prompt-layer/app/task_jwt.py`, clé privée PEM via `TASK_JWT_EC_PRIVATE_KEY_PATH`, `kid` via `TASK_JWT_KID`) et la vérification côté Gateway contre un **JWKS** (`packages/shared-ts/src/jwt.ts:verifyES256/loadJwks`, `server.ts` charge `TASK_JWT_JWKS_PATH`, sélection par `kid`, modèle 2 clés current+next). Fail-closed : `kid` inconnu, mauvais `aud`, `exp` dépassé, `alg:none` ou mauvais alg rejetés ; **jamais de repli ES256→HS256**. Accord inter-langage prouvé par un **vecteur de test commité** (token frappé par le signeur Python, vérifié à l'octet par les suites Python *et* TS). ⚠️ `aud` vaut toujours **`olma-mcp-gateway`** (`server.ts`), pas `mcp-gateway` (le renommage reste à trancher). La rotation live du JWKS toutes les 5 min (bloc « Rotation » ci-dessous) reste à automatiser — le JWKS est chargé au boot. `allowed_tools` / `approval_tools` et le scrub DLP restent bien câblés.

```json
{ "header": { "alg": "ES256", "kid": "task-2026-07", "typ": "JWT" },
  "payload": {
    "iss": "auth.internal", "aud": "mcp-gateway",
    "sub": "usr_7f3a", "org": "org_acme",
    "task_id": "task_01H8...", "conversation_id": "conv_9b2c",
    "origin": "interactive", "job_id": null,
    "allowed_tools":  ["github.*", "browser.read_*", "scheduler.*"],
    "approval_tools": ["github.merge_pr", "scheduler.create_cron"],
    "budget": { "max_cost_usd": 2.5, "max_seconds": 900 },
    "iat": 1783948920, "exp": 1783949820, "jti": "01J8ZK..." } }
```

- **Rotation** : 2 clés actives (`current` + `next`), publiées en JWKS avec `kid`. Rollover mensuel automatisé (job Trigger.dev) : `next` devient `current`, une nouvelle `next` est générée, l'ancienne reste vérifiable 24 h. **Zéro redéploiement** — la Gateway recharge le JWKS toutes les 5 min.
- **Révocation d'urgence** : blocklist Redis par `jti` (TTL = `exp` restant), alimentée par `platctl` — pour un sandbox suspecté compromis **en cours de tour**.
- Rejet si `aud ≠ mcp-gateway`, dérive d'horloge > 30 s, ou `kid` inconnu. **Fail-closed, jamais de fallback.**

**DLP (§13.5)** — appliqué sur chaque réponse d'outil, **le chemin d'ERREUR**, et la réponse finale de l'agent. Masquage `«***redacted***»` + audit `dlp.redacted{rule}` :

| Famille | Motifs |
|---|---|
| Clés cloud | `AKIA[0-9A-Z]{16}`, clés GCP/Azure |
| Tokens VCS/API | `ghp_`, `gho_`, `ghs_`, `github_pat_`, `xoxb-`, `sk-ant-`, `sk-…` |
| Matériel crypto | `-----BEGIN … PRIVATE KEY-----`, JWT à 3 segments hors contexte |
| Credentials en URL | `scheme://user:pass@host` |
| Empreintes structurelles | entropie > seuil sur chaînes ≥ 32 chars dans champs `token/secret/key` |

Faux positifs : allow-list **par org**, chaque exception étant elle-même auditée.

### 4.4 Taint tracking & classes d'egress (§17.6) 🟩

**Le risque :** un contenu non fiable lu par l'agent (issue GitHub, page web, mail) contient une injection qui le pousse à exfiltrer des données via un outil de sortie (PR publique, message posté). **La parade n'est pas un classifieur.**

1. **Registre d'outils (§17.6.2)** — tout outil MCP déclare à l'enregistrement :
   - **`ingests_untrusted`** — son résultat introduit-il du contenu non fiable dans le tour ?
   - **`egress_class`** ∈ `public` (envoie des données **hors** de la frontière de confiance) | `internal` | `none`.
   Un outil **sans ces deux attributs ne peut pas s'enregistrer** — `register()` lève **au démarrage** (`gateway.ts:73-75`). ⚠️ **Écart vérifié :** **5** outils déclarés à ce jour (`GH_META`, `server.ts:26-32`), pas 13.
2. **Taint par tour (§17.6.3)** — dès qu'un outil `ingests_untrusted` renvoie un résultat non vide, le `task_id` est marqué contaminé. Drapeau **monotone** : une fois posé, jamais levé — un tour ne peut pas se « décontaminer » en faisant ensuite quelque chose de propre. ✅ **Corrigé (2026-07-15) :** seam Redis branché — `InMemoryTaint` reste le **défaut** (offline), `RedisTaint` (`taint.ts` côté Gateway, `redis_taint.py` côté prompt-layer) s'active via `REDIS_URL` ; `SET NX EX 900` (idempotent monotone), clé `taint:{task_id}`. Gateway et prompt-layer pointent alors sur **le même Redis** — la contamination d'un run planifié est visible des deux côtés (résout le « Reste à faire » ci-dessous).
3. **Reclassement** — sur un tour contaminé, **tout outil `egress_class = public` est reclassé, quelle que soit la policy** :
   - tour **interactif** → `require_approval` (l'humain valide, **arguments bruts**) ;
   - run **planifié** → échec **`E_GUARD_TAINTED_EGRESS`** — pas d'humain pour valider, **on ne sort pas**.
4. **Lien mémoire (§9.1.4)** — le même drapeau impose que toute mémoire écrite pendant un tour contaminé le soit en `source_trust = untrusted`.

> ~~**Reste à faire :** pointer le `TaintLedger` du prompt-layer et celui de la Gateway sur le **même Redis**.~~ ✅ **Fait (2026-07-15)** — seam `REDIS_URL` commun aux deux (voir point 2 ci-dessus).

### 4.5 Serveurs MCP (§14)

Chaque serveur = déploiement indépendant (scaling et pannes isolés), MCP en **streamable HTTP**, accessible **uniquement** depuis la Gateway (NetworkPolicy).

| Serveur | Backend | Identité |
|---|---|---|
| **GitHub** | REST + GraphQL | Token OAuth user (ou GitHub App installation token pour lecture org) |
| **Teams/M365** | Microsoft Graph | Permissions **déléguées** (OBO) — **jamais application-wide par défaut** |
| **Slack** | Slack Web API | User token OAuth |
| **Browser** | Playwright (pool Chromium isolé) | Aucune — sessions éphémères, allow-list de domaines par org, **anti-SSRF** |
| **Database** | Postgres/MySQL + APIs internes | Comptes de service **read-only** ; écritures = serveur séparé + `require_approval` |
| **Notion** | Notion API | Token OAuth user |
| **Scheduler** | automation-service → Trigger.dev | Service token interne ; **le `user_id` du TASK JWT est imposé comme propriétaire** — un agent ne voit et ne touche **que** les jobs de son utilisateur |

**Règles communes :** JSON Schema strict, pagination systématique, **réponses tronquées à 256 Ko**, idempotency-keys sur les écritures, retries exponentiels sur 429/5xx.
**Anti-SSRF Browser (durci)** : le parser d'hôtes bloque **IP décimales/hex, CIDR privés (RFC1918), IPv6, endpoints metadata**. Un simple blocage de `127.0.0.1` ne suffit pas.
**Contrainte structurelle : 5 à 9 outils exposés par tour.** Au-delà, la précision de sélection du LLM chute. La Gateway le garantit **par construction** : on branche 20+ connecteurs côté plateforme, chaque profil n'en voit qu'un sous-ensemble.

**Onboarding d'un connecteur (§14.3)** — le coût marginal est faible car auth, permissions, audit, DLP et quotas sont **mutualisés dans la Gateway** :

| Niveau | Cas | Travail | Durée |
|---|---|---|---|
| **N1** — remote officiel | Atlassian, Sentry, Linear… | App OAuth chez l'éditeur (secrets → Vault) ; entrée provider dans `/connections` (**config, pas de code**) ; déclaration Gateway ; `tool_policies` ; 3-5 tâches golden set | 1-3 j |
| **N2** — open source self-hosted | GitLab, Zendesk, Datadog | N1 + Helm + NetworkPolicy + cycle de MAJ | 2-5 j |
| **N3** — maison | Knowledge MCP, APIs internes | Un serveur MCP à 3 outils ≈ **80 lignes de TS** ; l'essentiel du temps va au **durcissement** (schémas, pagination, troncature, tests) | 1-2 sem. |

À créer **une fois** : `services/mcp-servers/_template/` (SDK MCP + client HTTP avec retries/breaker + OTel + Dockerfile + chart Helm) et `docs/connector-onboarding.md` (checklist en 9 points).
**Point de vigilance récurrent : ce n'est jamais le MCP qui coûte du temps, c'est l'OAuth du provider** (refresh rotatifs Atlassian, OBO Microsoft, granularité des scopes GitHub).

### 4.6 Trigger.dev & automatisations (§15)

**La décision structurante (ADR-005) :** Trigger.dev ne parle **jamais** aux sandboxes ni aux serveurs MCP. Au feu d'un cron, il **ré-injecte** un `InboundMessage` (canal `scheduler`) dans le Backend Core. Le run planifié traverse donc **exactement le même pipeline** qu'un message humain — mêmes guardrails, mêmes permissions (ré-évaluées), même audit.

**Convention :** **déclaratif** pour les jobs internes (cron dans le code, versionné Git) · **impératif** pour les crons des utilisateurs (`schedules.create` avec `externalId = job_id` et `deduplicationKey = job_id` → update idempotent au lieu de doublon).

**Tâche pivot :**

```ts
export const agentScheduledRun = schedules.task({
  id: "agent-scheduled-run",
  retry: { maxAttempts: 3, factor: 2, minTimeoutInMs: 30_000 }, // INFRA ONLY
  run: async (payload) => {
    const job = await loadJob(payload.externalId!);
    if (!job || job.status !== "active") return { skipped: true };

    const gate = await preflight(job);            // user actif (SCIM) ? budget org ? kill-switch ?
    if (!gate.ok) { await pauseJob(job, gate.reason); return gate; }

    const idem = `${job.id}:${payload.timestamp.toISOString()}`;
    const { run_id } = await submitScheduledRun(job, idem);   // POST /internal/scheduled-runs

    const verdict = await waitForVerdict(run_id, job.budget.max_seconds + 60);
    await recordRun(job, run_id, verdict);

    if (verdict.status === "failed") {
      const failures = await bumpFailureCount(job);
      if (failures >= 3) await pauseJob(job, "consecutive_failures");
      if (isInfraError(verdict.code)) throw new Error(verdict.code);  // → retry
    }
    return verdict;
  },
});
```

**Distinction capitale :** les retries Trigger.dev couvrent **uniquement les échecs d'infrastructure** (backend injoignable, file saturée). Les **échecs d'agent** (permission révoquée, guardrail, budget, erreur d'outil) ne sont **jamais retryés aveuglément** — ils sont enregistrés `failed` et comptent pour l'auto-pause.

**Validations `scheduler.create_cron`** (`require_approval` par défaut) :
- expression cron valide, **pas de champ secondes** (granularité minimale : la minute) ;
- **intervalle minimal 15 min** (configurable par org) ;
- si `natural` fourni → conversion + **les 3 prochaines occurrences retournées à l'agent, qui doit les confirmer à l'utilisateur** (anti-malentendu « tous les lundis » vs « le 1er lundi du mois ») ;
- quotas : **20 jobs actifs/user, 200/org** ;
- **quiet hours** org (ex. pas de runs 22h-6h sauf exemption) ;
- `delivery.target` ∈ cibles appartenant à l'utilisateur (**jamais le canal d'un tiers**) ;
- budget par run ≤ plafond org.

**Cycle de vie :** `DRAFT → PENDING_APPROVAL → ACTIVE ⇄ PAUSED → DELETED`. `resume` **re-vérifie quotas et politique**.

**Sécurité (§15.6) :**

| Risque | Contre-mesure |
|---|---|
| Cron = persistance pour un attaquant | Création en `require_approval` ; **prompt immuable et versionné** (`prompt_version` +1 à chaque édition approuvée) ; **re-scan guardrails à chaque run** |
| Escalade différée | Permissions **au feu**, jamais stockées ; `pre_approved_tools` restreint à des outils **nommés**, re-présenté à chaque édition |
| Utilisateur parti | `preflight` vérifie le statut SCIM → auto-pause à l'offboarding, purge via `user-erasure` |
| Emballement de coûts | Budget/run + budget mensuel/job + plafond org ; **auto-pause à 3 échecs consécutifs** ; kill-switch org |
| Thundering herd à 9h00 | **Jitter aléatoire 0-120 s** + classes de priorité + concurrence par queue |
| Exfiltration via delivery | `delivery.target` ∈ cibles de l'utilisateur ; webhooks sortants **signés HMAC** + allow-list de domaines |
| Rejeu / double exécution | **ADR-016 — dedup-on-success** : `fire_job` n'enregistre la clé (`job_id + timestamp`) **qu'après production effective de la tâche**. L'enregistrer *avant* `build_task` fait qu'un échec de build marque le fire comme « traité » → le retry tombe sur la branche doublon → **occurrence perdue à jamais** |

**Jobs internes (§15.7)** — Trigger.dev remplace **tous** les crons ad hoc de la plateforme, un seul endroit pour opérer, tracer et rejouer :

| Job | Cron | Rôle |
|---|---|---|
| `memory-extraction` | post-tour | mémoires long terme |
| `volume-snapshot` | `0 3 * * *` | snapshots S3 |
| `usage-rollup` | `10 0 * * *` | agrégats `usage_daily` (facturation) |
| `oauth-refresh-sweep` | `0 */6 * * *` | refresh proactif des tokens < 24 h — **pour que les runs de nuit ne tombent pas sur un token mort** |
| `sandbox-reaper` | `*/30 * * * *` | hibernation IDLE, destruction > 30 j |
| `audit-export-worm` | `0 1 * * *` | export audit → S3 object-lock |
| `user-erasure` | à la demande | purge RGPD (messages, mémoires, volumes, tokens, **jobs**) |
| `dlq-redrive` | `*/15 * * * *` | rejeu DLQ NATS avec backoff |
| `cert-expiry-check` | `0 7 * * *` | certificats/secrets/apps OAuth < 30 j |
| `pool-warmer` | `*/5 * * * *` | regonfle le pool chaud |
| `memory-consolidation` | `0 4 * * 0` | fusion des doublons, clôture des contradictions, décroissance, compaction des notes > 2 000 lignes — **sans lui, la mémoire devient du bruit en 6 mois** |

**DR** : `scheduled_jobs` est **notre** source de vérité ; `platctl schedules resync` reconstruit Trigger.dev de façon idempotente (`deduplicationKey`) → **zéro doublon**.

**Extension événementielle (§15.8)** — même chemin de sécurité, aucun nouveau : `webhook-ingress` (signature HMAC/JWT vérifiée, anti-rejeu 5 min, dédup par `delivery_id`, debounce) → `InboundMessage {channel: "webhook"}` → pipeline normal. Table `event_triggers`. Deux garde-fous propres : **contrôle de tempête** (rate limit par trigger, au-delà → digest + pause proposée) et **payload traité comme `<untrusted>`** — un titre de PR est une surface d'injection.

### 4.7 Slack bot (§7.2)

- **Bolt for JavaScript** — Socket Mode en dev, HTTP + Events API en prod.
- **Scopes** : `app_mentions:read`, `chat:write`, `im:history`, `im:write`, `files:read`, `files:write`, `commands`.
- **Sécurité webhook** : signature `X-Slack-Signature` (HMAC-SHA256 + timestamp, **fenêtre anti-rejeu 5 min**) ; **déduplication** des retries via `X-Slack-Retry-Num` + `event_id` en Redis.
- **Identité** : `slack_user_id` + `team_id` → `identities` (liaison OIDC Slack au premier usage).

**La contrainte des 3 secondes (§7.2.1)** — Slack ré-émet l'événement si la réponse HTTP dépasse 3 s (d'où la dédup `event_id`). Donc **ACK instantané** : HTTP 200 + réaction 👀 sur le message + publication de l'`InboundMessage` sur le bus — **avant même la classification**.

```
@mention Slack
  │ ACK + 👀 (< 3 s)
  ▼ classification (~250 ms, modèle éco)
  ├── chat_simple ────► LLM direct, AUCUN sandbox réveillé (~$0,002)
  │                     réponse en thread en 2-5 s, 👀 → ✅
  ├── task_agentique ─► sandbox + plan + progression par JALONS (chat.update, ~1/s max)
  │                     approbations Block Kit dans le thread
  └── ambigu ─────────► démarre chat_simple, ESCALADE si besoin d'outils apparaît
```

**Jamais de streaming token par token sur Slack** — l'API tolère ~1 update/s et ça spammerait le canal. Progression **par jalons** uniquement.

**Cas de bord (tous à implémenter) :**

| Cas | Comportement |
|---|---|
| Tâche > 2-3 min | « Ça va prendre quelques minutes, je te notifie ici ✋ » → thread asynchrone ; à la fin, **mention `@user`** pour déclencher sa notification native |
| Message pendant un run | FIFO par conversation : contexte du tour suivant, **ou** instruction de correction du tour en cours (« annule », « prends plutôt la branche X ») |
| Annulation | Bouton « Arrêter » + `/agent stop` → `CancelTask` |
| **Mention en canal public** | L'agent agit avec les permissions **du mentionneur** (résolu via `identities`). **Garde-fou confidentialité** : si la tâche touche des données personnelles (mails, DM, fichiers privés) → « Je t'envoie ça en DM 👋 » et bascule. **Jamais de données d'un connecteur personnel dans un canal partagé.** |
| Mentionneur non lié | Réponse **éphémère** avec le lien de liaison OIDC — **aucun traitement avant liaison** |
| Deux tâches en parallèle | Un seul tour actif par conversation ; un 2ᵉ thread = une 2ᵉ conversation (limite 5 simultanées/user) |

**Slash commands** : `/agent new`, `/agent status`, `/agent stop`, `/agent crons`.
**Teams** suit exactement le même modèle (ACK, classification, jalons, escalade) — seule la mécanique d'affichage change (`updateActivity` / Adaptive Cards au lieu de `chat.update` / Block Kit), plus la validation du **JWT Bot Framework** (`aud` = App ID, `iss` Bot Framework, tolérance 5 min, rejet fail-closed) et les `conversationReference` stockées en base pour les **notifications proactives**.

### 4.8 Critère de sortie L3

Démo §18.2 (création d'un cron par l'agent, avec confirmation des occurrences et approbation) **et** §18.3 (exécution nocturne) de bout en bout. **Test de révocation** : retirer `msgraph.*` aux `member` → le run suivant échoue en `E_PERM_REVOKED` et le job passe `PAUSED` avec notification.

---

<a id="l4"></a>
## 5. L4 — Chaîne d'identité (« sync with id »)

C'est le lot qui rend tous les autres sûrs. **Aucun composant ne fait confiance à un identifiant non signé.**

```
Teams aadObjectId ─┐
Slack user_id ─────┼─► identities (PK: provider, external_id) ─► user_id canonique
Web OIDC sub ──────┘
        ▼
JWT session (15 min, RS256/ES256, aud=api)
        ▼   Prompt Layer calcule allowed_tools / approval_tools
TASK JWT (15 min, ES256, aud=mcp-gateway)   ← seul secret du sandbox
        ▼
MCP Gateway : re-validation + injection du token OAuth (jamais exposé)

RUNS PLANIFIÉS : aucune identité stockée dans Trigger.dev — le payload ne contient
que job_id. Le TASK JWT est frappé À CHAUD par le Prompt Layer au moment du run,
après re-vérification du statut SCIM et des permissions courantes.
```

### 5.1 Étapes

1. **`identities`** — mapping canaux → user canonique.
   - Teams : `aadObjectId` → `user_id` ; premier contact → SSO silencieux (`TeamsSSOTokenExchange`).
   - Slack : `slack_user_id` + `team_id` → `identities` (OIDC Slack au premier usage).
   - Web : `sub` OIDC.
2. **auth-service** — OIDC, JWT, **JWKS**, rotation de clés. 🟩 (17 tests)
3. **ADR-018 — frontière de requête unifiée.** `current_identity()` lit `Authorization: Bearer`, le vérifie via le `verify_token()` **RS256/JWKS importable de l'auth-service**, et pose `user_id` / `org_id`. Token absent ou invalide → repli `usr_dev` / `org_1` (le web sans login et les tests existants marchent inchangés). `/whoami` réécrit sur **le même vérifieur**.
   *Contexte : il existait **deux piles JWT concurrentes** (auth-service RS256 vs `olma_shared` HS256) qui ne pouvaient pas se vérifier mutuellement — le `/whoami` HS256 ne vérifiait aucun token réel émis. Divergence close.* 🟩
4. **Porte d'entrée login** — auth-service (`:8091`), backend-core `POST /api/v1/login` proxie `/oidc/dev-login` → token RS256 ; le web le stocke et l'envoie en Bearer. Vérifié live : login `usr_mehdi/org_9` → conversation possédée par `usr_mehdi` ; déconnexion → `usr_dev`. **Additif** (sans token, comportement identique à avant). 🟩
   *Reste externe : le round-trip OIDC réel (Entra / Slack) remplace `/oidc/dev-login` ; l'étape de mint est déjà en place.*
5. **`app.org_id` → RLS** — le claim `org` du JWT **vérifié** est posé sur la session Postgres au check-out du pool (voir L2.4). C'est le point de jonction identité ↔ isolation.
6. **SCIM** — `users.status ∈ {active, suspended, offboarded}` alimenté par l'IdP. C'est **exactement** ce que lit le `preflight` des crons : offboarding ⇒ jobs auto-pausés (Mode A) ou **bascule de propriété** (Mode B), puis `user-erasure` à la demande.

### 5.2 Mode B (agent d'équipe) — la règle d'or

**Credentials partagés ≠ identité anonyme.** Chaque message Slack/Teams porte l'identité de son auteur (`event.user`), résolue via `identities` exactement comme en Mode A, et elle continue de servir à **trois** choses :

1. **Autorisation** — `tool_policies` s'applique au **rôle du demandeur**, pas au bot. Sans cela : **confused deputy** — n'importe quel membre du workspace pilote un bot qui a les clés de l'org. Avec des credentials org-wide, **les approbations deviennent plus importantes, pas moins** (le rayon d'impact d'une injection est toute la société).
2. **Approbation** — `tool_policies.approver_group` désigne qui reçoit la carte : `github.merge_pr → require_approval(approver_group: 'tech-leads')`. La carte part **dans le canal des tech leads**, pas chez le demandeur. `NULL` = comportement Mode A. **Toute approbation journalise demandeur ET approbateur.**
3. **Audit** — `actor: agent-org` + **`on_behalf_of: usr_mehdi`** sur chaque ligne. **Et** — puisque les commits GitHub apparaissent au nom du bot — l'agent ajoute systématiquement `Co-authored-by` + « Requested by @mehdi » dans les PRs. Sinon **l'audit interne est bon mais l'historique Git est aveugle**.

Le TASK JWT porte `sub: agent-org@<org_id>` + claim **`on_behalf_of`** ; la Gateway applique la politique sur `on_behalf_of` et injecte le credential org depuis Vault.

**Garde-fous Mode B :** quotas **par demandeur** malgré le budget commun · **aucun connecteur délégué personnel** (Outlook OBO, DM — exclus par configuration) · interdiction de mémoriser des attributions individuelles sensibles (« X est lent sur les reviews ») · **l'identité d'exécution reste l'auteur du message courant** dans un thread multi-utilisateurs.

### 5.3 Custody des credentials (§13.2, ADR-019) 🟩

- **`CredentialResolver`** — AES-256-GCM **réel** (seal/open, clé 32 octets, vérification du tag) câblé dans la Gateway, partagé entre l'injection par appel (`resolveCredential`) et la surface HTTP `/v1/connect`.
- `POST /v1/connect` (PAT) + `GET /v1/connections` ; backend-core proxie et `/me` lit **l'état réel**. Vérifié live : PAT → `github` bascule `false → true` ; le token stocké est injecté au prochain appel d'outil.
- Ordre de résolution : **token perso (Mode A) d'abord, sinon credential de service org (Mode B)**. Un vrai manque → `CredentialMissing` → refus **`E_CONN_NEEDS_CONNECTION`** (fail-closed).
- **Ce qui a été explicitement écarté** : la fermeture sur `GITHUB_TOKEN` d'environnement (secret ambiant partagé = deputy confus), et le statut de connecteur codé en dur à `false` (mensonge produit).
- **Reste externe :** l'OAuth navigateur (client_id / secret par fournisseur), et **l'enveloppe KMS** — le chiffrement est réel, mais la clé est **locale/in-process**. 🟦

### 5.4 `source_trust` — provenance de confiance des mémoires (§9.1.4) 🟩

Toute mémoire (`memories`, `entity_facts`) porte `source_trust ∈ {trusted, untrusted}` — **aucune écriture sans ce champ** (colonne + CHECK).

- Il est **dérivé du drapeau de taint du tour** (§17.6.3), **jamais inféré du contenu**. Un tour contaminé écrit `untrusted` ; un tour propre écrit `trusted`.
- **Transitions** : un tour propre qui confirme une mémoire existante peut la **promouvoir** vers `trusted`. **L'inverse n'arrive jamais** — une confirmation contaminée ne dégrade pas une mémoire de confiance.
- **Au rappel**, les mémoires `untrusted` restent utilisables mais sont **signalées comme telles** (badge UI). Sans quoi **un fait injecté se blanchirait en devenant « ce que l'agent sait »**.

### 5.5 Critère de sortie L4

Une session `org_B` voit **0 ligne** de `org_A` ; `WITH CHECK` bloque un insert forgé cross-org ; **le test échoue si on retire la RLS** ; un tour contaminé écrit bien une mémoire `untrusted` et l'UI la badge « non fiable » ; un utilisateur `offboarded` (SCIM) voit ses crons auto-pausés au feu suivant.

---

<a id="l5"></a>
## 6. L5 — Quota + Billing

Trois mécanismes distincts, souvent confondus — les séparer dès le départ : **compter** (ledger) · **appliquer** (guard) · **facturer** (billing).

### 6.1 Compter — `usage_daily`

```sql
CREATE TABLE usage_daily (
  day DATE, org_id TEXT, user_id TEXT, model TEXT,
  origin TEXT NOT NULL DEFAULT 'interactive',   -- interactive|scheduled
  tokens_in BIGINT, tokens_out BIGINT, cost_usd NUMERIC(12,4),
  tool_calls INT, sandbox_seconds INT,
  PRIMARY KEY (day, org_id, user_id, model, origin)
);
```

Alimenté par `usage-rollup` (`10 0 * * *`), **conservé long terme**. La ventilation `origin` est ce qui permet de piloter **et facturer** séparément l'interactif et le planifié — et de répondre à « quelle automatisation coûte cher pour rien ? ».

Le comptage lui-même vit dans le **llm-proxy**, qui est le point de passage obligé : il compte tokens et coûts par `user_id` / `org_id` / **`job_id`**.

### 6.2 Appliquer — quota multi-niveaux

| Niveau | Mécanisme | Erreur |
|---|---|---|
| **Tour** | `budget: {max_tokens, max_seconds, max_cost_usd}` **signé dans le TASK JWT** ; l'orchestrator coupe le sandbox au dépassement | `E_BUDGET_EXCEEDED` (402) |
| **Run planifié** | `per_run_budget` du job — vient **du job**, pas de l'estimation du Planning | idem |
| **Job** | `monthly_budget_usd` | pause |
| **Org** | **ADR-020** — boucle *mètre → applique* au point d'étranglement **`llm-proxy Proxy.complete`** | `E_BUDGET_EXCEEDED` |
| **API** | Rate limiting Gateway : 30 req/min chat, 5 conversations simultanées | `E_RATE_LIMITED` (429) |
| **Automatisations** | 20 jobs actifs/user, 200/org ; **kill-switch org** (`automations.enabled`) | `E_SCHED_QUOTA_REACHED` (409) |

**ADR-020 en détail.** Chaque appel LLM passe **déjà** par `Proxy.complete` avec `org_id` et le coût réel. Donc :
- **avant** l'appel : si un plafond org est configuré, `check_turn` compare la dépense cumulée + l'estimation → dépassement ⇒ **402 `E_BUDGET_EXCEEDED`** + `rejected: true` ;
- **après** succès : `ledger.record(org, mois, coût)`.
- **Sans plafond configuré → jamais bloquant** : le chemin live reste intact.

*Ce qui a été explicitement écarté :* coût calculé puis **jeté** (log structuré non agrégé), `BudgetGuard`/`Ledger` testés-mais-non-câblés, plafond admin écrit mais jamais lu. Vérifié live : org plafonnée à \$0 → 402 ; appel sans `org_id` → 200. **27 tests llm-proxy.** 🟩 *(nuance vérifiée : `rejected:true` vit dans la ligne de log d'usage structurée, pas dans le corps HTTP 402 qui est l'`ErrorEnvelope`.)*

**Règle produit imposée au code :** *jamais de coupure sèche en cours de tâche* — on finit le tour, **puis** blocage doux + notification.
**Mode B :** quotas **par demandeur** malgré le budget commun (rate limiting + part de budget par user), sinon un enthousiaste consomme le budget de toute l'équipe.

### 6.3 Garde-fou de prix — ADR-014

La table de prix est une **donnée** dans `config.yaml` (c'est le seam de swap), **mais** `reference_prices.py` **refuse de démarrer** si un modèle Anthropic dévie de la référence canonique.

**Pourquoi :** le prix pilote **l'admission budgétaire ET la facturation**. Un chiffre périmé **sur-rejette et sur-facture** — silencieusement. C'est ce garde-fou qui a rattrapé le bug Opus 4.8 `15/75` → `5/25`. Coder les prix en dur fige le seam ; ne pas avoir de garde laisse passer le bug en prod.

> *Nuance vérifiée (2026-07-15) :* la référence canonique `claude-opus-4-8: (5.0, 25.0)` est bien dans `reference_prices.py:17`, mais le **refus-de-démarrer** (`PriceDrift`) vit dans `config.py:70-76` (`load_config`), pas dans `reference_prices.py` lui-même. 4 tests dans `test_price_drift.py`. 🟩

### 6.4 Facturer — `billing.py` 🟩

- Facturation au **siège actif** (pas au siège provisionné) + quota d'usage inclus par siège.
- **Dépassement** : coût LLM réel + marge, transparent, **jamais de coupure sèche**.
- **Split `interactive` / `scheduled`** (depuis `usage_daily.origin`).
- TVA + conversion de devise.
- **Émission idempotente par `(org, mois)`** via un seam **`BillingProvider`** — `StubBilling` hors-ligne par défaut, PSP réel **injectable**. (7 tests)
- **Seule pièce key-gated : le charge PSP réel** — exactement comme l'arête LLM (ADR-012).

### 6.5 Page Facturation (§4.4)

Plan et sièges · consommation vs plafond · **répartition interactif / automatisations** · graphe 14 jours **avec le hit rate de cache affiché** (l'utilisateur voit le levier qui divise sa facture par deux) · factures téléchargeables. Plus la **jauge de budget permanente** dans la sidebar (L1.2).

### 6.6 Leviers de coût à câbler (par impact décroissant)

1. **Prompt caching structurel** (§9.6) — **÷2 sur la facture**. Le llm-proxy pose les `cache_control` et surveille `plat_llm_cache_hit_ratio` par org.
2. **Routing réel** — classification et extraction mémoire sur un modèle éco : invisible pour l'utilisateur, **−60 % d'overhead**.
3. **`effort: medium` par défaut** dans les profils — le thinking est facturé en output ; `high` réservé au profil `dev` lourd.
4. **Batch −50 %** pour les jobs asynchrones sans boucle d'outils (digests, extraction mémoire, rollups).
5. **Compaction de contexte** (OpenCode) — borne le coût des tâches lourdes **sans invalider le cache**.
6. **Digests anti-bruit des crons** — un run `no_op` regroupé ne coûte ni delivery ni relance.

### 6.7 Critère de sortie L5

Org plafonnée → 402 en pré-appel, sans plafond → chemin live intact ; `usage_daily` alimenté et ventilé ; une facture mensuelle émise deux fois ne produit qu'une seule charge (idempotence par `(org, mois)`).

---

<a id="l6"></a>
## 7. L6 — Qualité, exploitation, go-live

### 7.1 Pyramide de tests (§20.1)

| Niveau | Portée | Outillage |
|---|---|---|
| Unitaires | Logique permissions, parsing cron, conversion NL→cron, budgets | pytest / vitest / go test — **≥ 80 % sur le code de décision** |
| Contrats | Tous les schémas + outils MCP | JSON Schema, validation croisée TS↔Py, **compat vN-1** |
| Intégration | Pipeline complet **sans LLM réel** (stub déterministe) | Testcontainers : Postgres + Redis + NATS + Trigger.dev dev ; scénarios message→sandbox→tool→réponse, **création + feu de cron accéléré** |
| E2E | Web App + un sandbox réel en staging | Playwright — chat, approbation, OAuth (mock provider), page Automatisations |
| Charge | **500 sandboxes, 2 000 msg/min, 1 000 crons/h** en pointe | k6 + injecteur de schedules |
| Chaos | Kill leader orchestrator, kill nœud NATS, Vault sealed, **workers Trigger.dev down pendant une fenêtre de crons** | Critère : **aucun run perdu** (retries/replay), **aucun doublon** (idempotence) |
| Réseau | Matrice §17.4 | Tests automatisés en CI d'infra — les **interdits** sont vérifiés, pas seulement les autorisations |

### 7.2 Évals d'agents (§20.2)

- **Golden set** : ~150 tâches versionnées (git) couvrant chaque serveur MCP + **20 scénarios de crons** (création, modification, refus attendu).
- **Assertions programmatiques** : séquence d'outils appelés, arguments valides, **respect des permissions** (l'agent ne doit *jamais* tenter un outil hors `allowed_tools` plus de N fois), coût ≤ budget.
- **LLM-as-judge** pour la qualité rédactionnelle des récaps (score 1-5, seuil 4).
- **Suite adversariale** : ~500 prompts d'injection (pages web, mails, contenus de repos). **Cible : 0 compromission sur les actions d'écriture** ; alerte si > 1 % de fuites de comportement.
- **Gate CI** : toute modif de prompt système, de profil ou de version de modèle passe le golden set. **Régression > 3 % = blocage du déploiement.**
- **Registre des prompts** : `prompt_registry` (id, version, contenu, hash, actif, auteur). Modification = PR revue + gate d'évals, activation par flag, **rollback en une commande** (`platctl prompts rollback <id>`). Le `prompt_version` utilisé est **tracé sur chaque tour** (corrélation qualité ↔ version).
- **Boucle feedback → évals** : thumbs down et refus d'approbation récurrents génèrent des **candidats au golden set** (revue humaine hebdo). Le jeu d'évals grandit avec **les vrais échecs du terrain**, pas seulement les cas imaginés.

### 7.3 Observabilité (§19)

**Métriques canoniques (préfixe `plat_`) :**

```
plat_turn_first_token_seconds{channel,origin}   histogram   # SLO principal
plat_turn_total{channel,origin,status}          counter
plat_sandbox_wake_seconds{from_state}           histogram
plat_sandbox_pool_available                     gauge
plat_sandboxes{state}                           gauge
plat_mcp_tool_calls_total{tool,status}          counter
plat_mcp_gateway_latency_seconds{tool}          histogram
plat_llm_cost_usd_total{org,model,origin}       counter
plat_llm_cache_hit_ratio{org}                   gauge       # cible ≥ 0,75
plat_cron_fire_delay_seconds                    histogram   # scheduled_for → started_at
plat_scheduled_runs_total{status}               counter
plat_approval_pending                           gauge
plat_nats_dlq_depth{subject}                    gauge
```

**Traces** : 1 trace = 1 tour. Spans : adapter → prompt-layer (5 étages) → orchestrator → OpenCode → tool calls → serveurs MCP. Les runs planifiés démarrent leur trace **dans le worker Trigger.dev** (contexte OTel propagé) → corrélation dashboard Trigger.dev ↔ Tempo via `trigger_run_id`.
**Logs** : Loki, JSON structuré. **Jamais de contenu de conversation en clair** dans les logs techniques ; `user_id` **hashé** hors audit.

**Alerting bi-niveau (§24.6) :**

| Niveau | Contenu | Règle |
|---|---|---|
| **Page** (réveille) | Violations de SLO **visibles utilisateur** uniquement : API down · P95 premier token > 30 s soutenu · pool chaud vide **et** file croissante · Postgres primary down · Vault sealed | **5 alertes max.** Chaque page doit être **actionnable** et pointer son runbook |
| **Ticket** (attend le matin) | Tout le reste : échec d'un connecteur, budget org à 80 %, retard de crons, DLQ non vide après redrive, certificats < 30 j | **Jamais de notification unitaire** — digest agrégé et priorisé |

### 7.4 Exploitation (§24)

**`platctl`** — pour un ops solo, le CLI prime sur la console : scriptable, utilisable en incident, versionné avec la plateforme. Il consomme l'API admin (**mêmes contrôles, même audit**).

```
platctl status                       # SLO, files, pool, breakers — un écran
platctl sandbox list|kill|drain
platctl jobs pause --org acme        # kill-switch ciblé (ou --all)
platctl schedules resync             # reconstruit Trigger.dev depuis scheduled_jobs (idempotent)
platctl dlq list|redrive
platctl connectors health|probe <id>
platctl maintenance on --message "…" # bannière diffusée sur les 3 canaux
platctl user offboard usr_xxx        # → user-erasure (confirmation requise)
platctl budget set --org acme --monthly 500
platctl audit tail --filter tool=github.merge_pr
platctl prompts rollback <id>
```

**Éditeur de `tool_policies` en mode simulation** — *avant* application : « quels utilisateurs perdent quels outils ? **quels crons vont se mettre en pause ?** ». Évite 80 % des incidents auto-infligés.
**Mode `view-as`** — lecture seule, **motif obligatoire**, journalisé. L'outil n°1 pour débugger « ça ne marche pas chez moi ».
**Toute action admin est écrite dans `audit_log` avec `actor=admin`** — y compris celles du `platform_admin`.

**Philosophie :** (1) managed partout où c'est possible ; (2) **tout en code, zéro action manuelle non tracée** — GitOps strict, jamais de `kubectl edit` en prod ; (3) **auto-remédiation avant alerte** — une alerte qui revient deux fois est un candidat à l'automatisation.

**Runbooks** (`docs/runbooks/`, format fixe : *Symptôme → Diagnostic (≤ 3 commandes) → Remédiation → Vérification → Post-mortem 5 pourquoi*). Les 10 prioritaires : fournisseur LLM en panne · workers Trigger.dev down pendant une fenêtre de crons (replay + **contrôle d'idempotence : zéro doublon attendu**) · Vault sealed · nœud sandbox saturé · secret OAuth expiré · partition NATS · failover Postgres · certificat expiré · DLQ qui gonfle malgré redrive · org qui explose son budget.

**Dogfooding** — org interne `org-platform` : l'agent du `platform_admin` a un Database MCP read-only sur les métriques + le Scheduler MCP. Crons : `brief-sante` (08:00 j. ouvrés) · `rapport-hebdo` (lundi 08:30) · `pre-checklist-releases`. **Bénéfice double** : l'ops quotidien se réduit à lire un brief, et tu es **l'utilisateur zéro** des crons — toute régression du sous-système d'automatisations se voit **sur ton propre brief avant d'atteindre les clients**.

### 7.5 Réponse à incident (§17.5)

| Phase | Actions | Délai |
|---|---|---|
| **Détection** | Anomalies d'audit (volume/horaires/outils inhabituels), **canary tokens** dans Vault, alertes DLP répétées, échecs d'AuthN en rafale | immédiat |
| **Confinement** | **Dans l'ordre** : kill-switch automations org → révocation des `jti` suspects (blocklist) → rotation d'urgence des clés TASK JWT → rotation/révocation des tokens OAuth exposés → isolation des sandboxes (`platctl sandbox kill`) | **< 1 h** |
| **Investigation** | Forensics sur l'audit **WORM** (immuable par construction) : quels users, quels outils, quelles données ; snapshots des volumes préservés | < 24 h |
| **Notification** | Autorité de contrôle **sous 72 h** si données personnelles affectées ; clients sans délai injustifié (template pré-rédigé) | 72 h max |
| **Post-mortem** | Sans blâme, 5 pourquoi, actions trackées, mise à jour des runbooks **et du corpus de détection** | < 1 sem. |

**Exercice tabletop semestriel** — scénario : token GitHub org exfiltré via injection. Un premier exercice est **exigé avant l'ouverture commerciale**.

---

<a id="ordre"></a>
## 8. Ordre d'exécution & dépendances

**Ordre recommandé — « gouvernance d'abord » (ADR-011)** : livrer d'abord la moitié sécurité-critique — la plus dure à copier — et différer l'infra sandbox/scheduler coûteuse.

```
L0 Socle
 └─► L4 Identité + RLS          ← rien n'est sûr sans elle
      └─► L2 Backend + pipeline
           ├─► L3.b Gateway + taint + 1er connecteur (GitHub)
           │    ├─► L1 Frontend (sur un backend réel, pas des mocks)
           │    ├─► L3.d Slack bot
           │    └─► L3.a/c Sandbox + OpenCode + Trigger.dev
           └─► L5 Quota + Billing
                └─► L6 Qualité / exploitation / go-live
```

**Dépendances dures :**
- L4 avant L2.4 (RLS a besoin du claim `org` d'un JWT vérifié).
- L3.b (registre d'outils + taint) avant L3.a (le sandbox ne doit jamais tourner sans la Gateway).
- L2.8 (ré-approbation) avant toute démo d'approbation — sinon boucle infinie.
- L5.3 (garde-fou de prix) avant L5.2 — un plafond calculé sur un prix périmé sur-rejette.

---

<a id="a1"></a>
## Annexe 1 — Taxonomie d'erreurs (§21)

| Code | HTTP | Retry ? | Signification |
|---|---|---|---|
| `E_AUTH_INVALID_TOKEN` | 401 | non | Session expirée → re-login silencieux |
| `E_PERM_TOOL_DENIED` | 403 | non | Outil non autorisé par l'organisation |
| `E_PERM_REVOKED` | 403 | non | Permission retirée depuis la création du cron → **job pausé** |
| `E_CONN_NEEDS_CONNECTION` | 424 | non | Connecter le provider + deep-link |
| `E_CONN_TOKEN_EXPIRED` | 424 | auto (refresh) | Refresh transparent ; sinon carte de reconnexion |
| `E_TOOL_UPSTREAM_ERROR` | 502 | oui (expo, 3×) | API tierce en erreur ; circuit breaker au-delà |
| `E_TOOL_TIMEOUT` | 504 | oui (1×) | Outil > 60 s |
| `E_GUARD_INPUT_BLOCKED` | 422 | non | Contenu bloqué (motif catégorisé, **jamais le détail du détecteur**) |
| `E_GUARD_OUTPUT_REDACTED` | 200 | — | Réponse livrée avec masquage, signalé |
| **`E_GUARD_TAINTED_EGRESS`** | 422 | non | **Egress public sur tour contaminé, en run planifié** (§17.6.3) |
| `E_BUDGET_EXCEEDED` | 402 | non | Budget tour/run/org atteint |
| `E_SANDBOX_UNAVAILABLE` | 503 | oui (queue) | File d'attente, position communiquée |
| `E_SCHED_QUOTA_REACHED` | 409 | non | 20 automatisations actives atteintes |
| `E_SCHED_INVALID_CRON` | 422 | non | Expression invalide / intervalle < 15 min / quiet hours |
| `E_SCHED_JOB_PAUSED` | 409 | non | Run sauté car job pausé entre le feu et l'exécution |
| `E_RATE_LIMITED` | 429 | oui (après `Retry-After`) | — |
| `E_INTERNAL` | 500 | oui (**idempotent only**) | `trace_id` fourni au support |

---

<a id="a2"></a>
## Annexe 2 — SLO cibles (Annexe A du blueprint)

| SLO | Cible |
|---|---|
| Premier token streamé (Web) | P95 < 3 s |
| Réveil sandbox (IDLE→ACTIVE) | P95 < 500 ms |
| Création sandbox à froid (pool vide) | P95 < 8 s |
| Latence ajoutée par la MCP Gateway | P95 < 80 ms |
| Précision de déclenchement d'un cron (hors jitter volontaire) | P95 < 60 s |
| Cron fire → premier événement agent | P95 < 10 s |
| **Runs planifiés perdus** (ni exécutés ni marqués failed) | **0** |
| **Doublons de runs planifiés** | **0** (idempotence) |
| Disponibilité API | 99,9 % |
| Perte de données conversations | 0 (RPO 15 min) |

**PromQL de référence :**
```promql
# P95 premier token (Web)
histogram_quantile(0.95, sum(rate(plat_turn_first_token_seconds_bucket{channel="web"}[5m])) by (le))

# Taux d'échec des runs planifiés sur 1 h (alerte si > 0,05)
sum(rate(plat_scheduled_runs_total{status="failed"}[1h])) / sum(rate(plat_scheduled_runs_total[1h]))

# Retard de déclenchement des crons, P95 (alerte si > 120 s)
histogram_quantile(0.95, sum(rate(plat_cron_fire_delay_seconds_bucket[15m])) by (le))
```

---

<a id="a3"></a>
## Annexe 3 — Checklist go-live (volet technique)

**Sécurité**
- [ ] Pentest externe réalisé, criticités corrigées, **re-test passé**
- [ ] Corpus adversarial : **0 compromission** sur actions d'écriture
- [ ] Tests réseau automatisés verts : matrice §17.4, **interdits vérifiés**
- [ ] Rotation des clés TASK JWT **exercée en réel** ; blocklist `jti` testée
- [ ] Scan images : 0 CRITICAL ; **signatures cosign vérifiées à l'admission** (policy controller)
- [ ] Antivirus pièces jointes (ClamAV) actif sur la chaîne upload → S3 → sandbox
- [ ] Chiffrement at-rest des volumes **et snapshots** vérifié
- [ ] Compte break-glass scellé, procédure testée, alerte d'usage vérifiée
- [ ] Exercice tabletop de réponse à incident réalisé

**Données & résilience**
- [ ] **Restauration PITR testée de bout en bout** (RPO ≤ 15 min, RTO ≤ 1 h **mesurés**)
- [ ] `resync-schedules` exercé : reconstruction depuis `scheduled_jobs`, **zéro doublon**
- [ ] `user-erasure` validé sur un utilisateur de test (**toutes** les tables + volumes + tokens + jobs)
- [ ] Chaos : perte du leader orchestrator, d'un nœud NATS, des workers Trigger.dev pendant une fenêtre de crons → **aucun run perdu, aucun doublon**

**SLO & charge**
- [ ] Load test k6 : 500 sandboxes, 2 000 msg/min, 1 000 crons/h — SLO tenus
- [ ] Les **5 pages déclenchent réellement** (test d'incendie) ; digest quotidien reçu
- [ ] **Hit rate de cache ≥ 0,75 constaté**

**Exploitation**
- [ ] Runbooks 1-10 rédigés **et joués au moins une fois à blanc**
- [ ] `org-platform` active : brief santé quotidien reçu **depuis 2 semaines**
- [ ] Politiques par défaut revues (**écritures en `require_approval` partout**)
- [ ] Parcours d'onboarding testé sur les 3 canaux (liaison identité, 1ʳᵉ connexion OAuth, 1er cron)

**Conformité**
- [ ] Option no-retention activée chez le fournisseur LLM
- [ ] Rétentions par table configurées
- [ ] **Export d'audit WORM vérifié** (object-lock effectif)

---

<a id="a4"></a>
## Annexe 4 — Écarts de contrat à trancher **avant d'agir**

Ce ne sont pas des tâches de code, ce sont des **décisions**. Le nouveau `CLAUDE.md` interdit des briques **déjà construites et testées** :

| Construit + testé | Statut au nouveau contrat | Remplacement évoqué | Impact |
|---|---|---|---|
| **NATS JetStream** (bus, replay, reprise `last_seq`) | ✗ interdit | Postgres `SKIP LOCKED` | Perte du replay natif → repenser la reprise WebSocket |
| **Trigger.dev v4** (automatisations) | ✗ interdit | pg-boss / `pg_cron` | Perte des schedules dynamiques multi-tenant, timezones DST, dashboard, replay |
| **gVisor** (ADR-002, isolation sandbox) | ✗ interdit | user-namespaces / seccomp / microVM | Le niveau d'isolation doit être re-justifié |
| **Kubernetes** | ✗ interdit | — | ⚠️ **C'est le SEUL enforcement d'egress réel** (`networkpolicy-sandbox.yaml`). Le chemin compose local **ne contraint aucun egress** (J.2.2). L'invariant n°4 est donc **documenté mais non appliqué localement.** |
| **HashiCorp Vault** | ✗ (aligné) | Enveloppe KMS | Le chiffrement AES-256-GCM est **réel**, mais la **custody est locale/in-process** — l'enveloppe KMS reste à faire 🟦 |

**Ces renversements exigent des ADR 021→026** (référencées, non écrites). Tant qu'elles ne le sont pas, **l'Annexe J est la référence d'état, pas la spec**.

**Le point le plus chaud :** interdire K8s sans remplacer l'enforcement d'egress laisse l'invariant n°4 (« egress sandbox = Gateway uniquement ») **sans mécanisme d'application sur le chemin exécutable**. C'est à trancher avant de faire tourner un vrai sandbox OpenCode.

---

**Fin du document.**
