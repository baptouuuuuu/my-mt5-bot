CREATE TABLE accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  login TEXT NOT NULL,
  server TEXT NOT NULL,
  provider TEXT NOT NULL DEFAULT 'mock',
  secret_enc TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'unknown',
  last_error TEXT,
  last_sync_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE snapshots (
  account_id INTEGER PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  account_info TEXT,
  positions TEXT NOT NULL DEFAULT '[]',
  orders TEXT NOT NULL DEFAULT '[]',
  updated_at TEXT NOT NULL
);

CREATE TABLE rule_configs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL CHECK (type IN ('be', 'autosltp')),
  account_id INTEGER REFERENCES accounts(id) ON DELETE CASCADE,
  enabled INTEGER NOT NULL DEFAULT 0,
  config TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX rule_configs_scope ON rule_configs (type, COALESCE(account_id, 0));

CREATE TABLE copy_links (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  dest_account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  enabled INTEGER NOT NULL DEFAULT 1,
  config TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (source_account_id, dest_account_id)
);

CREATE TABLE copy_map (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_account_id INTEGER NOT NULL,
  source_ticket TEXT NOT NULL,
  dest_account_id INTEGER NOT NULL,
  dest_ticket TEXT,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (source_account_id, source_ticket, dest_account_id)
);

CREATE TABLE rule_cooldowns (
  account_id INTEGER NOT NULL,
  ticket TEXT NOT NULL,
  rule TEXT NOT NULL,
  last_at INTEGER NOT NULL,
  PRIMARY KEY (account_id, ticket, rule)
);

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
INSERT INTO settings (key, value) VALUES ('kill_switch', 'false'), ('dry_run', 'true');

CREATE TABLE events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  level TEXT NOT NULL,
  type TEXT NOT NULL,
  account_id INTEGER,
  correlation_id TEXT,
  message TEXT NOT NULL,
  data TEXT
);
CREATE INDEX events_ts ON events (id DESC);
