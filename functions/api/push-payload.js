const responseHeaders = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store"
};

export async function onRequestPost({ request, env }) {
  const db = getDatabase(env);
  await ensurePushSchema(db);

  const body = await request.json().catch(() => ({}));
  const endpoint = String(body?.endpoint || "");
  if (!endpoint) {
    return json({ messages: [] });
  }

  const subscription = await db
    .prepare("SELECT id FROM push_subscriptions WHERE endpoint = ?1")
    .bind(endpoint)
    .first();

  if (!subscription) {
    return json({ messages: [] });
  }

  const result = await db
    .prepare(
      `SELECT id, title, body, url, tag, task_id, kind, created_at
       FROM push_messages
       WHERE subscription_id = ?1 AND delivered_at IS NULL
       ORDER BY created_at ASC
       LIMIT 6`
    )
    .bind(subscription.id)
    .all();

  const messages = result.results || [];
  const deliveredAt = new Date().toISOString();

  for (const message of messages) {
    await db
      .prepare("UPDATE push_messages SET delivered_at = ?1 WHERE id = ?2")
      .bind(deliveredAt, message.id)
      .run();
  }

  return json({
    messages: messages.map((message) => ({
      id: message.id,
      title: message.title,
      body: message.body,
      url: message.url,
      tag: message.tag,
      taskId: message.task_id,
      kind: message.kind,
      createdAt: message.created_at
    }))
  });
}

export function onRequestOptions() {
  return new Response(null, { headers: responseHeaders });
}

async function ensurePushSchema(db) {
  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS push_subscriptions (
        id TEXT PRIMARY KEY,
        household_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        endpoint TEXT NOT NULL UNIQUE,
        p256dh TEXT NOT NULL,
        auth TEXT NOT NULL,
        user_agent TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`
    )
    .run();

  await db
    .prepare(
      `CREATE INDEX IF NOT EXISTS idx_push_subscriptions_user
       ON push_subscriptions (household_id, user_id)`
    )
    .run();

  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS push_messages (
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
        error TEXT
      )`
    )
    .run();

  await db
    .prepare(
      `CREATE INDEX IF NOT EXISTS idx_push_messages_delivery
       ON push_messages (subscription_id, delivered_at, created_at)`
    )
    .run();
}

function getDatabase(env) {
  if (!env.DB) {
    throw new Error("Brakuje bindingu D1 o nazwie DB.");
  }

  return env.DB;
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: responseHeaders
  });
}
