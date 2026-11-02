-- Infominer CA Portal schema (SQLite). Nothing is hard-deleted except expired sessions and OTPs.

CREATE TABLE IF NOT EXISTS client_groups (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  created_by TEXT
);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  role TEXT NOT NULL CHECK (role IN ('director','manager','employee','client')),
  name TEXT NOT NULL,
  email TEXT UNIQUE,
  mobile TEXT UNIQUE,
  password_hash TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  client_group_id TEXT REFERENCES client_groups(id),
  failed_logins INTEGER NOT NULL DEFAULT 0,
  locked_until TEXT,
  monitoring_notice_ack_at TEXT,
  created_at TEXT NOT NULL,
  created_by TEXT,
  updated_at TEXT NOT NULL,
  CHECK (role <> 'client' OR client_group_id IS NOT NULL),
  CHECK (email IS NOT NULL OR mobile IS NOT NULL)
);

CREATE TABLE IF NOT EXISTS companies (
  id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL REFERENCES client_groups(id),
  legal_name TEXT NOT NULL,
  pan TEXT,
  gstin TEXT,
  tally_name TEXT,
  manager_id TEXT REFERENCES users(id),
  created_at TEXT NOT NULL,
  created_by TEXT
);

CREATE TABLE IF NOT EXISTS document_categories (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  sort INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS documents (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id),
  category_id INTEGER NOT NULL REFERENCES document_categories(id),
  fy TEXT NOT NULL,
  month INTEGER CHECK (month BETWEEN 1 AND 12),
  original_name TEXT NOT NULL,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL,
  sha256 TEXT NOT NULL,            -- hash of the plaintext, verified on every download
  wrapped_key TEXT NOT NULL,       -- per-file key, encrypted with MASTER_KEY
  iv TEXT NOT NULL,
  auth_tag TEXT NOT NULL,
  uploaded_by TEXT NOT NULL REFERENCES users(id),
  review_status TEXT NOT NULL DEFAULT 'pending' CHECK (review_status IN ('pending','accepted','reupload','not_needed')),
  review_note TEXT,
  reviewed_by TEXT REFERENCES users(id),
  deleted_at TEXT,
  deleted_by TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_documents_company ON documents(company_id, category_id, fy);
CREATE INDEX IF NOT EXISTS idx_documents_hash ON documents(company_id, sha256);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id),
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  period TEXT,
  instructions TEXT,
  assignee_id TEXT REFERENCES users(id),
  reviewer_id TEXT REFERENCES users(id),
  created_by TEXT NOT NULL REFERENCES users(id),
  due_date TEXT,
  statutory_due TEXT,
  priority TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('low','normal','high','urgent')),
  status TEXT NOT NULL CHECK (status IN ('requested','assigned','in_progress','submitted','rework','approved','cancelled')),
  estimate_hours REAL,
  rework_count INTEGER NOT NULL DEFAULT 0,
  submission_note TEXT,
  client_note TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  submitted_at TEXT,
  approved_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_tasks_assignee ON tasks(assignee_id, status);
CREATE INDEX IF NOT EXISTS idx_tasks_reviewer ON tasks(reviewer_id, status);

CREATE TABLE IF NOT EXISTS task_events (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  from_status TEXT,
  to_status TEXT NOT NULL,
  actor_id TEXT NOT NULL REFERENCES users(id),
  comment TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS access_grants (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  employee_id TEXT NOT NULL REFERENCES users(id),
  company_id TEXT NOT NULL REFERENCES companies(id),
  category_ids TEXT NOT NULL,      -- JSON array of category ids
  reason TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('requested','granted','rejected','revoked')),
  decided_by TEXT REFERENCES users(id),
  decided_at TEXT,
  decision_note TEXT,
  expires_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS time_entries (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  task_id TEXT REFERENCES tasks(id),
  category TEXT,                   -- non-task time: training, meeting, admin
  started_at TEXT NOT NULL,
  ended_at TEXT,
  last_heartbeat TEXT,
  idle_seconds INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL CHECK (source IN ('timer','manual')),
  note TEXT,
  status TEXT NOT NULL DEFAULT 'ok' CHECK (status IN ('ok','pending_approval','rejected')),
  approved_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL,
  CHECK (task_id IS NOT NULL OR category IS NOT NULL)
);
CREATE UNIQUE INDEX IF NOT EXISTS one_running_timer ON time_entries(user_id) WHERE ended_at IS NULL;

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  last_seen TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  ip TEXT,
  user_agent TEXT
);

CREATE TABLE IF NOT EXISTS login_challenges (
  id TEXT PRIMARY KEY,
  user_id TEXT,                    -- NULL for unknown identifiers (prevents account enumeration)
  code_hash TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  used_at TEXT,
  ip TEXT,
  created_at TEXT NOT NULL
);

-- Append-only, hash-chained audit trail. Triggers below block edits and deletes.
CREATE TABLE IF NOT EXISTS audit_log (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  actor_id TEXT,
  actor_role TEXT,
  action TEXT NOT NULL,
  object_type TEXT,
  object_id TEXT,
  company_id TEXT,
  ip TEXT,
  details TEXT,
  prev_hash TEXT NOT NULL,
  hash TEXT NOT NULL
);
CREATE TRIGGER IF NOT EXISTS audit_no_update BEFORE UPDATE ON audit_log
BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;
CREATE TRIGGER IF NOT EXISTS audit_no_delete BEFORE DELETE ON audit_log
BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;

-- DPDP Act 2023: consent records, data-principal requests, breach register.
CREATE TABLE IF NOT EXISTS consents (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  notice_version TEXT NOT NULL,
  purposes TEXT NOT NULL,          -- JSON array of purpose codes consented to
  given_at TEXT NOT NULL,
  withdrawn_at TEXT,
  ip TEXT
);

CREATE TABLE IF NOT EXISTS dpdp_requests (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  type TEXT NOT NULL CHECK (type IN ('access','correction','erasure','grievance','nomination','withdraw_consent')),
  details TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','in_progress','closed','rejected')),
  response TEXT,
  due_at TEXT NOT NULL,
  handled_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL,
  closed_at TEXT
);

CREATE TABLE IF NOT EXISTS breach_register (
  id TEXT PRIMARY KEY,
  detected_at TEXT NOT NULL,
  description TEXT NOT NULL,
  data_affected TEXT NOT NULL,
  principals_affected INTEGER,
  board_intimated_at TEXT,
  principals_notified_at TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','contained','closed')),
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
