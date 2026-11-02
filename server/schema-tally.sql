-- Phase 2: Tally sync. Amounts are stored Dr positive, Cr negative.

-- One row per PC running the sync agent. Only a hash of its key is stored.
CREATE TABLE IF NOT EXISTS tally_agents (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  key_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked')),
  pc_name TEXT,
  agent_version TEXT,
  tally_reachable INTEGER,
  last_seen TEXT,
  last_ip TEXT,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL
);

-- Tally companies each agent reports, and which portal company they map to.
CREATE TABLE IF NOT EXISTS tally_companies (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES tally_agents(id),
  tally_name TEXT NOT NULL,
  tally_guid TEXT NOT NULL,
  books_from TEXT,
  company_id TEXT REFERENCES companies(id),
  is_primary INTEGER NOT NULL DEFAULT 0,
  last_reported TEXT NOT NULL,
  last_synced TEXT,
  UNIQUE (agent_id, tally_guid)
);
-- At most one primary source per portal company.
CREATE UNIQUE INDEX IF NOT EXISTS one_primary_source ON tally_companies(company_id) WHERE is_primary = 1;

-- Log of every snapshot received (data itself is in the tables below, replaced per company+FY).
CREATE TABLE IF NOT EXISTS tally_snapshots (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id),
  agent_id TEXT NOT NULL REFERENCES tally_agents(id),
  fy TEXT NOT NULL,
  period_to TEXT NOT NULL,
  synced_at TEXT NOT NULL,
  payload_sha256 TEXT NOT NULL,
  stats TEXT NOT NULL,
  checks TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('ok','warning'))
);
CREATE INDEX IF NOT EXISTS idx_snapshots ON tally_snapshots(company_id, fy, synced_at);

CREATE TABLE IF NOT EXISTS tally_groups (
  company_id TEXT NOT NULL, fy TEXT NOT NULL,
  name TEXT NOT NULL, parent TEXT, primary_group TEXT NOT NULL,
  is_revenue INTEGER NOT NULL, affects_gp INTEGER NOT NULL, is_debit INTEGER NOT NULL,
  PRIMARY KEY (company_id, fy, name)
);

CREATE TABLE IF NOT EXISTS tally_ledgers (
  company_id TEXT NOT NULL, fy TEXT NOT NULL,
  name TEXT NOT NULL, parent TEXT NOT NULL, primary_group TEXT NOT NULL,
  gstin TEXT, opening REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (company_id, fy, name)
);

-- Closing balance of each ledger at each month end of the FY (FY-to-date for P&L ledgers).
CREATE TABLE IF NOT EXISTS tally_balances (
  company_id TEXT NOT NULL, fy TEXT NOT NULL, month_end TEXT NOT NULL,
  ledger TEXT NOT NULL, closing REAL NOT NULL,
  PRIMARY KEY (company_id, fy, month_end, ledger)
);

-- Inventory value from stock items (used when stock is not kept as ledger balances).
CREATE TABLE IF NOT EXISTS tally_stock (
  company_id TEXT NOT NULL, fy TEXT NOT NULL, month_end TEXT NOT NULL,
  opening REAL NOT NULL, closing REAL NOT NULL,
  PRIMARY KEY (company_id, fy, month_end)
);

CREATE TABLE IF NOT EXISTS tally_vouchers (
  company_id TEXT NOT NULL, fy TEXT NOT NULL,
  guid TEXT NOT NULL, date TEXT NOT NULL, vtype TEXT NOT NULL, number TEXT,
  party TEXT, narration TEXT,
  PRIMARY KEY (company_id, fy, guid)
);
CREATE INDEX IF NOT EXISTS idx_vouchers_date ON tally_vouchers(company_id, fy, date);

CREATE TABLE IF NOT EXISTS tally_entries (
  company_id TEXT NOT NULL, fy TEXT NOT NULL,
  voucher_guid TEXT NOT NULL, ledger TEXT NOT NULL, amount REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_entries_ledger ON tally_entries(company_id, fy, ledger);
CREATE INDEX IF NOT EXISTS idx_entries_voucher ON tally_entries(company_id, fy, voucher_guid);

-- "Request fresh data" queue, picked up by the company's primary agent.
CREATE TABLE IF NOT EXISTS sync_requests (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id),
  requested_by TEXT NOT NULL REFERENCES users(id),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','picked','done','failed')),
  agent_id TEXT REFERENCES tally_agents(id),
  error TEXT,
  created_at TEXT NOT NULL,
  picked_at TEXT,
  done_at TEXT
);

-- Per company and FY: whether clients may see reports, and whether figures are final.
CREATE TABLE IF NOT EXISTS report_settings (
  company_id TEXT NOT NULL REFERENCES companies(id),
  fy TEXT NOT NULL,
  client_visible INTEGER NOT NULL DEFAULT 1,
  final INTEGER NOT NULL DEFAULT 0,
  updated_by TEXT REFERENCES users(id),
  updated_at TEXT,
  PRIMARY KEY (company_id, fy)
);
