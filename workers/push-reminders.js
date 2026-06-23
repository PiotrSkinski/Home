const DAILY_DIGEST_TIME = "08:00";
const TIME_ZONE = "Europe/Warsaw";
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
  const localNow = getLocalDateTime(now);
  const households = await env.DB.prepare("SELECT id, value FROM households").all();

  for (const row of households.results || []) {
    const state = safeParseState(row.value);
    if (!state?.users?.length || !state?.tasks?.length) {
      continue;
    }

    const householdId = state.household?.id || row.id;
    const openTasks = state.tasks.filter((task) => task.status !== "done");

    if (localNow.time === DAILY_DIGEST_TIME) {
      await sendDailyDigest(env, householdId, state, openTasks, localNow);
    }

    await sendTaskReminders(env, householdId, state, openTasks, localNow);
  }
}

async function sendDailyDigest(env, householdId, state, openTasks, localNow) {
  for (const user of state.users) {
    const tasks = openTasks.filter((task) => task.assigneeId === user.id && task.dueDate === localNow.date);
    if (!tasks.length) {
      continue;
    }

    const body = `${user.name}, dziś masz ${tasks.length} ${
      tasks.length === 1 ? "zadanie" : tasks.length < 5 ? "zadania" : "zadań"
    }:\n${formatTaskList(tasks)}`;

    await pushToUser(env, householdId, user.id, {
      kind: "daily",
      dedupeKey: `${householdId}:${user.id}:daily:${localNow.date}`,
      title: "Plan dnia w HomeJob",
      body,
      url: "./index.html",
      tag: `homejob-daily-${localNow.date}`,
      taskId: null
    });
  }
}

async function sendTaskReminders(env, householdId, state, openTasks, localNow) {
  const dueTasks = openTasks.filter(
    (task) => task.reminderTime === localNow.time && task.dueDate <= localNow.date
  );

  for (const task of dueTasks) {
    const isOverdue = task.dueDate < localNow.date;
    await pushToUser(env, householdId, task.assigneeId, {
      kind: "task",
      dedupeKey: `${householdId}:${task.assigneeId}:task:${task.id}:${localNow.date}:${task.reminderTime}`,
      title: isOverdue ? "Zaległe zadanie" : "Czas na zadanie",
      body: isOverdue
        ? `To nadal czeka: ${task.title}`
        : `Masz zadanie do wykonania: ${task.title}`,
      url: `./index.html?task=${encodeURIComponent(task.id)}`,
      tag: `homejob-task-${task.id}-${localNow.date}`,
      taskId: task.id
    });
  }
}

async function pushToUser(env, householdId, userId, message) {
  const subscriptions = await env.DB
    .prepare("SELECT * FROM push_subscriptions WHERE household_id = ?1 AND user_id = ?2")
    .bind(householdId, userId)
    .all();

  for (const subscription of subscriptions.results || []) {
    await createMessageAndSendPush(env, subscription, householdId, userId, message);
  }
}

async function createMessageAndSendPush(env, subscription, householdId, userId, message) {
  const dedupeKey = `${subscription.id}:${message.dedupeKey}`;
  const id = `msg_${await sha256(dedupeKey)}`;
  const existing = await env.DB
    .prepare("SELECT id, sent_at FROM push_messages WHERE dedupe_key = ?1")
    .bind(dedupeKey)
    .first();

  if (existing?.sent_at) {
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

function getLocalDateTime(date) {
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

  return {
    date: `${value.year}-${value.month}-${value.day}`,
    time: `${value.hour}:${value.minute}`
  };
}

function formatTaskList(tasks) {
  const visible = tasks.slice(0, 5).map((task) => `• ${task.title}`);
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
