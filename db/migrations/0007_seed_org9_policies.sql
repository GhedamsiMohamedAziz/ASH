-- 0007_seed_org9_policies.sql — tool_policies for org_9 (the local test user usr_mehdi's org).
-- Mirrors the dev default set (prompt-layer _DEFAULT_POLICIES) so a per-turn TASK JWT minted for a
-- real-org user resolves a real tool matrix — WITHOUT weakening tenant isolation (this is org_9's own
-- row set, matched exactly by the engine). Prod creates these per org via the admin surface. Idempotent.

INSERT INTO orgs (id, name) VALUES ('org_9', 'Mehdi Org')
  ON CONFLICT (id) DO NOTHING;

INSERT INTO tool_policies (org_id, role, tool_pattern, effect, approver_group) VALUES
  ('org_9', 'member', 'github.search',                'allow',            NULL),
  ('org_9', 'member', 'github.read',                  'allow',            NULL),
  ('org_9', 'member', 'github.create_pr',             'allow',            NULL),
  ('org_9', 'member', 'github.merge_pr',              'require_approval', 'tech-leads'),
  -- write a file = a real commit → human-approval-gated (the interactive OpenCode-permission gate
  -- promotes it to allowed only for the OpenCode path; the policy stays require_approval).
  ('org_9', 'member', 'github.create_or_update_file', 'require_approval', NULL),
  ('org_9', 'member', 'github.list_repos',            'allow',            NULL),
  ('org_9', 'member', 'github.list_issues',           'allow',            NULL),
  ('org_9', 'member', 'github.get_issue',             'allow',            NULL),
  ('org_9', 'member', 'github.list_pull_requests',    'allow',            NULL),
  ('org_9', 'member', 'github.get_pull_request',      'allow',            NULL),
  ('org_9', 'member', 'github.search_repositories',   'allow',            NULL),
  ('org_9', 'member', 'github.search_issues',         'allow',            NULL),
  ('org_9', 'member', 'github.list_commits',          'allow',            NULL),
  ('org_9', 'member', 'database.read',                'allow',            NULL),
  ('org_9', 'member', 'database.write',               'deny',             NULL),
  ('org_9', 'member', 'scheduler.list_crons',         'allow',            NULL),
  ('org_9', 'member', 'scheduler.create_cron',        'require_approval', NULL),
  -- mcpmarket autolearn: fully autonomous (search AND register run without a human-approval prompt).
  ('org_9', 'member', 'mcpmarket.search',             'allow',            NULL),
  ('org_9', 'member', 'mcpmarket.request_register',   'allow',            NULL)
ON CONFLICT (org_id, role, tool_pattern) DO UPDATE
  SET effect = EXCLUDED.effect, approver_group = EXCLUDED.approver_group;
