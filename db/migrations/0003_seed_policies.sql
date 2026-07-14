-- 0003_seed_policies.sql — default tool_policies for the dev org (AX-032, §9.4/§16.1).
-- Idempotent seed so the permissions engine has a real matrix to evaluate.
-- effect: allow | require_approval | deny. approver_group routes the card (team mode §3.3).

INSERT INTO orgs (id, name) VALUES ('org_1', 'Dev Org')
  ON CONFLICT (id) DO NOTHING;

INSERT INTO tool_policies (org_id, role, tool_pattern, effect, approver_group) VALUES
  ('org_1', 'member',     'github.search',         'allow',            NULL),
  ('org_1', 'member',     'github.read',           'allow',            NULL),
  ('org_1', 'member',     'github.create_pr',      'allow',            NULL),
  ('org_1', 'member',     'github.merge_pr',       'require_approval',  'tech-leads'),
  ('org_1', 'member',     'database.read',         'allow',            NULL),
  ('org_1', 'member',     'database.write',        'deny',             NULL),
  ('org_1', 'member',     'scheduler.list_crons',  'allow',            NULL),
  ('org_1', 'member',     'scheduler.create_cron', 'require_approval',  NULL),
  -- power_user: a broader github.* allow, but merge + db.write still gated/denied
  ('org_1', 'power_user', 'github.*',              'allow',            NULL),
  ('org_1', 'power_user', 'github.merge_pr',       'require_approval',  'tech-leads'),
  ('org_1', 'power_user', 'database.read',         'allow',            NULL),
  ('org_1', 'power_user', 'database.write',        'require_approval',  'tech-leads'),
  ('org_1', 'power_user', 'scheduler.create_cron', 'allow',            NULL)
ON CONFLICT (org_id, role, tool_pattern) DO UPDATE
  SET effect = EXCLUDED.effect, approver_group = EXCLUDED.approver_group;
