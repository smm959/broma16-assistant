export const SCHEMA = /* sql */ `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL DEFAULT 'Новый диалог',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  pinned INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  tool_name TEXT,
  tool_calls TEXT,
  tool_call_id TEXT,
  error TEXT,
  sources TEXT
);
CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id, created_at);

CREATE TABLE IF NOT EXISTS chat_attachments (
  id TEXT PRIMARY KEY,
  message_id TEXT REFERENCES messages(id) ON DELETE CASCADE,
  filename TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size INTEGER NOT NULL,
  kind TEXT NOT NULL,
  path TEXT,
  extracted_text TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS artists (
  id TEXT PRIMARY KEY,
  artist_name TEXT NOT NULL,
  profile_links TEXT NOT NULL DEFAULT '{}',
  notes TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS releases (
  id TEXT PRIMARY KEY,
  artist_id TEXT REFERENCES artists(id) ON DELETE SET NULL,
  artist TEXT,
  title TEXT NOT NULL,
  release_date TEXT,
  upc TEXT,
  ean TEXT,
  isrc TEXT,
  status TEXT NOT NULL DEFAULT 'unknown',
  platform_links TEXT NOT NULL DEFAULT '{}',
  notes TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS faq_articles (
  id TEXT PRIMARY KEY,
  external_id TEXT UNIQUE,
  title TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'General',
  folder TEXT,
  content TEXT NOT NULL,
  content_text TEXT NOT NULL,
  url TEXT NOT NULL,
  source TEXT NOT NULL,
  last_verified INTEGER NOT NULL,
  content_hash TEXT NOT NULL,
  official INTEGER NOT NULL DEFAULT 1,
  synced_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_faq_category ON faq_articles(category);

CREATE TABLE IF NOT EXISTS contacts (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  department TEXT NOT NULL,
  purpose TEXT NOT NULL,
  verification_status TEXT NOT NULL DEFAULT 'UNKNOWN',
  source_url TEXT,
  last_verified INTEGER,
  supported_issue_types TEXT NOT NULL DEFAULT '[]'
);

CREATE TABLE IF NOT EXISTS tickets (
  id TEXT PRIMARY KEY,
  subject TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'other',
  artist TEXT,
  release_id TEXT REFERENCES releases(id) ON DELETE SET NULL,
  recipient TEXT,
  status TEXT NOT NULL DEFAULT 'draft',
  external_ticket_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_message_at INTEGER,
  follow_up_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_tickets_status ON tickets(status, updated_at);

CREATE TABLE IF NOT EXISTS ticket_messages (
  id TEXT PRIMARY KEY,
  ticket_id TEXT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  direction TEXT NOT NULL,
  sender TEXT,
  recipient TEXT,
  subject TEXT,
  body TEXT NOT NULL,
  timestamp INTEGER NOT NULL,
  message_id TEXT,
  email_message_id TEXT
);
CREATE INDEX IF NOT EXISTS idx_ticket_messages ON ticket_messages(ticket_id, timestamp);

CREATE TABLE IF NOT EXISTS pending_actions (
  id TEXT PRIMARY KEY,
  conversation_id TEXT,
  tool TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  risk TEXT NOT NULL DEFAULT 'confirm',
  params TEXT NOT NULL,
  preview TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  placeholder_id TEXT,
  created_at INTEGER NOT NULL,
  result TEXT,
  error TEXT
);

CREATE TABLE IF NOT EXISTS activity_events (
  id TEXT PRIMARY KEY,
  conversation_id TEXT,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  detail TEXT,
  tool TEXT,
  created_at INTEGER NOT NULL,
  duration_ms INTEGER
);
CREATE INDEX IF NOT EXISTS idx_activity_conv ON activity_events(conversation_id, created_at);

CREATE TABLE IF NOT EXISTS email_accounts (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  email TEXT NOT NULL,
  provider TEXT NOT NULL DEFAULT 'imap',
  imap_host TEXT NOT NULL,
  imap_port INTEGER NOT NULL,
  imap_secure INTEGER NOT NULL DEFAULT 1,
  smtp_host TEXT NOT NULL,
  smtp_port INTEGER NOT NULL,
  smtp_secure INTEGER NOT NULL DEFAULT 1,
  username TEXT NOT NULL,
  last_sync_at INTEGER,
  status TEXT NOT NULL DEFAULT 'not_configured',
  last_error TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS email_messages (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  uid TEXT NOT NULL,
  folder TEXT NOT NULL,
  direction TEXT NOT NULL,
  sender TEXT,
  sender_name TEXT,
  recipient TEXT,
  subject TEXT,
  body_text TEXT,
  body_html TEXT,
  date INTEGER NOT NULL,
  ticket_id TEXT,
  department TEXT,
  category TEXT,
  is_broma16 INTEGER NOT NULL DEFAULT 0,
  flags TEXT NOT NULL DEFAULT '[]',
  attachments TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL,
  UNIQUE(account_id, folder, uid)
);
CREATE INDEX IF NOT EXISTS idx_email_date ON email_messages(date DESC);
CREATE INDEX IF NOT EXISTS idx_email_ticket ON email_messages(ticket_id);

CREATE TABLE IF NOT EXISTS drafts (
  id TEXT PRIMARY KEY,
  ticket_id TEXT,
  account_id TEXT,
  recipient TEXT NOT NULL,
  cc TEXT,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  attachments TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_logs (
  id TEXT PRIMARY KEY,
  action TEXT NOT NULL,
  result TEXT,
  error TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS memory_facts (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_memory_scope ON memory_facts(scope, key);

CREATE TABLE IF NOT EXISTS kv (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tg_submissions (
  id TEXT PRIMARY KEY,
  chat_id TEXT,
  username TEXT,
  title TEXT NOT NULL,
  artist TEXT NOT NULL,
  label TEXT NOT NULL DEFAULT 'Music 959',
  genres TEXT NOT NULL DEFAULT '[]',
  release_date TEXT,
  explicit INTEGER NOT NULL DEFAULT 0,
  author TEXT,
  description TEXT,
  audio_path TEXT NOT NULL,
  audio_name TEXT,
  cover_path TEXT NOT NULL,
  cover_name TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at INTEGER NOT NULL,
  decided_at INTEGER,
  result TEXT
);
CREATE INDEX IF NOT EXISTS idx_tg_submissions_status ON tg_submissions(status, created_at);
`
