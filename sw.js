const CACHE_NAME = "homejob-v63";
const ASSETS = [
  "./",
  "./index.html",
  "./styles.css?v=63",
  "./app.js?v=63",
  "./manifest.webmanifest?v=63",
  "./icon.svg",
  "./icon-180.png?v=63",
  "./icon-192.png?v=63",
  "./icon-512.png?v=63"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)))
      )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") {
    return;
  }

  const requestUrl = new URL(event.request.url);

  if (requestUrl.pathname.startsWith("/api/")) {
    event.respondWith(fetch(event.request));
    return;
  }

  event.respondWith(
    fetch(event.request)
      .then((response) => {
        const copy = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});

self.addEventListener("push", (event) => {
  event.waitUntil(showPushNotifications());
});

// iOS potrafi unieważnić subskrypcję sam z siebie. Bez tego serwer trzymał
// martwy adres i wysyłał w pustkę — usługa push przyjmowała żądanie, a telefon
// nie dostawał niczego.
self.addEventListener("pushsubscriptionchange", (event) => {
  event.waitUntil(odnowSubskrypcje(event));
});

async function odnowSubskrypcje(event) {
  try {
    const stara = event.oldSubscription || (await self.registration.pushManager.getSubscription());
    const klucz = event.newSubscription?.options?.applicationServerKey || stara?.options?.applicationServerKey;
    const nowa =
      event.newSubscription ||
      (await self.registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: klucz
      }));

    await fetch(new URL("./api/push-subscription", self.registration.scope), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ subscription: nowa.toJSON(), previousEndpoint: stara?.endpoint || null })
    });
  } catch (error) {
    // Nic więcej nie zrobimy — aplikacja odświeży subskrypcję przy starcie.
  }
}

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const targetUrl = new URL(event.notification.data?.url || "./index.html", self.registration.scope).href;

  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
      const client = clients.find((item) => "focus" in item);
      if (client) {
        return client.navigate ? client.navigate(targetUrl).then((item) => (item || client).focus()) : client.focus();
      }
      return self.clients.openWindow(targetUrl);
    })
  );
});

async function showPushNotifications() {
  const messages = await getPendingPushMessages();

  // null = the payload could not be fetched, so fall back to a generic nudge.
  // An empty list means the server had nothing to show (e.g. the task was
  // already completed or marked "nie ma potrzeby") — stay silent then.
  if (messages === null) {
    await self.registration.showNotification("HomeJob", {
      body: "Masz zadania do sprawdzenia.",
      tag: "homejob-fallback",
      icon: "./icon-192.png?v=63",
      badge: "./icon-192.png?v=63",
      data: { url: "./index.html" }
    });
    return;
  }

  for (const message of messages) {
    await self.registration.showNotification(message.title || "HomeJob", {
      body: message.body || "Masz zadania do sprawdzenia.",
      tag: message.tag || message.id || "homejob",
      renotify: true,
      icon: "./icon-192.png?v=63",
      badge: "./icon-192.png?v=63",
      data: {
        url: message.url || "./index.html",
        taskId: message.taskId || null
      }
    });
  }
}

async function getPendingPushMessages() {
  try {
    const subscription = await self.registration.pushManager.getSubscription();
    if (!subscription) {
      return null;
    }

    const response = await fetch(new URL("./api/push-payload", self.registration.scope), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json"
      },
      body: JSON.stringify({ endpoint: subscription.endpoint })
    });

    if (!response.ok) {
      return null;
    }

    const payload = await response.json();
    return Array.isArray(payload.messages) ? payload.messages : null;
  } catch (error) {
    return null;
  }
}
