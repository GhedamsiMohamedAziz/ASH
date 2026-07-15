-- mcpmarket auto-register bridge (docs/mcpmarket-bridge.md).
-- Registry of external MCP servers the Gateway has mounted. Auto-registered tools
-- default to require_approval in tool_policies until a human promotes them —
-- a marketplace server's declared taint is a CLAIM, trusted only after review
-- (invariant #8: detection is not a boundary).

CREATE TABLE IF NOT EXISTS mcp_servers (
  id             TEXT PRIMARY KEY,               -- mcpmarket server id / slug
  name           TEXT NOT NULL,
  mcp_url        TEXT NOT NULL,                  -- remote MCP endpoint (streamable HTTP)
  category       TEXT,
  status         TEXT NOT NULL DEFAULT 'pending' -- pending | active | revoked
                 CHECK (status IN ('pending', 'active', 'revoked')),
  declared_meta  JSONB NOT NULL DEFAULT '{}'::jsonb,  -- the server's SELF-DECLARED taint (a claim)
  registered_by  TEXT,                           -- actor who registered it
  org_id         TEXT,                           -- scoping org (NULL = platform-wide)
  registered_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at     TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_mcp_servers_status ON mcp_servers (status);

-- Tools discovered from a registered server, for audit/provenance + promotion.
-- effect mirrors tool_policies; a tool stays require_approval until promoted.
CREATE TABLE IF NOT EXISTS mcp_server_tools (
  server_id      TEXT NOT NULL REFERENCES mcp_servers(id) ON DELETE CASCADE,
  tool_pattern   TEXT NOT NULL,                  -- e.g. "acme.do_thing"
  ingests_untrusted BOOLEAN NOT NULL DEFAULT true,  -- safe default until reviewed
  egress_class   TEXT NOT NULL DEFAULT 'public',    -- safe default until reviewed
  promoted       BOOLEAN NOT NULL DEFAULT false,    -- false => require_approval
  PRIMARY KEY (server_id, tool_pattern)
);
