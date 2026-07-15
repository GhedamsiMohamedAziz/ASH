# Helm chart — status

`mcp-server-template/` currently holds only `Chart.yaml` + `values.yaml`, matching the maturity
of the repo's other chart (`infra/helm/axone/` is the same: metadata + per-env values, no
`templates/` manifests yet). Rather than invent a bespoke Deployment/Service/NetworkPolicy shape
with nothing in-repo to mirror, this is left as an explicit TODO:

- `templates/deployment.yaml` — container from this connector's Dockerfile, `values.yaml`'s
  `connector.replicas` / `connector.resources` / `connector.env`.
- `templates/service.yaml` — ClusterIP on `connector.port` (8090 by default).
- `templates/networkpolicy.yaml` — restrict ingress to the `mcp-gateway` pod only, egress to the
  real upstream + DNS. Model it on `infra/helm/networkpolicy-sandbox.yaml`, which does the
  equivalent lockdown for sandboxes (§14.3 N2, §17.4).

When the platform's real Helm templates land for `infra/helm/axone`, port the same
`templates/` shape here rather than diverging.
