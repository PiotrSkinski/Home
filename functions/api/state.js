const STATE_KEY = "default";

const responseHeaders = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store"
};

export async function onRequestGet({ env }) {
  const db = getDatabase(env);
  await ensureSchema(db);

  const row = await db
    .prepare("SELECT value, updated_at FROM app_state WHERE key = ?1")
    .bind(STATE_KEY)
    .first();

  return json({
    state: row ? JSON.parse(row.value) : null,
    updatedAt: row?.updated_at || null
  });
}

export async function onRequestPost(context) {
  return saveState(context);
}

export async function onRequestPut(context) {
  return saveState(context);
}

export function onRequestOptions() {
  return new Response(null, { headers: responseHeaders });
}

async function saveState({ request, env }) {
  const db = getDatabase(env);
  const body = await request.json();
  const nextState = body?.state || body;

  if (!nextState || !Array.isArray(nextState.users) || !Array.isArray(nextState.tasks)) {
    return json({ error: "Nieprawidlowy stan aplikacji." }, 400);
  }

  await ensureSchema(db);

  const updatedAt = new Date().toISOString();

  await db
    .prepare(
      `INSERT INTO app_state (key, value, updated_at)
       VALUES (?1, ?2, ?3)
       ON CONFLICT(key) DO UPDATE SET
         value = excluded.value,
         updated_at = excluded.updated_at`
    )
    .bind(STATE_KEY, JSON.stringify(nextState), updatedAt)
    .run();

  return json({ ok: true, updatedAt });
}

async function ensureSchema(db) {
  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS app_state (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`
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
