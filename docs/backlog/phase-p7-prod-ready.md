# P7 — Prod-ready

> K8s+gVisor, GitOps, observability, evals gate, HA/DR, load, pentest.  ·  _4 wk_  ·  17 tickets

## ✅ AX-075 — K8s topology + gVisor

Namespaces per §22.1, dedicated tainted sandbox node pool, gVisor RuntimeClass.

- **Estimate:** L  ·  **Labels:** infra, k8s  ·  **Spec:** §22.1
- **Depends on:** AX-015
- **Acceptance:**
  - [ ] Namespaces deployed
  - [ ] sandbox pool isolated
  - [ ] gVisor enforced

## ✅ AX-076 — Sandbox NetworkPolicy lockdown

Egress only to mcp-gateway:8443 + llm-proxy:4000 + kube-dns; ingress only from orchestrator.

- **Estimate:** M  ·  **Labels:** infra, security  ·  **Spec:** §17.4, §22.3
- **Depends on:** AX-075
- **Acceptance:**
  - [ ] Policy applied
  - [ ] external egress blocked (test)
  - [ ] principle #2 verified

## ✅ AX-077 — Terraform IaC

VPC, cluster, KMS, S3, DNS as code.

- **Estimate:** L  ·  **Labels:** infra, terraform  ·  **Spec:** §22.1
- **Depends on:** AX-075
- **Acceptance:**
  - [ ] `terraform apply` provisions base
  - [ ] state remote+locked
  - [ ] reviewed plan in CI

## ✅ AX-078 — Helm charts per service

Chart per service + values per env; Trigger.dev official chart wired.

- **Estimate:** L  ·  **Labels:** infra, helm  ·  **Spec:** §22.1
- **Depends on:** AX-075
- **Acceptance:**
  - [ ] Charts render
  - [ ] env values separated
  - [ ] resource requests/limits set

## ✅ AX-079 — ArgoCD GitOps

App-of-apps; auto-sync staging, manual-approval prod, canary 10% on backend-core.

- **Estimate:** M  ·  **Labels:** infra, gitops  ·  **Spec:** §22.1, §22.3
- **Depends on:** AX-078
- **Acceptance:**
  - [ ] Staging auto-syncs
  - [ ] prod gated
  - [ ] canary + rollback wired

## ✅ AX-080 — Full CI/CD (evals gate, supply chain)

Extend CI: evals gate, image build+SBOM(syft)+cosign, Trivy(CRITICAL=STOP), Atlas migration lint.

- **Estimate:** L  ·  **Labels:** ci, security  ·  **Spec:** §22.3
- **Depends on:** AX-008, AX-083
- **Acceptance:**
  - [ ] Evals gate blocks >3% regression
  - [ ] signed images + SBOM
  - [ ] Trivy/gitleaks blocking

## ✅ AX-081 — Observability stack

OTel traces + Prometheus + Grafana + Loki + Tempo; dashboards per service.

- **Estimate:** L  ·  **Labels:** observability  ·  **Spec:** §19
- **Depends on:** AX-007
- **Acceptance:**
  - [ ] Traces end-to-end
  - [ ] logs+metrics shipped
  - [ ] service dashboards live

## ✅ AX-082 — SLO dashboards + bi-level alerting

SLOs (Annexe A): first-token P95, cron failure rate, cron delay, error-budget burn; multi-window multi-burn alerts.

- **Estimate:** M  ·  **Labels:** observability, sre  ·  **Spec:** §19, §24.6, Annexe A
- **Depends on:** AX-081
- **Acceptance:**
  - [ ] SLO dashboards live
  - [ ] burn-rate alerts fire
  - [ ] paging vs ticket tiers

## ✅ AX-083 — Agent evals (golden + adversarial)

150 golden tasks + 20 cron scenarios + injection corpus; run as CI gate.

- **Estimate:** L  ·  **Labels:** evals, quality  ·  **Spec:** §20.2
- **Depends on:** AX-035
- **Acceptance:**
  - [ ] Golden set runs in CI
  - [ ] adversarial corpus enforced
  - [ ] regression threshold wired

## ✅ AX-084 — Warm pool + hibernation

Warm sandbox pool + aggressive hibernation to hit the cost model.

- **Estimate:** M  ·  **Labels:** orchestrator, cost  ·  **Spec:** §10.1, §23, §25
- **Depends on:** AX-014
- **Acceptance:**
  - [ ] Warm pool serves cold-starts
  - [ ] idle sandboxes hibernate
  - [ ] cost per §25 met

## ✅ AX-085 — HA topology

Postgres primary+replicas failover, NATS 3-node cluster, orchestrator leader election, multi-AZ.

- **Estimate:** L  ·  **Labels:** infra, ha  ·  **Spec:** §23
- **Depends on:** AX-075
- **Acceptance:**
  - [ ] Failover tested
  - [ ] NATS quorum
  - [ ] leader election verified

## ✅ AX-086 — DR: backups + resync

WAL archiving+snapshots+Trigger.dev dumps (RPO 15m/RTO 1h); resync-schedules script.

- **Estimate:** M  ·  **Labels:** infra, dr  ·  **Spec:** §23
- **Depends on:** AX-085
- **Acceptance:**
  - [ ] Restore drill meets RPO/RTO
  - [ ] resync-schedules rebuilds crons idempotently
  - [ ] runbook written

## ✅ AX-087 — Load tests

500 active sandboxes + 1000 crons/h; verify autoscaling and jitter smoothing.

- **Estimate:** M  ·  **Labels:** performance  ·  **Spec:** §23
- **Depends on:** AX-084, AX-079
- **Acceptance:**
  - [ ] Load target sustained
  - [ ] autoscaling holds SLO
  - [ ] cron spikes smoothed

## ✅ AX-088 — Pentest + incident response

External pentest; breach/incident-response runbook; remediation tracked.

- **Estimate:** L  ·  **Labels:** security  ·  **Spec:** §17.2, §17.5
- **Depends on:** AX-076, AX-037
- **Acceptance:**
  - [ ] Pentest findings triaged
  - [ ] IR runbook exercised
  - [ ] criticals closed

## ✅ AX-089 — Admin console complete + platctl + runbooks

Full console, platctl CLI, runbooks; solo-ops rituals.

- **Estimate:** L  ·  **Labels:** admin, ops  ·  **Spec:** §24
- **Depends on:** AX-040
- **Acceptance:**
  - [ ] Console covers §24.2 screens
  - [ ] platctl operational
  - [ ] runbooks published

## ✅ AX-090 — org-platform dogfooding

Run the platform team on its own org (§24.8) as living QA.

- **Estimate:** S  ·  **Labels:** ops, quality  ·  **Spec:** §24.8
- **Depends on:** AX-089
- **Acceptance:**
  - [ ] org-platform active
  - [ ] team uses agent daily
  - [ ] issues fed back

## 🚧 AX-091 — P7 exit: SLOs met, 99.9%

All SLOs (Annexe A) sustained; availability target proven.

- **Estimate:** M  ·  **Labels:** milestone  ·  **Spec:** §29 P7
- **Depends on:** AX-082, AX-086, AX-087, AX-088
- **Acceptance:**
  - [ ] SLOs green over window
  - [ ] 99.9% availability
  - [ ] go-live checklist (Annexe D) complete
