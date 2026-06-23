const CACHE_NAME = "homejob-v25";
const ASSETS = [
  "./",
  "./index.html",
  "./styles.css?v=25",
  "./app.js?v=25",
  "./manifest.webmanifest?v=25",
  "./icon.svg"
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

  if (!messages.length) {
    await self.registration.showNotification("HomeJob", {
      body: "Masz zadania do sprawdzenia.",
      tag: "homejob-fallback",
      icon: "./icon.svg",
      badge: "./icon.svg",
      data: { url: "./index.html" }
    });
    return;
  }

  for (const message of messages) {
    await self.registration.showNotification(message.title || "HomeJob", {
      body: message.body || "Masz zadania do sprawdzenia.",
      tag: message.tag || message.id || "homejob",
      renotify: true,
      icon: "./icon.svg",
      badge: "./icon.svg",
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
      return [];
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
      return [];
    }

    const payload = await response.json();
    return Array.isArray(payload.messages) ? payload.messages : [];
  } catch (error) {
    return [];
  }
}
