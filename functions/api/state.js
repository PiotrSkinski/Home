const API_USER_HEADER = "x-household-user";
const API_HOUSEHOLD_HEADER = "x-household-id";
const API_PIN_HEADER = "x-household-pin";

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

  const state = parseState(row.value);
  const auth = authorizeByState(request, state);
  if (!auth.ok) {
    return json({ error: auth.error }, auth.status);
  }

  return json({ state, updatedAt: row.updated_at });
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

  const existingState = parseState(existingRow.value);
  const auth = authorizeByState(request, existingState);
  if (!auth.ok) {
    return json({ error: auth.error }, auth.status);
  }

  const nextState = await request.json();
  const validation = validateHouseholdState(nextState);
  if (!validation.ok) {
    return json({ error: validation.error }, 400);
  }

  if (nextState.household.id !== householdId) {
    return json({ error: "Identyfikator domu nie pasuje do zapisu." }, 400);
  }

  const updatedAt = new Date().toISOString();
  await db
    .prepare(
      `UPDATE households
       SET name = ?1, invite_code = ?2, value = ?3, updated_at = ?4
       WHERE id = ?5`
    )
    .bind(nextState.household.name, nextState.household.inviteCode, JSON.stringify(nextState), updatedAt, householdId)
    .run();

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
}

async function getHouseholdRow(db, householdId) {
  return db
    .prepare("SELECT value, updated_at FROM households WHERE id = ?1")
    .bind(householdId)
    .first();
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
