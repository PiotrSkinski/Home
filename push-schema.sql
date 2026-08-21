CREATE TABLE IF NOT EXISTS push_subscriptions (
  id TEXT PRIMARY KEY,
  household_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  user_agent TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_push_subscriptions_user
  ON push_subscriptions (household_id, user_id);

CREATE TABLE IF NOT EXISTS push_messages (
  id TEXT PRIMARY KEY,
  subscription_id TEXT NOT NULL,
  household_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  task_id TEXT,
  kind TEXT NOT NULL,
  dedupe_key TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  url TEXT,
  tag TEXT,
  created_at TEXT NOT NULL,
  sent_at TEXT,
  delivered_at TEXT,
  error TEXT,
  attempts INTEGER DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_push_messages_delivery
  ON push_messages (subscription_id, delivered_at, created_at);

-- Migracja dla istniejacych baz: licznik prob wysylki.
-- Jesli kolumna juz istnieje, D1 zglosi blad "duplicate column name" - mozna go zignorowac.
ALTER TABLE push_messages ADD COLUMN attempts INTEGER DEFAULT 0;
