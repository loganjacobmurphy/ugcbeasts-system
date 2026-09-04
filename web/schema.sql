-- The database behind both installs.
--
-- logan-hq is single user: one app_state row with the id 'singleton'.
-- ugcbeasts is multi user: one app_state row per person, keyed by the email
-- Cloudflare Access verified (see functions/api/_middleware.ts), plus users and
-- shared_config below.

-- Everything one person owns: their campaigns, schedule, videos and logs, held
-- as a single JSON document. id is their email on the shared install.
CREATE TABLE IF NOT EXISTS app_state (
  id TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- The half everybody shares: formats and templates, so a new machine does not
-- start empty and an edit reaches the whole team. Rows: 'formats', 'templates'.
CREATE TABLE IF NOT EXISTS shared_config (
  id TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Who is allowed in. Signing in with Google proves an email; it does not make
-- someone welcome, so everyone new lands as 'pending' until an admin approves.
--
-- greenroom_origin and greenroom_key point at that person's OWN machine. The
-- editor runs locally on their GPU, so their library, renders and costs are
-- theirs. Pointing everyone at one origin would put the team inside one laptop.
CREATE TABLE IF NOT EXISTS users (
  email TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'pending',
  is_admin INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER,
  approved_at INTEGER,
  greenroom_origin TEXT,
  greenroom_key TEXT
);

CREATE INDEX IF NOT EXISTS users_status ON users (status);
