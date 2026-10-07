// Worker ponawia nieudaną wysyłkę w kolejnych przebiegach (co 10 min, do 3
// prób), więc push może przyjść do ~20 min po utworzeniu wiadomości.
const RECENT_WINDOW_MINUTES = 30;

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

  // Jeden push = jedno powiadomienie. Wcześniej każdy push pobierał WSZYSTKIE
  // oczekujące wiadomości. Gdy worker wysłał w jednym przebiegu dwie (dwa
  // zadania o 18:00, przypomnienie + „nowe zadanie”), telefon dostawał dwa
  // pushe, oba pytały tu jednocześnie, oba widziały tę samą listę, zanim
  // którykolwiek zdążył ją oznaczyć — i każda wiadomość wyskakiwała dwa razy.
  // Teraz każdy push przejmuje dokładnie jedną wiadomość, a przejęcie jest
  // warunkowe (delivered_at IS NULL), więc dwa równoległe pushe nigdy nie
  // dostaną tej samej.
  const now = Date.now();
  const deliveredAt = new Date(now).toISOString();
  const recentCutoff = new Date(now - RECENT_WINDOW_MINUTES * 60 * 1000).toISOString();

  // Wiadomość starsza niż okno ponowień i tak nie ma już swojego pusha
  // w drodze. Skoro ten telefon odbiera, zamykamy ją bez pokazywania —
  // inaczej wyskoczyłaby z opóźnieniem przy jakimś zupełnie innym pushu.
  await db
    .prepare(
      `UPDATE push_messages SET delivered_at = ?1
       WHERE subscription_id = ?2 AND delivered_at IS NULL AND created_at < ?3`
    )
    .bind(deliveredAt, subscription.id, recentCutoff)
    .run();

  const result = await db
    .prepare(
      `SELECT id, household_id, title, body, url, tag, task_id, kind, created_at
       FROM push_messages
       WHERE subscription_id = ?1 AND delivered_at IS NULL
       ORDER BY created_at DESC
       LIMIT 6`
    )
    .bind(subscription.id)
    .all();

  const stateCache = new Map();
  for (const message of result.results || []) {
    const claim = await db
      .prepare("UPDATE push_messages SET delivered_at = ?1 WHERE id = ?2 AND delivered_at IS NULL")
      .bind(deliveredAt, message.id)
      .run();
    // Inny, równoległy push był szybszy — ta wiadomość jest już jego.
    // (Gdyby baza nie zwróciła licznika zmian, zachowujemy się jak dawniej.)
    const changes = claim?.meta?.changes;
    if (typeof changes === "number" && changes < 1) {
      continue;
    }

    // Przypomnienie mogło zostać wysłane tuż przed ukończeniem zadania albo
    // „nie ma potrzeby”. Takie przejmujemy po cichu i bierzemy następną.
    // Gdy sprawdzenie się nie uda, pokazujemy wiadomość jak jest.
    let stale = false;
    try {
      stale = await isStaleMessage(db, message, stateCache);
    } catch (_error) {
      stale = false;
    }
    if (stale) {
      continue;
    }

    return json({
      messages: [
        {
          id: message.id,
          title: message.title,
          body: message.body,
          url: message.url,
          tag: message.tag,
          taskId: message.task_id,
          kind: message.kind,
          createdAt: message.created_at
        }
      ]
    });
  }

  return json({ messages: [] });
}

// Okrojona kopia domu (slim_value) trzyma tylko otwarte zadania, więc brak
// zadania w niej = zadanie zamknięte albo usunięte. Czytamy ją zamiast pełnego
// zapisu, bo ten ma setki kB i jego parsowanie zjada limit procesora.
async function isStaleMessage(db, message, stateCache) {
  if (!message.task_id || !message.household_id) {
    return false;
  }

  if (!stateCache.has(message.household_id)) {
    let row = null;
    try {
      row = await db
        .prepare("SELECT COALESCE(slim_value, value) AS value FROM households WHERE id = ?1")
        .bind(message.household_id)
        .first();
    } catch (_error) {
      row = await db.prepare("SELECT value FROM households WHERE id = ?1").bind(message.household_id).first();
    }
    stateCache.set(message.household_id, row ? JSON.parse(row.value) : null);
  }

  const state = stateCache.get(message.household_id);
  if (!state) {
    return false;
  }
  const task = (state.tasks || []).find((item) => item.id === message.task_id);
  return !task || task.status !== "open";
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
        error TEXT,
        attempts INTEGER DEFAULT 0
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
