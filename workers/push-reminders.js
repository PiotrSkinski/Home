const DAILY_DIGEST_TIME = "08:00";
const EVENING_REMINDER_TIME = "22:00";
const DAILY_DIGEST_WINDOW_MINUTES = 180;
const TASK_REMINDER_WINDOW_MINUTES = 90;
const EVENING_REMINDER_WINDOW_MINUTES = 120;
const TIME_ZONE = "Europe/Warsaw";
const MAX_SEND_ATTEMPTS = 3;
const DEAD_SUBSCRIPTION_THRESHOLD = 8;
const DEFAULT_VAPID_SUBJECT = "mailto:homejob@example.com";

export default {
  async fetch() {
    return new Response("HomeJob push reminders worker");
  },

  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(runReminderJob(env));
  }
};

async function runReminderJob(env) {
  if (!env.DB || !env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY) {
    console.warn("Missing DB or VAPID configuration.");
    return;
  }

  await ensurePushSchema(env.DB);

  const now = new Date();
  const households = await env.DB.prepare("SELECT id, value FROM households").all();

  for (const row of households.results || []) {
    const state = safeParseState(row.value);
    // Kiedyś dom bez zadań był pomijany w całości — razem z powiadomieniami
    // o nagrodach i premii domowej, które z zadaniami nie mają nic wspólnego.
    if (!state?.users?.length) {
      continue;
    }

    // Doba domu może zaczynać się później niż o północy (ustawienia aplikacji).
    // Bez tego worker i aplikacja rozjeżdżały się o jeden dzień.
    const localNow = getLocalDateTime(now, Number(state.household?.dayStart) || 0);
    const householdId = state.household?.id || row.id;
    if (isHouseholdPaused(state, localNow.date)) {
      continue;
    }
    // Zadanie z wnioskiem w głosowaniu czeka na decyzję domu — przypomnienia
    // o nim milkną, dopóki nie wiadomo, czy zostaje w dzisiejszym terminie.
    const votedOnTaskIds = new Set(
      (state.taskRequests || []).filter((request) => request?.status === "pending").map((request) => request.taskId)
    );
    const openTasks = (state.tasks || []).filter((task) => task.status === "open" && !votedOnTaskIds.has(task.id));

    if (isWithinTimeWindow(localNow.minutes, timeToMinutes(DAILY_DIGEST_TIME), DAILY_DIGEST_WINDOW_MINUTES)) {
      await sendDailyDigest(env, householdId, state, openTasks, localNow);
    }

    await sendTaskReminders(env, householdId, state, openTasks, localNow);

    if (isWithinTimeWindow(localNow.minutes, timeToMinutes(EVENING_REMINDER_TIME), EVENING_REMINDER_WINDOW_MINUTES)) {
      await sendEveningReminder(env, householdId, state, openTasks, localNow);
    }

    await sendHouseholdNotices(env, householdId, state);
  }
}

// Przełączniki powiadomień ustawiane w aplikacji (user.pushPrefs).
// Brak zapisu = włączone, żeby nowy rodzaj nie milczał po cichu.
function chcePowiadomienie(state, userId, kind) {
  const user = (state.users || []).find((u) => u.id === userId);
  return user?.pushPrefs?.[kind] !== false;
}

function taskAssignees(task) {
  if (Array.isArray(task.assigneeIds) && task.assigneeIds.length) {
    return task.assigneeIds;
  }
  return task.assigneeId ? [task.assigneeId] : [];
}

function isHouseholdPaused(state, todayIso) {
  const pause = state.household?.pause;
  return Boolean(pause && pause.from && pause.until && todayIso >= pause.from && todayIso <= pause.until);
}

// Nieobecny domownik nie dostaje pushy — tak samo jak w aplikacji.
function isUserAbsent(state, userId, todayIso) {
  const user = (state.users || []).find((item) => item.id === userId);
  const absence = user?.absence;
  return Boolean(absence && absence.from && absence.until && todayIso >= absence.from && todayIso <= absence.until);
}

// Poranny przegląd zbiera też zaległości. Wcześniej każde zaległe zadanie
// wysyłało własne przypomnienie codziennie o swojej godzinie — przy kilku
// zaległościach telefon dzwonił kilka razy dziennie w kółko.
async function sendDailyDigest(env, householdId, state, openTasks, localNow) {
  for (const user of state.users) {
    if (isUserAbsent(state, user.id, localNow.date)) {
      continue;
    }
    const mine = openTasks.filter((task) => taskAssignees(task).includes(user.id));
    const today = mine.filter((task) => task.dueDate === localNow.date);
    const overdue = mine.filter((task) => task.dueDate < localNow.date);

    if (!today.length && !overdue.length) {
      continue;
    }

    const parts = [];
    if (today.length) {
      parts.push(
        `${user.name}, dziś masz ${today.length} ${
          today.length === 1 ? "zadanie" : today.length < 5 ? "zadania" : "zadań"
        }:\n${formatTaskList(today)}`
      );
    } else {
      parts.push(`${user.name}, na dziś nic nie zaplanowano.`);
    }

    if (overdue.length) {
      parts.push(`Zaległe (${overdue.length}):\n${formatTaskList(overdue)}`);
    }

    if (!chcePowiadomienie(state, user.id, "daily")) {
      continue;
    }
    await pushToUser(env, householdId, user.id, {
      kind: "daily",
      dedupeKey: `${householdId}:${user.id}:daily:${localNow.date}`,
      title: today.length ? "Plan dnia w HomeJob" : "Zaległe zadania",
      body: parts.join("\n\n"),
      url: "./index.html",
      tag: `homejob-daily-${localNow.date}`,
      taskId: null
    });
  }
}

// Osobne przypomnienie dostają wyłącznie zadania na dziś. Zaległe idą raz
// dziennie w porannym przeglądzie.
async function sendTaskReminders(env, householdId, state, openTasks, localNow) {
  const dueTasks = openTasks.filter(
    (task) =>
      task.dueDate === localNow.date &&
      isWithinTimeWindow(localNow.minutes, timeToMinutes(task.reminderTime), TASK_REMINDER_WINDOW_MINUTES)
  );

  for (const task of dueTasks) {
    for (const assigneeId of taskAssignees(task)) {
      if (isUserAbsent(state, assigneeId, localNow.date)) {
        continue;
      }
      // Zadanie po terminie to „zaległe", nie „na godzinę" — osobny przełącznik.
      const rodzaj = task.dueDate < localNow.date ? "overdue" : "taskTime";
      if (!chcePowiadomienie(state, assigneeId, rodzaj)) {
        continue;
      }
      await pushToUser(env, householdId, assigneeId, {
        kind: "task",
        dedupeKey: `${householdId}:${assigneeId}:task:${task.id}:${localNow.date}:${task.reminderTime}`,
        title: "Czas na zadanie",
        body: `Masz zadanie do wykonania: ${task.title}`,
        url: `./index.html?task=${encodeURIComponent(task.id)}`,
        tag: `homejob-task-${task.id}-${localNow.date}`,
        taskId: task.id
      });
    }
  }
}

async function sendEveningReminder(env, householdId, state, openTasks, localNow) {
  for (const user of state.users) {
    if (isUserAbsent(state, user.id, localNow.date)) {
      continue;
    }
    const tasks = openTasks.filter((task) => taskAssignees(task).includes(user.id) && task.dueDate === localNow.date);
    if (!tasks.length) {
      continue;
    }

    if (!chcePowiadomienie(state, user.id, "evening")) {
      continue;
    }
    await pushToUser(env, householdId, user.id, {
      kind: "evening",
      dedupeKey: `${householdId}:${user.id}:evening:${localNow.date}`,
      title: "Niewykonane zadania",
      body: `Masz niewykonane zadania z dzisiaj!\n${formatTaskList(tasks)}`,
      url: "./index.html",
      tag: `homejob-evening-${localNow.date}`,
      taskId: null
    });
  }
}

// Wnioski o przełożenie i „nie ma potrzeby” muszą dojść do domowników od razu,
// a nie dopiero przy otwarciu aplikacji. Aplikacja oznacza takie wpisy flagą
// push, a każdy leci dokładnie raz (klucz dedupe = identyfikator wpisu).
async function sendHouseholdNotices(env, householdId, state) {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;

  for (const notice of state.notifications || []) {
    if (!notice?.push || !notice.recipientUserId || notice.read) {
      continue;
    }

    const createdAt = Date.parse(notice.createdAt || "");
    if (!Number.isFinite(createdAt) || createdAt < cutoff) {
      continue;
    }

    // Klient już uwzględnia przełączniki przy ustawianiu flagi push, ale
    // preferencja mogła się zmienić po utworzeniu powiadomienia.
    const rodzaj = notice.kind === "reward" || notice.kind === "bonus" ? "rewards" : notice.kind;
    if (rodzaj && !chcePowiadomienie(state, notice.recipientUserId, rodzaj)) {
      continue;
    }

    await pushToUser(env, householdId, notice.recipientUserId, {
      kind: "notice",
      dedupeKey: `${householdId}:${notice.recipientUserId}:notice:${notice.id}`,
      title: notice.title || "HomeJob",
      body: notice.body || "Sprawdź zadania w HomeJob.",
      url: notice.taskId ? `./index.html?task=${encodeURIComponent(notice.taskId)}` : "./index.html",
      tag: `homejob-notice-${notice.id}`,
      // Bez task_id, żeby filtr „nieaktualnych” nie skasował decyzji o zadaniu,
      // które właśnie przestało być otwarte.
      taskId: null
    });
  }
}

async function pushToUser(env, householdId, userId, message) {
  const subscriptions = await env.DB
    .prepare("SELECT * FROM push_subscriptions WHERE household_id = ?1 AND user_id = ?2")
    .bind(householdId, userId)
    .all();

  for (const subscription of subscriptions.results || []) {
    if (await isSubscriptionDead(env.DB, subscription.id)) {
      await env.DB.prepare("DELETE FROM push_subscriptions WHERE id = ?1").bind(subscription.id).run();
      continue;
    }
    await createMessageAndSendPush(env, subscription, householdId, userId, message);
  }
}

// Usunięcie aplikacji z ekranu głównego kasuje subskrypcję po stronie telefonu,
// ale usługa push nadal przyjmuje wysyłki na stary adres — sent_at wygląda
// wtedy na sukces, choć nic nie dociera. Telefon, który odbiera, zawsze wraca
// po treść do /api/push-payload i ustawia delivered_at. Adres, pod który
// wysłano wiele wiadomości i żadna nie została odebrana, jest martwy.
async function isSubscriptionDead(db, subscriptionId) {
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS ile FROM push_messages
       WHERE subscription_id = ?1 AND sent_at IS NOT NULL AND delivered_at IS NULL AND sent_at < ?2`
    )
    .bind(subscriptionId, cutoff)
    .first();
  return Number(row?.ile || 0) >= DEAD_SUBSCRIPTION_THRESHOLD;
}

async function createMessageAndSendPush(env, subscription, householdId, userId, message) {
  const dedupeKey = `${subscription.id}:${message.dedupeKey}`;
  const id = `msg_${await sha256(dedupeKey)}`;
  const existing = await env.DB
    .prepare("SELECT * FROM push_messages WHERE dedupe_key = ?1")
    .bind(dedupeKey)
    .first();

  if (existing?.sent_at) {
    return;
  }

  // Nieudana wysyłka wracała co minutę przez całe okno przypomnienia. Jeśli
  // usługa push mimo błędu dostarczała powiadomienie, telefon dostawał je
  // kilkadziesiąt razy — stąd twardy limit prób.
  if (Number(existing?.attempts || 0) >= MAX_SEND_ATTEMPTS) {
    return;
  }

  if (!existing) {
    const now = new Date().toISOString();
    await env.DB
      .prepare(
        `INSERT INTO push_messages
         (id, subscription_id, household_id, user_id, task_id, kind, dedupe_key, title, body, url, tag, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)`
      )
      .bind(
        id,
        subscription.id,
        householdId,
        userId,
        message.taskId,
        message.kind,
        dedupeKey,
        message.title,
        message.body,
        message.url,
        message.tag,
        now
      )
      .run();
  }

  await bumpAttempts(env.DB, existing?.id || id);

  try {
    const result = await sendWebPush(env, subscription.endpoint);
    await env.DB
      .prepare("UPDATE push_messages SET sent_at = ?1, error = NULL WHERE id = ?2")
      .bind(new Date().toISOString(), existing?.id || id)
      .run();

    if (result.status === 404 || result.status === 410) {
      await env.DB.prepare("DELETE FROM push_subscriptions WHERE id = ?1").bind(subscription.id).run();
    }
  } catch (error) {
    await env.DB
      .prepare("UPDATE push_messages SET error = ?1 WHERE id = ?2")
      .bind(String(error?.message || error), existing?.id || id)
      .run();
  }
}

async function bumpAttempts(db, id) {
  try {
    await db
      .prepare("UPDATE push_messages SET attempts = COALESCE(attempts, 0) + 1 WHERE id = ?1")
      .bind(id)
      .run();
  } catch (_error) {
    // Starsza baza bez kolumny attempts: limit prób po prostu nie działa.
  }
}

async function sendWebPush(env, endpoint) {
  const audience = new URL(endpoint).origin;
  const jwt = await createVapidJwt(env, audience);

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      TTL: "300",
      Urgency: "normal",
      Authorization: `vapid t=${jwt}, k=${env.VAPID_PUBLIC_KEY}`
    }
  });

  if (!response.ok && response.status !== 404 && response.status !== 410) {
    throw new Error(`Push service responded with ${response.status}`);
  }

  return response;
}

async function createVapidJwt(env, audience) {
  const header = base64UrlString(JSON.stringify({ typ: "JWT", alg: "ES256" }));
  const payload = base64UrlString(
    JSON.stringify({
      aud: audience,
      exp: Math.floor(Date.now() / 1000) + 12 * 60 * 60,
      sub: env.VAPID_SUBJECT || DEFAULT_VAPID_SUBJECT
    })
  );
  const unsignedToken = `${header}.${payload}`;
  const key = await importVapidPrivateKey(env);
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    new TextEncoder().encode(unsignedToken)
  );

  return `${unsignedToken}.${base64Url(new Uint8Array(signature))}`;
}

async function importVapidPrivateKey(env) {
  const publicBytes = base64UrlToBytes(env.VAPID_PUBLIC_KEY);
  if (publicBytes[0] !== 4 || publicBytes.length !== 65) {
    throw new Error("Nieprawidłowy publiczny klucz VAPID.");
  }

  const jwk = {
    kty: "EC",
    crv: "P-256",
    x: base64Url(publicBytes.slice(1, 33)),
    y: base64Url(publicBytes.slice(33, 65)),
    d: env.VAPID_PRIVATE_KEY,
    ext: false,
    key_ops: ["sign"]
  };

  return crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
}

function getLocalDateTime(date, dayStartHour = 0) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).formatToParts(date);
  const value = Object.fromEntries(parts.filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));

  const godzina = Number(value.hour);
  let dzien = `${value.year}-${value.month}-${value.day}`;

  // Przed startem doby wciąż trwa dzień poprzedni — tak samo liczy to aplikacja.
  if (dayStartHour > 0 && godzina < dayStartHour) {
    const d = new Date(`${dzien}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() - 1);
    dzien = d.toISOString().slice(0, 10);
  }

  return {
    date: dzien,
    time: `${value.hour}:${value.minute}`,
    minutes: godzina * 60 + Number(value.minute)
  };
}

function timeToMinutes(time) {
  const [hour, minute] = String(time || "").split(":").map(Number);
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) {
    return null;
  }

  return hour * 60 + minute;
}

function isWithinTimeWindow(currentMinutes, targetMinutes, windowMinutes) {
  if (!Number.isFinite(currentMinutes) || !Number.isFinite(targetMinutes)) {
    return false;
  }

  return currentMinutes >= targetMinutes && currentMinutes < targetMinutes + windowMinutes;
}

function formatTaskList(tasks) {
  const visible = tasks.slice(0, 5).map((task) => `- ${task.title}`);
  const rest = tasks.length - visible.length;
  return `${visible.join("\n")}${rest > 0 ? `\n+${rest} więcej` : ""}`;
}

function safeParseState(value) {
  try {
    return JSON.parse(value);
  } catch (_error) {
    return null;
  }
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

  try {
    await db.prepare("ALTER TABLE push_messages ADD COLUMN attempts INTEGER DEFAULT 0").run();
  } catch (_error) {
    // Kolumna już istnieje — tak wygląda ta migracja przy każdym kolejnym uruchomieniu.
  }

  await db
    .prepare(
      `CREATE INDEX IF NOT EXISTS idx_push_messages_delivery
       ON push_messages (subscription_id, delivered_at, created_at)`
    )
    .run();
}

async function sha256(value) {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return base64Url(new Uint8Array(hash)).slice(0, 32);
}

function base64UrlString(value) {
  return base64Url(new TextEncoder().encode(value));
}

function base64Url(bytes) {
  let binary = "";
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlToBytes(value) {
  const padding = "=".repeat((4 - (value.length % 4)) % 4);
  const base64 = `${value}${padding}`.replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  const output = new Uint8Array(raw.length);

  for (let index = 0; index < raw.length; index += 1) {
    output[index] = raw.charCodeAt(index);
  }

  return output;
}
