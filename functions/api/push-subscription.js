const API_USER_HEADER = "x-household-user";
const API_HOUSEHOLD_HEADER = "x-household-id";
const API_PIN_HEADER = "x-household-pin";

const responseHeaders = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store"
};

export async function onRequestPost({ request, env }) {
  const db = getDatabase(env);
  await ensurePushSchema(db);

  const auth = await authorize(request, db);
  if (!auth.ok) {
    return json({ error: auth.error }, auth.status);
  }

  const body = await request.json();
  const subscription = normalizeSubscription(body?.subscription);
  if (!subscription) {
    return json({ error: "Brakuje subskrypcji push." }, 400);
  }

  const now = new Date().toISOString();
  const id = `sub_${await sha256(subscription.endpoint)}`;
  const userAgent = request.headers.get("user-agent") || "";

  await db
    .prepare(
      `INSERT INTO push_subscriptions
       (id, household_id, user_id, endpoint, p256dh, auth, user_agent, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8)
       ON CONFLICT(endpoint) DO UPDATE SET
         household_id = excluded.household_id,
         user_id = excluded.user_id,
         p256dh = excluded.p256dh,
         auth = excluded.auth,
         user_agent = excluded.user_agent,
         updated_at = excluded.updated_at`
    )
    .bind(
      id,
      auth.state.household.id,
      auth.user.id,
      subscription.endpoint,
      subscription.keys.p256dh,
      subscription.keys.auth,
      userAgent,
      now
    )
    .run();

  return json({ ok: true });
}

export async function onRequestDelete({ request, env }) {
  const db = getDatabase(env);
  await ensurePushSchema(db);

  const auth = await authorize(request, db);
  if (!auth.ok) {
    return json({ error: auth.error }, auth.status);
  }

  const body = await request.json().catch(() => ({}));
  const endpoint = String(body?.endpoint || "");
  if (!endpoint) {
    return json({ error: "Brakuje endpointu subskrypcji." }, 400);
  }

  await db
    .prepare("DELETE FROM push_subscriptions WHERE household_id = ?1 AND user_id = ?2 AND endpoint = ?3")
    .bind(auth.state.household.id, auth.user.id, endpoint)
    .run();

  return json({ ok: true });
}

export function onRequestOptions() {
  return new Response(null, { headers: responseHeaders });
}

function normalizeSubscription(subscription) {
  const endpoint = String(subscription?.endpoint || "");
  const p256dh = String(subscription?.keys?.p256dh || "");
  const auth = String(subscription?.keys?.auth || "");

  if (!endpoint || !p256dh || !auth) {
    return null;
  }

  return { endpoint, keys: { p256dh, auth } };
}

async function authorize(request, db) {
  const householdId = request.headers.get(API_HOUSEHOLD_HEADER);
  const userId = request.headers.get(API_USER_HEADER);
  const pin = normalizePin(request.headers.get(API_PIN_HEADER));

  if (!householdId || !userId || pin.length !== 4) {
    return { ok: false, status: 401, error: "Brakuje danych logowania." };
  }

  const row = await db.prepare("SELECT value FROM households WHERE id = ?1").bind(householdId).first();
  if (!row) {
    return { ok: false, status: 404, error: "Nie znaleziono domu." };
  }

  const state = JSON.parse(row.value);
  const user = state.users?.find((item) => item.id === userId);
  if (!user || normalizePin(user.pin) !== pin) {
    return { ok: false, status: 401, error: "Nieprawidłowy PIN." };
  }

  return { ok: true, state, user };
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
}

async function sha256(value) {
  const bytes = new TextEncoder().encode(value);
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return base64Url(new Uint8Array(hash)).slice(0, 32);
}

function normalizePin(pin) {
  return String(pin || "").replace(/\D/g, "").slice(0, 4);
}

function getDatabase(env) {
  if (!env.DB) {
    throw new Error("Brakuje bindingu D1 o nazwie DB.");
  }

  return env.DB;
}

function base64Url(bytes) {
  let binary = "";
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: responseHeaders
  });
}
