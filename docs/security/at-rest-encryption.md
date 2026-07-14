# At-rest encryption (instructions.md §17)

- **OAuth tokens** (`oauth_tokens.access_token` BYTEA): AES-256-GCM, key in Vault.
  Implemented + tested in `services/mcp-gateway/src/vault.ts` (seal/open, GCM auth).
- **Sandbox volumes**: encrypted at rest via the storage class (KMS-backed EBS/CSI).
  Config: `infra/helm/axone/values.yaml` storageClass with `encrypted: true`.
- **Postgres**: managed encryption at rest (KMS) + TLS in transit.
- **S3 (attachments, audit WORM, snapshots)**: SSE-KMS + object-lock for audit.
- **Key management**: envelope encryption, KMS keys provisioned by Terraform (`infra/terraform`).
