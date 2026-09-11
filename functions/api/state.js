const API_USER_HEADER = "x-household-user";
const API_HOUSEHOLD_HEADER = "x-household-id";
const API_PIN_HEADER = "x-household-pin";
const API_BASE_UPDATED_AT_HEADER = "x-base-updated-at";

const responseHeaders = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store"
};

export async function onRequestGet({ request, env }) {
  const db = getDatabase(env);
  await ensureSchema(db);

  const householdId = getHouseholdId(request);
  if (!householdId) {
    return json({ state: null, updatedAt: null });
  }

  const row = await getHouseholdRow(db, householdId);
  if (!row) {
    return json({ error: "Nie znaleziono domu." }, 404);
  }

  const auth = authorizeByState(request, stanDoAutoryzacji(row));
  if (!auth.ok) {
    return json({ error: auth.error }, auth.status);
  }

  // Każdy otwarty telefon pyta o to co minutę. Wcześniej cały zapis był
  // parsowany (tylko po to, żeby sprawdzić PIN) i od nowa zamieniany w tekst.
  return rawJson(`{"state":${row.value},"updatedAt":${JSON.stringify(row.updated_at)}}`);
}

export async function onRequestPost({ request, env }) {
  const db = getDatabase(env);
  await ensureSchema(db);

  const body = await request.json();

  if (body?.action === "create-household") {
    return createHousehold(db, body.state);
  }

  if (body?.action === "join-household") {
    return joinHousehold(db, body);
  }

  return json({ error: "Nieznana akcja." }, 400);
}

export async function onRequestPut({ request, env }) {
  const db = getDatabase(env);
  await ensureSchema(db);

  const householdId = getHouseholdId(request);
  if (!householdId) {
    return json({ error: "Brakuje identyfikatora domu." }, 400);
  }

  const existingRow = await getHouseholdRow(db, householdId);
  if (!existingRow) {
    return json({ error: "Nie znaleziono domu." }, 404);
  }

  const auth = authorizeByState(request, stanDoAutoryzacji(existingRow));
  if (!auth.ok) {
    return json({ error: auth.error }, auth.status);
  }

  // Zapisujemy tekst tak, jak przyszedł: wcześniej był parsowany i od nowa
  // zamieniany w tekst — jedno pełne przejście za dużo przy każdym zapisie.
  const surowyStan = await request.text();
  let nextState;
  try {
    nextState = JSON.parse(surowyStan);
  } catch (_error) {
    return json({ error: "Nieprawidłowy stan aplikacji." }, 400);
  }
  const validation = validateHouseholdState(nextState);
  if (!validation.ok) {
    return json({ error: validation.error }, 400);
  }

  if (nextState.household.id !== householdId) {
    return json({ error: "Identyfikator domu nie pasuje do zapisu." }, 400);
  }

  // Optimistic locking: the client declares which server revision its state is based
  // on. A write based on a stale revision (or none — legacy clients) must not silently
  // overwrite newer data saved by another device; the client gets the current state
  // back and merges instead.
  const baseUpdatedAt = request.headers.get(API_BASE_UPDATED_AT_HEADER);
  if (!baseUpdatedAt || baseUpdatedAt !== existingRow.updated_at) {
    return rawJson(
      `{"conflict":true,"state":${existingRow.value},"updatedAt":${JSON.stringify(existingRow.updated_at)}}`,
      409
    );
  }

  const updatedAt = new Date().toISOString();
  const result = slimDostepny
    ? await db
        .prepare(
          `UPDATE households
           SET name = ?1, invite_code = ?2, value = ?3, updated_at = ?4, slim_value = ?7
           WHERE id = ?5 AND updated_at = ?6`
        )
        .bind(
          nextState.household.name,
          nextState.household.inviteCode,
          surowyStan,
          updatedAt,
          householdId,
          baseUpdatedAt,
          JSON.stringify(buildSlim(nextState))
        )
        .run()
    : await db
        .prepare(
          `UPDATE households
           SET name = ?1, invite_code = ?2, value = ?3, updated_at = ?4
           WHERE id = ?5 AND updated_at = ?6`
        )
        .bind(nextState.household.name, nextState.household.inviteCode, surowyStan, updatedAt, householdId, baseUpdatedAt)
        .run();

  if (!result.meta.changes) {
    const currentRow = await getHouseholdRow(db, householdId);
    return rawJson(
      `{"conflict":true,"state":${currentRow.value},"updatedAt":${JSON.stringify(currentRow.updated_at)}}`,
      409
    );
  }

  return json({ ok: true, updatedAt });
}

export function onRequestOptions() {
  return new Response(null, { headers: responseHeaders });
}

async function createHousehold(db, state) {
  const validation = validateHouseholdState(state);
  if (!validation.ok) {
    return json({ error: validation.error }, 400);
  }

  const updatedAt = new Date().toISOString();

  try {
    await db
      .prepare(
        `INSERT INTO households (id, name, invite_code, value, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5)`
      )
      .bind(state.household.id, state.household.name, state.household.inviteCode, JSON.stringify(state), updatedAt)
      .run();
  } catch (error) {
    return json({ error: "Dom o takim kodzie już istnieje. Spróbuj ponownie." }, 409);
  }

  return json({ state, updatedAt }, 201);
}

async function joinHousehold(db, body) {
  const inviteCode = String(body?.inviteCode || "").trim().toUpperCase();
  const memberName = normalizeName(body?.memberName);
  const pin = normalizePin(body?.pin);

  if (!inviteCode || !memberName || pin.length !== 4) {
    return json({ error: "Brakuje kodu, imienia albo PIN-u." }, 400);
  }

  const row = await db
    .prepare("SELECT value, updated_at FROM households WHERE invite_code = ?1")
    .bind(inviteCode)
    .first();

  if (!row) {
    return json({ error: "Nie znaleziono domu." }, 404);
  }

  const state = parseState(row.value);
  const user = state.users.find((item) => normalizeName(item.name) === memberName && normalizePin(item.pin) === pin);

  if (!user) {
    return json({ error: "Nieprawidłowe imię albo PIN." }, 401);
  }

  return json({ state, userId: user.id, updatedAt: row.updated_at });
}

// Czy tabela ma kolumnę slim_value. Sprawdzane raz na izolat, żeby nie
// dokładać zapytania do każdego żądania.
let slimDostepny = null;

async function ensureSchema(db) {
  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS households (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        invite_code TEXT NOT NULL UNIQUE,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`
    )
    .run();

  if (slimDostepny !== null) {
    return;
  }
  slimDostepny = await maKolumneSlim(db);
  if (!slimDostepny) {
    try {
      await db.prepare("ALTER TABLE households ADD COLUMN slim_value TEXT").run();
    } catch (_error) {
      // Mógł ją właśnie dodać równoległy izolat — sprawdzamy jeszcze raz.
    }
    slimDostepny = await maKolumneSlim(db);
  }
}

async function maKolumneSlim(db) {
  try {
    await db.prepare("SELECT slim_value FROM households LIMIT 1").all();
    return true;
  } catch (_error) {
    return false;
  }
}

// Okrojona kopia zapisu domu: tylko to, czego potrzebuje sprawdzenie PIN-u
// i Worker od przypomnień. Pełny zapis to setki kB ukończonych zadań z
// historią — parsowanie go przy każdym żądaniu zjadało limit procesora.
function buildSlim(state) {
  const household = state.household || {};
  return {
    household: {
      id: household.id,
      name: household.name,
      inviteCode: household.inviteCode,
      pause: household.pause || null,
      dayStart: household.dayStart ?? null
    },
    users: (state.users || []).map((user) => ({
      id: user.id,
      name: user.name,
      pin: user.pin,
      absence: user.absence || null,
      pushPrefs: user.pushPrefs || {},
      pushTimes: user.pushTimes || {}
    })),
    tasks: (state.tasks || [])
      .filter((task) => task?.status === "open")
      .map((task) => ({
        id: task.id,
        title: task.title,
        status: task.status,
        dueDate: task.dueDate,
        reminderTime: task.reminderTime,
        assigneeId: task.assigneeId,
        assigneeIds: task.assigneeIds
      })),
    taskRequests: (state.taskRequests || [])
      .filter((request) => request?.status === "pending")
      .map((request) => ({ status: request.status, taskId: request.taskId })),
    notifications: (state.notifications || [])
      .filter((notice) => notice?.push && !notice.read)
      .map((notice) => ({
        id: notice.id,
        push: notice.push,
        read: notice.read,
        kind: notice.kind || null,
        recipientUserId: notice.recipientUserId,
        taskId: notice.taskId || null,
        title: notice.title,
        body: notice.body,
        createdAt: notice.createdAt
      }))
  };
}

// Do sprawdzenia PIN-u wystarczy okrojona kopia. Pełny zapis tylko wtedy,
// gdy kopii jeszcze nie ma (dom sprzed tej zmiany, do pierwszego zapisu).
function stanDoAutoryzacji(row) {
  if (row.slim_value) {
    try {
      return JSON.parse(row.slim_value);
    } catch (_error) {
      // uszkodzona kopia — spadamy do pełnego zapisu
    }
  }
  return parseState(row.value);
}

// Odpowiedź sklejona z tekstu leżącego w bazie — bez parsowania i ponownego
// zamieniania w tekst całego zapisu.
function rawJson(text, status = 200) {
  return new Response(text, { status, headers: responseHeaders });
}

async function getHouseholdRow(db, householdId) {
  const kolumny = slimDostepny ? "value, slim_value, updated_at" : "value, updated_at";
  return db.prepare(`SELECT ${kolumny} FROM households WHERE id = ?1`).bind(householdId).first();
}

function authorizeByState(request, state) {
  const householdId = getHouseholdId(request);
  const userId = request.headers.get(API_USER_HEADER);
  const pin = normalizePin(request.headers.get(API_PIN_HEADER));

  if (!householdId || householdId !== state.household.id) {
    return { ok: false, status: 401, error: "Nieprawidłowy dom." };
  }

  const user = state.users.find((item) => item.id === userId);

  if (user && normalizePin(user.pin) === pin) {
    return { ok: true };
  }

  return { ok: false, status: 401, error: "Nieprawidłowy PIN." };
}

function validateHouseholdState(state) {
  if (!state?.household?.id || !state?.household?.name || !state?.household?.inviteCode) {
    return { ok: false, error: "Brakuje danych domu." };
  }

  if (!Array.isArray(state.users) || !state.users.length) {
    return { ok: false, error: "Dom musi mieć przynajmniej jednego domownika." };
  }

  const invalidUser = state.users.find((user) => !user.id || !user.name || normalizePin(user.pin).length !== 4);
  if (invalidUser) {
    return { ok: false, error: "Każdy domownik musi mieć imię i 4-cyfrowy PIN." };
  }

  if (!Array.isArray(state.tasks) || !Array.isArray(state.pointEvents) || !Array.isArray(state.notifications)) {
    return { ok: false, error: "Nieprawidłowy stan aplikacji." };
  }

  return { ok: true };
}

function parseState(value) {
  return JSON.parse(value);
}

function getHouseholdId(request) {
  const url = new URL(request.url);
  return url.searchParams.get("householdId") || request.headers.get(API_HOUSEHOLD_HEADER);
}

function normalizePin(pin) {
  return String(pin || "").replace(/\D/g, "").slice(0, 4);
}

function normalizeName(name) {
  return String(name || "").trim().toLocaleLowerCase("pl-PL");
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
