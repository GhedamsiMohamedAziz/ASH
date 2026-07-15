-- 0005_seed_github_read_policies.sql — allow the GitHub read surface for org members (§9.4/§16.1).
-- These tools are read-only (egressClass "none") and back the real per-user OAuth token path through
-- the MCP Gateway. Idempotent: re-running keeps the effect as 'allow'.

INSERT INTO tool_policies (org_id, role, tool_pattern, effect, approver_group) VALUES
  ('org_1', 'member', 'github.list_repos',         'allow', NULL),
  ('org_1', 'member', 'github.list_issues',        'allow', NULL),
  ('org_1', 'member', 'github.get_issue',          'allow', NULL),
  ('org_1', 'member', 'github.list_pull_requests', 'allow', NULL),
  ('org_1', 'member', 'github.get_pull_request',   'allow', NULL),
  ('org_1', 'member', 'github.search_repositories','allow', NULL),
  ('org_1', 'member', 'github.search_issues',      'allow', NULL),
  ('org_1', 'member', 'github.list_commits',       'allow', NULL),
  ('org_9', 'member', 'github.list_repos',         'allow', NULL),
  ('org_9', 'member', 'github.list_issues',        'allow', NULL),
  ('org_9', 'member', 'github.get_issue',          'allow', NULL),
  ('org_9', 'member', 'github.list_pull_requests', 'allow', NULL),
  ('org_9', 'member', 'github.get_pull_request',   'allow', NULL),
  ('org_9', 'member', 'github.search_repositories','allow', NULL),
  ('org_9', 'member', 'github.search_issues',      'allow', NULL),
  ('org_9', 'member', 'github.list_commits',       'allow', NULL)
ON CONFLICT (org_id, role, tool_pattern) DO UPDATE
  SET effect = EXCLUDED.effect, approver_group = EXCLUDED.approver_group;
