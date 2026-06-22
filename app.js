(() => {
  const STORAGE_KEY = "homeJob.householdState.v1";
  const SESSION_KEY = "homeJob.session.v1";
  const KNOWN_HOUSEHOLDS_KEY = "homeJob.knownHouseholds.v1";
  const API_STATE_ENDPOINT = "/api/state";
  const API_USER_HEADER = "x-household-user";
  const API_HOUSEHOLD_HEADER = "x-household-id";
  const API_PIN_HEADER = "x-household-pin";
  const SYNC_DEBOUNCE_MS = 700;
  const REMINDER_REPEAT_MINUTES = 30;
  const COLORS = ["#1d766f", "#ef6f5e", "#4777c6", "#7561b5", "#b5792b", "#4a8f57"];
  const REWARD_THRESHOLDS = [
    { points: 200, label: "Nagroda" },
    { points: 350, label: "Duża nagroda" },
    { points: 500, label: "Super nagroda" }
  ];

  const PRIORITY = {
    high: { label: "Wysoki", points: 15, className: "high" },
    medium: { label: "Normalny", points: 10, className: "medium" },
    low: { label: "Lekki", points: 5, className: "low" }
  };

  const RECURRENCE = {
    none: "Jednorazowe",
    weekly: "Co tydzień",
    biweekly: "Co 2 tygodnie",
    monthly: "Co miesiąc",
    quarterly: "Co 3 miesiące",
    yearly: "Co rok"
  };

  const ROOM_OPTIONS = [
    "Cały dom",
    "Kuchnia",
    "Łazienka",
    "Salon",
    "Sypialnia",
    "Przedpokój",
    "Balkon",
    "Inne"
  ];

  const app = document.querySelector("#app");
  const toastRoot = document.querySelector("#toast-root");

  let knownHouseholds = loadKnownHouseholds();
  let onboardingMembers = [
    { id: uid("draft"), name: "", pin: "" },
    { id: uid("draft"), name: "", pin: "" }
  ];
  let session = loadSession();
  let state = applySession(loadState());
  let activeView = "dashboard";
  let activeFilter = "all";
  let searchQuery = "";
  let selectedTaskId = pickInitialTaskId();
  let selectedDate = toISO(new Date());
  let calendarCursor = startOfMonth(new Date());
  let activeModal = null;
  let notificationPanelOpen = false;
  let serviceWorkerRegistration = null;
  let remoteHydrationFinished = false;
  let remoteSaveTimer = null;
  let lastRemotePayload = "";

  registerServiceWorker();
  syncRewardClaims();
  render();
  hydrateRemoteState();
  runReminderSweep();
  setInterval(runReminderSweep, 30000);

  document.addEventListener("click", handleClick);
  document.addEventListener("change", handleChange);
  document.addEventListener("input", handleInput);
  document.addEventListener("submit", handleSubmit);

  function createSeedState() {
    return {
      household: {
        id: null,
        name: "HomeJob",
        inviteCode: ""
      },
      isAuthenticated: false,
      currentUserId: null,
      users: [],
      tasks: [],
      pointEvents: [],
      notifications: [],
      rewardClaims: [],
      createdAt: new Date().toISOString()
    };
  }

  function loadState() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const cachedState = normalizeState(JSON.parse(raw));
        if (cachedState.household.id) {
          return cachedState;
        }
      }
    } catch (error) {
      console.warn("Nie udało się odczytać danych aplikacji", error);
    }

    const nextState = createSeedState();
    persistLocalState(nextState);
    return nextState;
  }

  function loadSession() {
    try {
      const raw = localStorage.getItem(SESSION_KEY);
      const data = raw ? JSON.parse(raw) : null;

      if (data?.householdId && data?.userId && data?.pin) {
        return {
          householdId: String(data.householdId),
          userId: String(data.userId),
          pin: String(data.pin)
        };
      }
    } catch (error) {
      console.warn("Nie udalo sie odczytac sesji", error);
    }

    return null;
  }

  function saveSession(nextSession) {
    localStorage.setItem(SESSION_KEY, JSON.stringify(nextSession));
  }

  function clearSession() {
    session = null;
    localStorage.removeItem(SESSION_KEY);
  }

  function loadKnownHouseholds() {
    try {
      const raw = localStorage.getItem(KNOWN_HOUSEHOLDS_KEY);
      const data = raw ? JSON.parse(raw) : [];
      return Array.isArray(data) ? data : [];
    } catch (error) {
      console.warn("Nie udało się odczytać listy domów", error);
      return [];
    }
  }

  function saveKnownHouseholds() {
    localStorage.setItem(KNOWN_HOUSEHOLDS_KEY, JSON.stringify(knownHouseholds));
  }

  function rememberHousehold(nextState = state) {
    if (!nextState.household.id) {
      return;
    }

    const entry = {
      id: nextState.household.id,
      name: nextState.household.name,
      inviteCode: nextState.household.inviteCode,
      users: nextState.users.map((user) => ({
        id: user.id,
        name: user.name,
        avatar: user.avatar,
        color: user.color
      })),
      lastUserId: nextState.currentUserId || nextState.users[0]?.id || null
    };

    knownHouseholds = [entry, ...knownHouseholds.filter((item) => item.id !== entry.id)].slice(0, 12);
    saveKnownHouseholds();
  }

  function applySession(nextState) {
    const sessionUserExists =
      session &&
      nextState.household.id === session.householdId &&
      nextState.users.some((user) => user.id === session.userId);
    const fallbackUser = nextState.users[0];

    nextState.isAuthenticated = Boolean(sessionUserExists && session.pin);
    nextState.currentUserId = nextState.isAuthenticated
      ? session.userId
      : nextState.users.some((user) => user.id === nextState.currentUserId)
        ? nextState.currentUserId
        : fallbackUser?.id;

    return nextState;
  }

  function normalizeState(data) {
    const fallbackState = createSeedState();
    const nextState = {
      household: {
        id: data.household?.id || data.id || null,
        name: data.household?.name || data.name || "HomeJob",
        inviteCode: data.household?.inviteCode || data.inviteCode || ""
      },
      isAuthenticated: false,
      currentUserId: data.currentUserId,
      users: Array.isArray(data.users) ? data.users : fallbackState.users,
      tasks: Array.isArray(data.tasks) ? data.tasks : [],
      pointEvents: Array.isArray(data.pointEvents) ? data.pointEvents : [],
      notifications: Array.isArray(data.notifications) ? data.notifications : [],
      rewardClaims: Array.isArray(data.rewardClaims) ? data.rewardClaims : [],
      createdAt: data.createdAt || new Date().toISOString()
    };

    nextState.users = nextState.users.map((user) => {
      return {
        id: user.id || uid("user"),
        name: user.name || "Domownik",
        color: user.color || COLORS[0],
        avatar: user.avatar || (user.name || "D").slice(0, 1).toUpperCase(),
        pin: normalizePin(user.pin)
      };
    });

    nextState.currentUserId = nextState.users.some((user) => user.id === nextState.currentUserId)
      ? nextState.currentUserId
      : nextState.users[0]?.id || null;

    nextState.tasks = nextState.tasks.map((task) => {
      const recurrenceType = task.recurrence?.type === "seasonal" ? "quarterly" : task.recurrence?.type;

      return {
        id: task.id || uid("task"),
        title: task.title || "Zadanie",
        room: task.room || "Inne",
        assigneeId: task.assigneeId || nextState.users[0].id,
        createdById: task.createdById || nextState.users[0].id,
        dueDate: task.dueDate || toISO(new Date()),
        reminderTime: task.reminderTime || "18:00",
        assignedAt: task.assignedAt || task.createdAt || `${task.dueDate || toISO(new Date())}T12:00:00.000Z`,
        priority: PRIORITY[task.priority] ? task.priority : "medium",
        status: task.status === "done" ? "done" : "open",
        completedAt: task.completedAt || null,
        completedById: task.completedById || null,
        recurrence: {
          type: RECURRENCE[recurrenceType] ? recurrenceType : "none",
          rotate: Boolean(task.recurrence?.rotate)
        },
        points: Number.isFinite(Number(task.points)) ? Number(task.points) : PRIORITY[task.priority || "medium"].points,
        isRewardTask: Boolean(task.isRewardTask),
        rewardForUserId: task.rewardForUserId || null,
        rewardThreshold: Number(task.rewardThreshold) || null,
        comments: Array.isArray(task.comments) ? task.comments : [],
        history: Array.isArray(task.history) ? task.history : [],
        lastNotifiedAt: task.lastNotifiedAt || null
      };
    });

    return nextState;
  }

  function normalizePin(pin) {
    return String(pin || "").replace(/\D/g, "").slice(0, 4);
  }

  function saveState() {
    syncRewardClaims();
    persistLocalState(state);
    rememberHousehold(state);
    queueRemoteSave();
  }

  function persistLocalState(nextState) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(nextState));
  }

  function canUseRemoteApi() {
    return window.location.protocol === "https:";
  }

  function getAuthHeaders(nextSession = session) {
    return nextSession?.pin
      ? {
          [API_HOUSEHOLD_HEADER]: nextSession.householdId,
          [API_USER_HEADER]: nextSession.userId,
          [API_PIN_HEADER]: nextSession.pin
        }
      : {};
  }

  function getRemoteStatePayload() {
    return {
      household: state.household,
      users: state.users,
      tasks: state.tasks,
      pointEvents: state.pointEvents,
      notifications: state.notifications,
      rewardClaims: state.rewardClaims,
      createdAt: state.createdAt
    };
  }

  async function hydrateRemoteState() {
    if (!canUseRemoteApi() || !session?.pin) {
      remoteHydrationFinished = true;
      return;
    }

    try {
      const response = await fetch(`${API_STATE_ENDPOINT}?householdId=${encodeURIComponent(session.householdId)}`, {
        cache: "no-store",
        headers: {
          accept: "application/json",
          ...getAuthHeaders()
        }
      });

      if (!response.ok) {
        throw new Error(`API state responded with ${response.status}`);
      }

      const payload = await response.json();
      remoteHydrationFinished = true;

      if (!payload.state) {
        queueRemoteSave(100);
        return;
      }

      state = applySession(normalizeState(payload.state));
      lastRemotePayload = JSON.stringify(getRemoteStatePayload());
      const rewardClaimsChanged = syncRewardClaims();
      persistLocalState(state);
      rememberHousehold(state);

      if (!state.tasks.some((task) => task.id === selectedTaskId)) {
        selectedTaskId = pickInitialTaskId();
      }

      if (rewardClaimsChanged) {
        queueRemoteSave(100);
      }

      render();
    } catch (error) {
      remoteHydrationFinished = true;
      console.warn("Remote sync is unavailable", error);
    }
  }

  function queueRemoteSave(delay = SYNC_DEBOUNCE_MS) {
    if (!canUseRemoteApi() || !remoteHydrationFinished || !session?.pin) {
      return;
    }

    clearTimeout(remoteSaveTimer);
    remoteSaveTimer = setTimeout(syncRemoteState, delay);
  }

  async function syncRemoteState() {
    const payload = JSON.stringify(getRemoteStatePayload());

    if (payload === lastRemotePayload) {
      return;
    }

    try {
      const response = await fetch(`${API_STATE_ENDPOINT}?householdId=${encodeURIComponent(state.household.id)}`, {
        method: "PUT",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
          ...getAuthHeaders()
        },
        body: payload
      });

      if (!response.ok) {
        throw new Error(`API state responded with ${response.status}`);
      }

      lastRemotePayload = payload;
    } catch (error) {
      console.warn("Remote save failed", error);
    }
  }

  async function loginWithPin(householdId, userId, pin) {
    const cleanPin = String(pin || "").trim();
    const knownHousehold = knownHouseholds.find((item) => item.id === householdId);
    const user = state.users.find((item) => item.id === userId) || knownHousehold?.users?.find((item) => item.id === userId);
    const nextSession = { householdId, userId, pin: cleanPin };

    if (!householdId || !user || !cleanPin) {
      toast("Podaj PIN", "Wybierz dom, domownika i wpisz PIN.");
      return;
    }

    let remotePayload = null;

    if (canUseRemoteApi()) {
      try {
        const response = await fetch(`${API_STATE_ENDPOINT}?householdId=${encodeURIComponent(householdId)}`, {
          cache: "no-store",
          headers: {
            accept: "application/json",
            ...getAuthHeaders(nextSession)
          }
        });

        if (response.status === 401) {
          toast("Nieprawidłowy PIN", "Sprawdź PIN i spróbuj ponownie.");
          return;
        }

        if (response.status === 503) {
          toast("Dom nie jest gotowy", "Sprawdź konfigurację bazy w Cloudflare.");
          return;
        }

        if (!response.ok) {
          throw new Error(`API state responded with ${response.status}`);
        }

        remotePayload = await response.json();
      } catch (error) {
        console.warn("Login failed", error);
        toast("Nie udało się zalogować", "Sprawdź połączenie i spróbuj ponownie.");
        return;
      }
    }

    session = nextSession;
    saveSession(session);

    if (remotePayload?.state) {
      state = normalizeState(remotePayload.state);
    }

    state = applySession(state);
    persistLocalState(state);
    rememberHousehold(state);
    remoteHydrationFinished = true;
    lastRemotePayload = JSON.stringify(getRemoteStatePayload());
    activeModal = null;
    selectedTaskId = pickInitialTaskId();

    if (!remotePayload?.state) {
      queueRemoteSave(100);
    }

    toast("Zalogowano", user.name);
    render();
  }

  async function createHouseholdFromForm(form) {
    const data = new FormData(form);
    const name = String(data.get("householdName") || "").trim();
    const members = onboardingMembers
      .map((member) => ({
        name: String(member.name || "").trim(),
        pin: normalizePin(member.pin)
      }))
      .filter((member) => member.name && member.pin.length === 4);

    if (!name) {
      toast("Nazwij dom", "Podaj nazwę gospodarstwa.");
      return;
    }

    if (!members.length || members.length !== onboardingMembers.filter((member) => member.name.trim()).length) {
      toast("Uzupełnij domowników", "Każdy domownik musi mieć imię i 4-cyfrowy PIN.");
      return;
    }

    const householdState = normalizeState({
      household: {
        id: uid("home"),
        name,
        inviteCode: generateInviteCode()
      },
      currentUserId: null,
      users: members.map((member, index) => ({
        id: uid("user"),
        name: member.name,
        pin: member.pin,
        color: COLORS[index % COLORS.length],
        avatar: member.name.slice(0, 1).toUpperCase()
      })),
      tasks: [],
      pointEvents: [],
      notifications: [],
      rewardClaims: [],
      createdAt: new Date().toISOString()
    });

    const firstUser = householdState.users[0];
    const nextSession = {
      householdId: householdState.household.id,
      userId: firstUser.id,
      pin: firstUser.pin
    };

    if (canUseRemoteApi()) {
      try {
        const response = await fetch(API_STATE_ENDPOINT, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "application/json"
          },
          body: JSON.stringify({ action: "create-household", state: householdState })
        });

        if (!response.ok) {
          throw new Error(`API state responded with ${response.status}`);
        }
      } catch (error) {
        console.warn("Household creation failed", error);
        toast("Nie udało się utworzyć domu", "Sprawdź połączenie i spróbuj ponownie.");
        return;
      }
    }

    session = nextSession;
    saveSession(session);
    state = applySession(householdState);
    persistLocalState(state);
    rememberHousehold(state);
    remoteHydrationFinished = true;
    lastRemotePayload = JSON.stringify(getRemoteStatePayload());
    onboardingMembers = [
      { id: uid("draft"), name: "", pin: "" },
      { id: uid("draft"), name: "", pin: "" }
    ];
    toast("Dom utworzony", state.household.name);
    render();
  }

  async function joinHouseholdFromForm(form) {
    const data = new FormData(form);
    const inviteCode = String(data.get("inviteCode") || "").trim().toUpperCase();
    const memberName = String(data.get("memberName") || "").trim();
    const pin = normalizePin(data.get("pin"));

    if (!inviteCode || !memberName || pin.length !== 4) {
      toast("Uzupełnij dane", "Podaj kod domu, imię domownika i 4-cyfrowy PIN.");
      return;
    }

    if (!canUseRemoteApi()) {
      toast("Dołączanie działa online", "Ta opcja wymaga wersji z Cloudflare.");
      return;
    }

    try {
      const response = await fetch(API_STATE_ENDPOINT, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json"
        },
        body: JSON.stringify({ action: "join-household", inviteCode, memberName, pin })
      });

      if (response.status === 401 || response.status === 404) {
        toast("Nie znaleziono dostępu", "Sprawdź kod domu, imię i PIN.");
        return;
      }

      if (!response.ok) {
        throw new Error(`API state responded with ${response.status}`);
      }

      const payload = await response.json();
      state = normalizeState(payload.state);
      const user = state.users.find((item) => item.id === payload.userId);
      session = {
        householdId: state.household.id,
        userId: user.id,
        pin
      };
      saveSession(session);
      state = applySession(state);
      persistLocalState(state);
      rememberHousehold(state);
      remoteHydrationFinished = true;
      lastRemotePayload = JSON.stringify(getRemoteStatePayload());
      toast("Dołączono do domu", state.household.name);
      render();
    } catch (error) {
      console.warn("Joining household failed", error);
      toast("Nie udało się dołączyć", "Sprawdź połączenie i spróbuj ponownie.");
    }
  }

  function render() {
    const currentUser = getCurrentUser();

    if (!state.isAuthenticated) {
      app.innerHTML = renderLoggedOutScreen();
      return;
    }

    app.innerHTML = `
      <div class="app-shell">
        ${renderSidebar(currentUser)}
        <main class="main">
          ${renderTopbar(currentUser)}
          ${renderActiveView()}
        </main>
      </div>
      ${activeModal === "task" ? renderTaskModal() : ""}
      ${activeModal === "login" ? renderLoginModal() : ""}
      ${notificationPanelOpen ? renderNotificationPanel() : ""}
    `;
  }

  function renderSidebar(currentUser) {
    return `
      <aside class="sidebar">
        <section class="account-card">
          <div class="person-main">
            ${avatar(currentUser)}
            <div class="person-name">
              <strong>${escapeHtml(currentUser.name)}</strong>
              <span>Konto domownika</span>
            </div>
          </div>
          <button class="ghost-button" type="button" data-action="open-login-modal">Zmień konto</button>
          <button class="ghost-button" type="button" data-action="logout">Wyloguj</button>
        </section>

        <nav class="nav" aria-label="Nawigacja">
          ${navButton("dashboard", "⌂", "Dashboard")}
          ${navButton("tasks", "☰", "Lista")}
          ${navButton("calendar", "◱", "Kalendarz")}
          ${navButton("team", "◎", "Domownicy")}
          ${navButton("reminders", "◉", "Przypomnienia")}
          ${navButton("activity", "↺", "Aktywność")}
          ${navButton("rewards", "★", "Punkty")}
        </nav>

      </aside>
    `;
  }

  function navButton(id, icon, label) {
    const isActive = activeView === id || (id === "tasks" && activeView === "task-detail");
    return `
      <button class="nav-button ${isActive ? "is-active" : ""}" type="button" data-action="view" data-view="${id}">
        <span class="nav-icon" aria-hidden="true">${icon}</span>
        <span>${label}</span>
      </button>
    `;
  }

  function renderPersonRow(user) {
    return `
      <div class="person-row">
        <div class="person-main">
          ${avatar(user)}
          <div class="person-name">${escapeHtml(user.name)}</div>
        </div>
        <div class="person-points">${getUserPoints(user.id)} pkt</div>
      </div>
    `;
  }

  function renderTopbar(currentUser) {
    const unreadCount = getVisibleNotifications().filter((item) => !item.read).length;

    return `
      <header class="topbar">
        <div class="topbar-brand">
          <div class="brand-mark" aria-hidden="true">✓</div>
          <div>
            <h1 class="brand-title">HomeJob</h1>
            <p class="brand-subtitle">Wspólny rytm domu</p>
          </div>
          ${renderHouseholdBadge()}
        </div>
        <div class="topbar-actions">
          <button class="ghost-button" type="button" data-action="request-notifications">
            <span class="action-icon" aria-hidden="true">◉</span>
            <span>Powiadomienia</span>
          </button>
          <button class="icon-button" type="button" data-action="toggle-notifications" aria-label="Powiadomienia">
            <span aria-hidden="true">◉</span>
            ${unreadCount ? '<span class="badge-dot" aria-hidden="true"></span>' : ""}
          </button>
          <button class="ghost-button" type="button" data-action="open-login-modal">
            ${avatar(currentUser, "small")}
            <span>${escapeHtml(currentUser.name)}</span>
          </button>
          <button class="button" type="button" data-action="open-task-modal">
            <span class="action-icon" aria-hidden="true">＋</span>
            <span>Nowe zadanie</span>
          </button>
        </div>
      </header>
    `;
  }

  function renderHouseholdBadge() {
    return `
      <div class="household-badge">
        <strong>${escapeHtml(state.household.name)}</strong>
        <span>${state.users.length} ${state.users.length === 1 ? "domownik" : "domowników"} · ${escapeHtml(
          state.household.inviteCode
        )}</span>
      </div>
    `;
  }

  function renderLoggedOutScreen() {
    return `
      <main class="login-page">
        <section class="login-card onboarding-card">
          <div class="topbar-brand">
            <div class="brand-mark" aria-hidden="true">✓</div>
            <div>
              <h1 class="brand-title">HomeJob</h1>
              <p class="brand-subtitle">Wybierz dom albo utwórz nowe gospodarstwo</p>
            </div>
          </div>
          ${renderKnownHouseholds()}
          ${renderCreateHouseholdForm()}
          ${renderJoinHouseholdForm()}
        </section>
      </main>
    `;
  }

  function renderKnownHouseholds() {
    if (!knownHouseholds.length) {
      return "";
    }

    return `
      <section class="onboarding-section">
        <h2>Twoje domy</h2>
        <div class="known-house-list">
          ${knownHouseholds
            .map(
              (household) => `
                <form class="known-house-card" data-form="known-login">
                  <input type="hidden" name="householdId" value="${household.id}" />
                  <div>
                    <strong>${escapeHtml(household.name)}</strong>
                    <small>${household.users.length} ${household.users.length === 1 ? "domownik" : "domowników"}</small>
                  </div>
                  <label>
                    <span class="label">Domownik</span>
                    <select class="select" name="userId" required>
                      ${household.users
                        .map(
                          (user) => `
                            <option value="${user.id}" ${user.id === household.lastUserId ? "selected" : ""}>
                              ${escapeHtml(user.name)}
                            </option>
                          `
                        )
                        .join("")}
                    </select>
                  </label>
                  <label>
                    <span class="label">PIN</span>
                    <input class="input" name="pin" type="password" inputmode="numeric" maxlength="4" pattern="[0-9]{4}" required />
                  </label>
                  <button class="button" type="submit">Otwórz dom</button>
                </form>
              `
            )
            .join("")}
        </div>
      </section>
    `;
  }

  function renderCreateHouseholdForm() {
    return `
      <section class="onboarding-section">
        <h2>Utwórz dom</h2>
        <form class="house-create-form" data-form="create-household">
          <label>
            <span class="label">Nazwa domu</span>
            <input class="input" name="householdName" placeholder="Np. Mieszkanie" maxlength="40" required />
          </label>
          <div class="member-setup-list">
            ${onboardingMembers
              .map(
                (member, index) => `
                  <div class="member-setup-row">
                    <label>
                      <span class="label">Domownik ${index + 1}</span>
                      <input class="input" data-member-field="name" data-member-index="${index}" value="${escapeAttribute(
                        member.name
                      )}" placeholder="Imię" maxlength="28" required />
                    </label>
                    <label>
                      <span class="label">PIN</span>
                      <input class="input" data-member-field="pin" data-member-index="${index}" value="${escapeAttribute(
                        member.pin
                      )}" type="password" inputmode="numeric" maxlength="4" pattern="[0-9]{4}" placeholder="4 cyfry" required />
                    </label>
                    ${
                      onboardingMembers.length > 1
                        ? `<button class="icon-button" type="button" data-action="remove-member-row" data-member-index="${index}" aria-label="Usuń domownika">×</button>`
                        : ""
                    }
                  </div>
                `
              )
              .join("")}
          </div>
          <div class="form-actions split-actions">
            <button class="ghost-button" type="button" data-action="add-member-row">Dodaj domownika</button>
            <button class="button" type="submit">Stwórz dom</button>
          </div>
        </form>
      </section>
    `;
  }

  function renderJoinHouseholdForm() {
    return `
      <section class="onboarding-section">
        <h2>Dołącz kodem</h2>
        <form class="pin-login-form" data-form="join-household">
          <label>
            <span class="label">Kod domu</span>
            <input class="input" name="inviteCode" placeholder="Np. HOME-8K4P" maxlength="12" required />
          </label>
          <label>
            <span class="label">Imię domownika</span>
            <input class="input" name="memberName" maxlength="28" required />
          </label>
          <label>
            <span class="label">PIN</span>
            <input class="input" name="pin" type="password" inputmode="numeric" maxlength="4" pattern="[0-9]{4}" required />
          </label>
          <button class="button" type="submit">Dołącz</button>
        </form>
      </section>
    `;
  }

  function renderLoginForm() {
    return `
      <form class="pin-login-form" data-form="login">
        <input type="hidden" name="householdId" value="${state.household.id || ""}" />
        <label>
          <span class="label">Domownik</span>
          <select class="select" name="userId" required>
            ${state.users
              .map(
                (user) => `
                  <option value="${user.id}" ${user.id === state.currentUserId ? "selected" : ""}>
                    ${escapeHtml(user.name)} - ${getUserPoints(user.id)} pkt
                  </option>
                `
              )
              .join("")}
          </select>
        </label>
        <label>
          <span class="label">PIN</span>
          <input class="input" name="pin" type="password" inputmode="numeric" autocomplete="current-password" required />
        </label>
        <button class="button" type="submit">Zaloguj</button>
      </form>
    `;
  }

  function renderLoginModal() {
    return `
      <div class="modal-backdrop" role="presentation" data-action="close-modal">
        <section class="modal login-modal" role="dialog" aria-modal="true" aria-labelledby="login-modal-title">
          <div class="modal-head">
            <h2 class="modal-title" id="login-modal-title">Wybierz konto</h2>
            <button class="icon-button" type="button" data-action="close-modal" aria-label="Zamknij">×</button>
          </div>
          ${renderLoginForm()}
        </section>
      </div>
    `;
  }

  function renderActiveView() {
    if (activeView === "task-detail") {
      return renderTaskDetailView();
    }
    if (activeView === "tasks") {
      return renderTasksView();
    }
    if (activeView === "calendar") {
      return renderCalendarView();
    }
    if (activeView === "team") {
      return renderTeamView();
    }
    if (activeView === "reminders") {
      return renderRemindersView();
    }
    if (activeView === "activity") {
      return renderActivityView();
    }
    if (activeView === "rewards") {
      return renderRewardsView();
    }
    return renderDashboardView();
  }

  function renderDashboardView() {
    const mineToday = state.tasks.filter((task) => task.assigneeId === state.currentUserId && isToday(task) && isOpen(task));
    const mineOverdue = state.tasks.filter((task) => task.assigneeId === state.currentUserId && isOverdue(task));
    const homeToday = state.tasks.filter((task) => isToday(task) && isOpen(task));
    const weeklyPoints = getUserPoints(state.currentUserId, 7);

    return `
      <section class="view">
        <section class="section-block">
          <div class="section-head">
            <h2>Mini ranking</h2>
            <button class="chip" type="button" data-action="view" data-view="rewards">Pełny ranking</button>
          </div>
          ${renderMiniLeaderboard()}
        </section>

        ${renderDashboardRewardTasks()}

        <div class="single-column">
          <section class="section-block">
            <div class="section-head">
              <h2>Zadania na dziś</h2>
              <button class="chip" type="button" data-action="quick-filter" data-filter="today">Pełna lista</button>
            </div>
            ${renderTaskList(sortTasks(homeToday), "Czysto na dziś", "Nie ma dziś zaplanowanych zadań.")}
          </section>
        </div>

        <div class="metrics">
          ${metricLink(mineToday.length, "Moje dziś", "mine-today")}
          ${metricLink(mineOverdue.length, "Moje zaległe", "mine-overdue")}
          ${metricLink(homeToday.length, "Dom dziś", "today")}
          ${metricLink(weeklyPoints, "Punkty w 7 dni", "rewards")}
        </div>
      </section>
    `;
  }

  function renderDashboardRewardTasks() {
    const rewardItems = state.rewardClaims
      .filter((claim) => claim.status !== "done")
      .map((claim) => ({ claim, task: getTask(claim.taskId), rewardedUser: getUser(claim.userId) }))
      .filter((item) => item.task && item.task.status !== "done" && item.task.assigneeId === state.currentUserId);

    if (!rewardItems.length) {
      return "";
    }

    return `
      <section class="section-block reward-dashboard-section">
        <div class="section-head">
          <h2>Nagrody do przyznania</h2>
        </div>
        <div class="reward-task-list">
          ${rewardItems
            .map(({ claim, task, rewardedUser }) => {
              return `
                <button class="reward-task-card" type="button" data-action="select-task" data-task-id="${task.id}">
                  ${avatar(rewardedUser, "small")}
                  <span>
                    <strong>${escapeHtml(rewardedUser.name)} czeka na nagrodę</strong>
                    <small>Próg ${claim.threshold} pkt · termin ${formatHumanDate(task.dueDate)}</small>
                  </span>
                </button>
              `;
            })
            .join("")}
        </div>
      </section>
    `;
  }

  function metric(value, label) {
    return `
      <div class="metric">
        <p class="metric-value">${value}</p>
        <p class="metric-label">${label}</p>
      </div>
    `;
  }

  function metricLink(value, label, target) {
    return `
      <button class="metric metric-link" type="button" data-action="metric-link" data-target="${target}">
        <span class="metric-value">${value}</span>
        <span class="metric-label">${label}</span>
      </button>
    `;
  }

  function renderMiniLeaderboard() {
    const rows = state.users
      .map((user) => ({ user, points: getUserPoints(user.id), week: getUserPoints(user.id, 7) }))
      .sort((a, b) => b.points - a.points)
      .slice(0, 4);

    return `
      <div class="mini-ranking">
        ${rows
          .map(
            (row, index) => `
              <div class="mini-rank-card">
                <span class="rank-number">${index + 1}</span>
                ${avatar(row.user)}
                <span class="rank-person">
                  <strong>${escapeHtml(row.user.name)}</strong>
                  <small>${row.week} pkt w 7 dni</small>
                  ${renderRewardAxis(row.points, "compact")}
                </span>
                <span class="rank-points">${row.points} pkt</span>
              </div>
            `
          )
          .join("")}
      </div>
    `;
  }

  function renderTasksView() {
    const tasks = getFilteredTasks();

    return `
      <section class="view">
        <div class="section-head">
          <div>
            <p class="eyebrow">Lista zadań</p>
            <h2 class="page-title">Plan domu</h2>
          </div>
          <div class="filter-row">
            ${filterButton("all", "Wszystkie")}
            ${filterButton("mine", "Moje")}
            ${filterButton("today", "Dziś")}
            ${filterButton("overdue", "Zaległe")}
            ${filterButton("done", "Ukończone")}
          </div>
        </div>

        <section class="section-block">
          <input class="input" data-action="search" value="${escapeAttribute(searchQuery)}" placeholder="Szukaj po nazwie lub pomieszczeniu" />
          <div style="height: 12px"></div>
          ${renderTaskList(tasks, "Brak zadań", "Zmień filtr albo dodaj nowe zadanie.")}
        </section>
      </section>
    `;
  }

  function renderTaskDetailView() {
    const task = state.tasks.find((item) => item.id === selectedTaskId);

    if (!task) {
      return `
        <section class="view">
          <button class="ghost-button back-button" type="button" data-action="back-to-tasks">← Wróć do listy</button>
          <div class="empty-state">
            <strong>Nie znaleziono zadania</strong>
            <span>Wróć do listy i wybierz inne zadanie.</span>
          </div>
        </section>
      `;
    }

    return `
      <section class="view task-detail-view">
        <div class="section-head detail-screen-head">
          <button class="ghost-button back-button" type="button" data-action="back-to-tasks">← Wróć do listy</button>
          <span class="pill ${task.status === "done" ? "done" : PRIORITY[task.priority].className}">
            ${task.status === "done" ? "Ukończone" : PRIORITY[task.priority].label}
          </span>
        </div>
        <section class="detail-pane detail-pane-standalone">
          ${renderInspector()}
        </section>
      </section>
    `;
  }

  function filterButton(id, label) {
    return `
      <button class="chip ${activeFilter === id ? "is-active" : ""}" type="button" data-action="filter" data-filter="${id}">
        ${label}
      </button>
    `;
  }

  function renderCalendarView() {
    const days = getCalendarDays(calendarCursor);
    const selectedTasks = sortTasks(state.tasks.filter((task) => task.dueDate === selectedDate));
    const title = new Intl.DateTimeFormat("pl-PL", { month: "long", year: "numeric" }).format(calendarCursor);

    return `
      <section class="view">
        <div class="section-head">
          <div>
            <p class="eyebrow">Kalendarz</p>
            <h2 class="page-title">Obowiązki w czasie</h2>
          </div>
          <button class="button" type="button" data-action="open-task-modal">
            <span aria-hidden="true">＋</span>
            <span>Dodaj</span>
          </button>
        </div>

        <div class="calendar-shell">
          <section>
            <div class="calendar-toolbar">
              <button class="icon-button" type="button" data-action="month-prev" aria-label="Poprzedni miesiąc">‹</button>
              <h3 class="calendar-title">${capitalize(title)}</h3>
              <button class="icon-button" type="button" data-action="month-next" aria-label="Następny miesiąc">›</button>
            </div>
            <div class="calendar-grid">
              ${["Pon", "Wt", "Śr", "Czw", "Pt", "Sob", "Nd"].map((day) => `<div class="weekday">${day}</div>`).join("")}
              ${days.map((day) => renderDayCell(day)).join("")}
            </div>
          </section>

          <section class="section-block">
            <div class="section-head">
              <h2>${formatHumanDate(selectedDate)}</h2>
            </div>
            ${renderTaskList(selectedTasks, "Ten dzień jest pusty", "Nie ma tu jeszcze zadań.")}
          </section>
        </div>
      </section>
    `;
  }

  function renderDayCell(day) {
    const tasks = state.tasks.filter((task) => task.dueDate === day.iso);
    const visibleDots = tasks.slice(0, 5);
    const className = [
      "day-cell",
      day.inMonth ? "" : "is-muted",
      day.iso === toISO(new Date()) ? "is-today" : "",
      day.iso === selectedDate ? "is-selected" : ""
    ]
      .filter(Boolean)
      .join(" ");

    return `
      <button class="${className}" type="button" data-action="calendar-select" data-date="${day.iso}">
        <span class="day-number">${day.date.getDate()}</span>
        <span class="day-dots">
          ${visibleDots
            .map(
              (task) =>
                `<span class="dot ${task.status === "done" ? "done" : PRIORITY[task.priority].className}" aria-hidden="true"></span>`
            )
            .join("")}
        </span>
        ${tasks.length ? `<span class="day-count">${tasks.length} zad.</span>` : ""}
      </button>
    `;
  }

  function renderTeamView() {
    const openTasks = state.tasks.filter((task) => task.status !== "done");

    return `
      <section class="view">
        <div class="section-head">
          <div>
            <p class="eyebrow">Domownicy</p>
            <h2 class="page-title">Kto co ma na głowie</h2>
          </div>
        </div>

        <section class="section-block narrow-block">
          <div class="household-badge invite-panel">
            <strong>Kod zaproszenia</strong>
            <span>${escapeHtml(state.household.inviteCode)}</span>
          </div>
        </section>

        <div class="people-grid">
          ${state.users
            .map((user) => {
              const assigned = openTasks.filter((task) => task.assigneeId === user.id);
              const overdue = assigned.filter((task) => isOverdue(task)).length;
              const today = assigned.filter((task) => isToday(task)).length;
              return `
                <article class="person-card">
                  <div class="person-card-head">
                    ${avatar(user)}
                    <div>
                      <h3>${escapeHtml(user.name)}</h3>
                      <p>${getUserPoints(user.id)} pkt łącznie</p>
                    </div>
                  </div>
                  <div class="compact-stats">
                    <span><strong>${today}</strong> dziś</span>
                    <span><strong>${overdue}</strong> zaległe</span>
                    <span><strong>${assigned.length}</strong> otwarte</span>
                  </div>
                  ${
                    state.users.length > 1
                      ? `<button class="danger-button person-remove-button" type="button" data-action="remove-user" data-user-id="${user.id}">Usuń domownika</button>`
                      : ""
                  }
                </article>
              `;
            })
            .join("")}
        </div>

        <section class="section-block narrow-block">
          <div class="section-head">
            <h2>Dodaj domownika</h2>
          </div>
          <form class="inline-form" data-form="add-user">
            <input class="input" name="name" placeholder="Imię osoby" maxlength="28" required />
            <input class="input" name="pin" placeholder="PIN" inputmode="numeric" maxlength="4" pattern="[0-9]{4}" required />
            <button class="button" type="submit">Dodaj</button>
          </form>
        </section>
      </section>
    `;
  }

  function renderRemindersView() {
    const reminders = getUpcomingReminders();
    const notifications = getVisibleNotifications().sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    return `
      <section class="view">
        <div class="section-head">
          <div>
            <p class="eyebrow">Przypomnienia</p>
            <h2 class="page-title">Godziny i powiadomienia</h2>
          </div>
          <button class="button" type="button" data-action="request-notifications">
            <span aria-hidden="true">◉</span>
            <span>${getNotificationPermissionText()}</span>
          </button>
        </div>

        <div class="content-grid">
          <section class="section-block">
            <div class="section-head">
              <h2>Nadchodzące</h2>
            </div>
            ${renderMiniList(reminders, "Brak przypomnień w kolejce.")}
          </section>

          <section class="section-block">
            <div class="section-head">
              <h2>Ostatnie alerty</h2>
              <button class="chip" type="button" data-action="mark-notifications-read">Wyczyść</button>
            </div>
            ${
              notifications.length
                ? `<div class="notification-list">${notifications
                    .map(
                      (item) => `
                        <button class="notification-item" type="button" data-action="select-task" data-task-id="${item.taskId}">
                          <span class="avatar small" style="background:${item.read ? "#a99a8f" : "#b85f45"}">!</span>
                          <span class="item-body">
                            <span class="item-title">${escapeHtml(item.title)} · ${formatShortDateTime(item.createdAt)}</span>
                            <span class="item-text">${escapeHtml(item.body)}</span>
                          </span>
                        </button>
                      `
                    )
                    .join("")}</div>`
                : `<div class="empty-state"><strong>Brak alertów</strong><span>Przypomnienia pojawią się tutaj po wybranej godzinie.</span></div>`
            }
          </section>
        </div>
      </section>
    `;
  }

  function renderActivityView() {
    const history = getRecentHistory();

    return `
      <section class="view">
        <div class="section-head">
          <div>
            <p class="eyebrow">Aktywność</p>
            <h2 class="page-title">Historia domu</h2>
          </div>
        </div>
        <section class="section-block narrow-block">
          ${renderHistoryList(history, "Jeszcze nic się nie wydarzyło.")}
        </section>
      </section>
    `;
  }

  function renderRewardsView() {
    const completedThisWeek = state.tasks.filter((task) => task.status === "done" && isWithinLastDays(task.completedAt, 7));
    const totalDone = state.tasks.filter((task) => task.status === "done").length;
    const currentUser = getCurrentUser();

    return `
      <section class="view">
        <div class="section-head">
          <div>
            <p class="eyebrow">Punkty</p>
            <h2 class="page-title">Motywacja domowników</h2>
          </div>
        </div>

        <div class="metrics">
          ${metric(getUserPoints(currentUser.id), `Punkty: ${escapeHtml(currentUser.name)}`)}
          ${metric(getUserPoints(currentUser.id, 7), "Moje 7 dni")}
          ${metric(completedThisWeek.length, "Zrobione w 7 dni")}
          ${metric(totalDone, "Zrobione łącznie")}
        </div>

        <div class="content-grid">
          <section class="section-block">
            <div class="section-head">
              <h2>Ranking</h2>
            </div>
            ${renderLeaderboard()}
          </section>

          <section class="section-block">
            <div class="section-head">
              <h2>Ostatnie ukończenia</h2>
            </div>
            ${renderTaskList(
              sortTasks(state.tasks.filter((task) => task.status === "done")).slice(0, 5),
              "Jeszcze bez punktów",
              "Ukończ pierwsze zadanie."
            )}
          </section>
        </div>

        <section class="section-block">
          <div class="section-head">
            <h2>Progi nagród</h2>
          </div>
          <div class="reward-grid">
            ${REWARD_THRESHOLDS.map((threshold) =>
              reward("★", threshold.label, false, `Próg ${threshold.points} pkt. Po osiągnięciu powstaje zadanie nagrodowe dla innego domownika.`)
            ).join("")}
          </div>
        </section>

        <section class="section-block">
          <div class="section-head">
            <h2>Nagrody do przyznania</h2>
          </div>
          ${renderRewardClaims()}
        </section>
      </section>
    `;
  }

  function renderRewardClaims() {
    const pendingClaims = state.rewardClaims.filter((claim) => claim.status !== "done");

    if (!pendingClaims.length) {
      return `<div class="empty-state"><strong>Brak oczekujących nagród</strong><span>Progi pojawią się tutaj po zdobyciu punktów.</span></div>`;
    }

    return `
      <div class="history-list">
        ${pendingClaims
          .map((claim) => {
            const user = getUser(claim.userId);
            const task = getTask(claim.taskId);
            const assignee = task ? getUser(task.assigneeId) : null;
            return `
              <div class="history-item">
                ${avatar(user, "small")}
                <div class="item-body">
                  <p class="item-title">${escapeHtml(user.name)} czeka na nagrodę za ${claim.threshold} pkt</p>
                  <p class="item-text">${assignee ? `Zadanie ma ${escapeHtml(assignee.name)} · ` : ""}${task ? formatHumanDate(task.dueDate) : ""}</p>
                </div>
              </div>
            `;
          })
          .join("")}
      </div>
    `;
  }

  function reward(icon, title, achieved, text) {
    return `
      <article class="reward">
        <div class="reward-icon" aria-hidden="true">${icon}</div>
        <h3>${title} ${achieved ? "✓" : ""}</h3>
        <p>${text}</p>
      </article>
    `;
  }

  function renderTaskList(tasks, emptyTitle, emptyText) {
    if (!tasks.length) {
      return `
        <div class="empty-state">
          <strong>${emptyTitle}</strong>
          <span>${emptyText}</span>
        </div>
      `;
    }

    return `
      <div class="task-list">
        ${tasks.map((task) => renderTaskCard(task)).join("")}
      </div>
    `;
  }

  function renderTaskCard(task) {
    const assignee = getUser(task.assigneeId);
    const completeDisabled = task.status === "done" || task.assigneeId !== state.currentUserId;
    const meta = [
      `<span class="pill ${PRIORITY[task.priority].className}">${PRIORITY[task.priority].label}</span>`,
      isOverdue(task) ? `<span class="pill overdue">Zaległe</span>` : "",
      task.status === "done" ? `<span class="pill done">Ukończone</span>` : "",
      task.recurrence.type !== "none" ? `<span class="pill blue">${RECURRENCE[task.recurrence.type]}</span>` : ""
    ]
      .filter(Boolean)
      .join("");

    return `
      <article class="task-card ${task.status === "done" ? "is-done" : ""} ${
      selectedTaskId === task.id ? "is-selected" : ""
    }">
        <button class="task-check" type="button" data-action="complete-task" data-task-id="${task.id}" ${
      completeDisabled ? "disabled" : ""
    } aria-label="Oznacz jako ukończone">✓</button>
        <div>
          <h3 class="task-title">${escapeHtml(task.title)}</h3>
          <div class="task-meta">
            ${avatar(assignee, "small")}
            <span>${escapeHtml(assignee.name)}</span>
            <span>•</span>
            <span>${formatHumanDate(task.dueDate)}</span>
            <span>•</span>
            <span>${task.reminderTime}</span>
            <span>•</span>
            <span>${escapeHtml(task.room)}</span>
          </div>
          <div class="task-meta" style="margin-top: 7px">${meta}</div>
        </div>
        <div class="task-actions">
          ${
            task.assigneeId !== state.currentUserId && task.status !== "done"
              ? `<button class="quick-button" type="button" data-action="assign-me" data-task-id="${task.id}" aria-label="Przepisz na mnie">↙</button>`
              : ""
          }
          <button class="quick-button" type="button" data-action="select-task" data-task-id="${task.id}" aria-label="Szczegóły">›</button>
        </div>
      </article>
    `;
  }

  function renderInspector() {
    const task = state.tasks.find((item) => item.id === selectedTaskId);
    if (!task) {
      return renderInspectorFallback();
    }

    const assignee = getUser(task.assigneeId);
    const creator = getUser(task.createdById);
    const canComplete = task.status !== "done" && task.assigneeId === state.currentUserId;
    const overdueDays = getOverdueDays(task);

    return `
      <div class="inspector-stack">
        <section class="detail-card">
          <div class="section-head">
            <h2>Szczegóły</h2>
            <span class="pill ${task.status === "done" ? "done" : PRIORITY[task.priority].className}">
              ${task.status === "done" ? "Ukończone" : PRIORITY[task.priority].label}
            </span>
          </div>
          <h3 class="detail-title">${escapeHtml(task.title)}</h3>
          <div>
            ${detailRow("Osoba", `${avatar(assignee, "small")}<span>${escapeHtml(assignee.name)}</span>`)}
            ${detailRow("Termin", formatHumanDate(task.dueDate))}
            ${detailRow("Przypomn.", task.reminderTime)}
            ${detailRow("Miejsce", escapeHtml(task.room))}
            ${detailRow("Punkty", `${task.points} pkt`)}
            ${overdueDays ? detailRow("Zwłoka", `${overdueDays} dni · -${overdueDays * 10} pkt`) : ""}
            ${detailRow("Cykl", `${RECURRENCE[task.recurrence.type]}${task.recurrence.rotate ? " · rotacja" : ""}`)}
            ${detailRow("Autor", escapeHtml(creator.name))}
          </div>

          <div class="split-actions">
            ${
              task.status === "done"
                ? `<button class="ghost-button" type="button" data-action="reopen-task" data-task-id="${task.id}">Przywróć</button>`
                : canComplete
                  ? `<button class="button" type="button" data-action="complete-task" data-task-id="${task.id}">Oznacz jako ukończone</button>`
                  : `<button class="ghost-button" type="button" data-action="assign-me" data-task-id="${task.id}">Przepisz na mnie</button>`
            }
            <button class="ghost-button" type="button" data-action="open-task-modal">Dodaj</button>
          </div>
        </section>

        <section>
          <div class="section-head">
            <h3>Przypisanie</h3>
          </div>
          <form class="split-actions" data-form="reassign" data-task-id="${task.id}">
            <select class="select" name="assigneeId">
              ${state.users
                .map(
                  (user) =>
                    `<option value="${user.id}" ${user.id === task.assigneeId ? "selected" : ""}>${escapeHtml(
                      user.name
                    )}</option>`
                )
                .join("")}
            </select>
            <button class="ghost-button" type="submit">Zmień</button>
          </form>
        </section>

        <section>
          <div class="section-head">
            <h3>Komentarze</h3>
          </div>
          ${renderComments(task)}
          <form data-form="comment" data-task-id="${task.id}" style="margin-top: 12px">
            <textarea class="textarea" name="comment" placeholder="Dodaj komentarz" required maxlength="280"></textarea>
            <div class="form-actions">
              <button class="button" type="submit">Dodaj</button>
            </div>
          </form>
        </section>

        <section>
          <div class="section-head">
            <h3>Historia</h3>
          </div>
          ${renderHistoryList(task.history.slice().reverse(), "Brak historii.")}
        </section>
      </div>
    `;
  }

  function renderInspectorFallback() {
    const todayTasks = sortTasks(state.tasks.filter((task) => isToday(task))).slice(0, 5);
    return `
      <div class="inspector-stack">
        <section>
          <div class="section-head">
            <h2>Dziś w domu</h2>
          </div>
          ${renderTaskList(todayTasks, "Spokojny dzień", "Nie ma zadań na dziś.")}
        </section>
      </div>
    `;
  }

  function detailRow(label, value) {
    return `
      <div class="detail-row">
        <div class="detail-label">${label}</div>
        <div class="detail-value detail-grid">${value}</div>
      </div>
    `;
  }

  function renderComments(task) {
    if (!task.comments.length) {
      return `<div class="empty-state"><strong>Bez komentarzy</strong><span>Dodaj pierwszy wpis.</span></div>`;
    }

    return `
      <div class="comment-list">
        ${task.comments
          .slice()
          .reverse()
          .map((comment) => {
            const user = getUser(comment.userId);
            return `
              <div class="comment-item">
                ${avatar(user, "small")}
                <div class="item-body">
                  <p class="item-title">${escapeHtml(user.name)} · ${formatShortDateTime(comment.createdAt)}</p>
                  <p class="item-text">${escapeHtml(comment.text)}</p>
                </div>
              </div>
            `;
          })
          .join("")}
      </div>
    `;
  }

  function renderTaskModal() {
    return `
      <div class="modal-backdrop" role="presentation" data-action="close-modal">
        <section class="modal" role="dialog" aria-modal="true" aria-labelledby="task-modal-title">
          <div class="modal-head">
            <h2 class="modal-title" id="task-modal-title">Nowe zadanie</h2>
            <button class="icon-button" type="button" data-action="close-modal" aria-label="Zamknij">×</button>
          </div>
          <form data-form="task">
            <div class="form-grid">
              <label class="wide">
                <span class="label">Nazwa</span>
                <input class="input" name="title" placeholder="Np. umyć podłogę" maxlength="90" required autofocus />
              </label>
              <label>
                <span class="label">Termin</span>
                <input class="input" type="date" name="dueDate" value="${selectedDate || toISO(new Date())}" required />
              </label>
              <label>
                <span class="label">Przypomnienie</span>
                <input class="input" type="time" name="reminderTime" value="18:00" required />
              </label>
              <label>
                <span class="label">Osoba</span>
                <select class="select" name="assigneeId" required>
                  ${state.users
                    .map(
                      (user) =>
                        `<option value="${user.id}" ${
                          user.id === state.currentUserId ? "selected" : ""
                        }>${escapeHtml(user.name)}</option>`
                    )
                    .join("")}
                </select>
              </label>
              <label>
                <span class="label">Priorytet</span>
                <select class="select" name="priority" required>
                  <option value="medium">Normalny · 10 pkt</option>
                  <option value="high">Wysoki · 15 pkt</option>
                  <option value="low">Lekki · 5 pkt</option>
                </select>
              </label>
              <label>
                <span class="label">Pomieszczenie</span>
                <select class="select" name="room">
                  ${ROOM_OPTIONS.map((room) => `<option value="${room}">${room}</option>`).join("")}
                </select>
              </label>
              <label>
                <span class="label">Powtarzanie</span>
                <select class="select" name="recurrenceType">
                  ${Object.entries(RECURRENCE)
                    .map(([value, label]) => `<option value="${value}">${label}</option>`)
                    .join("")}
                </select>
              </label>
              <label class="wide status-line">
                <input type="checkbox" name="rotate" checked />
                <span>Rotacja między domownikami przy kolejnych cyklach</span>
              </label>
            </div>
            <div class="form-actions">
              <button class="ghost-button" type="button" data-action="close-modal">Anuluj</button>
              <button class="button" type="submit">Dodaj zadanie</button>
            </div>
          </form>
        </section>
      </div>
    `;
  }

  function renderNotificationPanel() {
    const notifications = getVisibleNotifications().sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    return `
      <section class="notification-panel" aria-label="Powiadomienia">
        <div class="section-head">
          <h2>Powiadomienia</h2>
          <button class="chip" type="button" data-action="mark-notifications-read">Wyczyść</button>
        </div>
        ${
          notifications.length
            ? `<div class="notification-list">${notifications
                .map(
                  (item) => `
                    <button class="notification-item" type="button" data-action="select-task" data-task-id="${item.taskId}">
                      <span class="avatar small" style="background:${item.read ? "#a99a8f" : "#b85f45"}">!</span>
                      <span class="item-body">
                        <span class="item-title">${escapeHtml(item.title)} · ${formatShortDateTime(item.createdAt)}</span>
                        <span class="item-text">${escapeHtml(item.body)}</span>
                      </span>
                    </button>
                  `
                )
                .join("")}</div>`
            : `<div class="empty-state"><strong>Wszystko czyste</strong><span>Brak nowych powiadomień.</span></div>`
        }
      </section>
    `;
  }

  function renderMiniList(items, emptyText) {
    if (!items.length) {
      return `<div class="empty-state"><strong>Spokojnie</strong><span>${emptyText}</span></div>`;
    }

    return `
      <div class="mini-list">
        ${items
          .map((item) => {
            const user = getUser(item.assigneeId);
            return `
              <button class="mini-item" type="button" data-action="select-task" data-task-id="${item.id}">
                ${avatar(user, "small")}
                <span class="item-body">
                  <span class="item-title">${escapeHtml(item.title)}</span>
                  <span class="item-text">${formatHumanDate(item.dueDate)} · ${item.reminderTime} · ${escapeHtml(user.name)}</span>
                </span>
              </button>
            `;
          })
          .join("")}
      </div>
    `;
  }

  function renderLeaderboard() {
    const rows = state.users
      .map((user) => ({ user, points: getUserPoints(user.id) }))
      .sort((a, b) => b.points - a.points);

    return `
      <div class="leaderboard">
        ${rows
          .map(
            (row) => `
              <div class="leader-row">
                ${avatar(row.user)}
                <div class="truncate">
                  <strong>${escapeHtml(row.user.name)}</strong>
                  ${renderRewardAxis(row.points)}
                </div>
                <div class="person-points">${row.points} pkt</div>
              </div>
            `
          )
          .join("")}
      </div>
    `;
  }

  function renderRewardAxis(points, variant = "") {
    const axisMax = Math.max(REWARD_THRESHOLDS[REWARD_THRESHOLDS.length - 1].points, points, 1);
    const fillWidth = Math.min(100, Math.max(3, (points / axisMax) * 100));

    return `
      <div class="reward-axis ${variant}" aria-label="Postęp do nagród">
        <span class="reward-axis-fill" style="width:${fillWidth}%"></span>
        ${REWARD_THRESHOLDS.map((threshold) => {
          const left = Math.min(100, (threshold.points / axisMax) * 100);
          const reached = points >= threshold.points ? "is-reached" : "";
          return `
            <span class="reward-axis-marker ${reached}" style="left:${left}%" title="${threshold.label}: ${threshold.points} pkt">
              <span>${threshold.points}</span>
            </span>
          `;
        }).join("")}
      </div>
    `;
  }

  function renderHistoryList(history, emptyText) {
    if (!history.length) {
      return `<div class="empty-state"><strong>Cicho tu</strong><span>${emptyText}</span></div>`;
    }

    return `
      <div class="history-list">
        ${history
          .map((entry) => {
            const user = getUser(entry.userId);
            return `
              <div class="history-item">
                ${avatar(user, "small")}
                <div class="item-body">
                  <p class="item-title">${escapeHtml(entry.text)}</p>
                  <p class="item-text">${escapeHtml(user.name)} · ${formatShortDateTime(entry.createdAt)}</p>
                </div>
              </div>
            `;
          })
          .join("")}
      </div>
    `;
  }

  function handleClick(event) {
    const actionElement = event.target.closest("[data-action]");
    if (!actionElement) {
      return;
    }

    const action = actionElement.dataset.action;

    if (action === "view") {
      activeView = actionElement.dataset.view;
      notificationPanelOpen = false;
      render();
      return;
    }

    if (action === "filter" || action === "quick-filter") {
      activeView = "tasks";
      activeFilter = actionElement.dataset.filter;
      render();
      return;
    }

    if (action === "metric-link") {
      const target = actionElement.dataset.target;
      if (target === "rewards") {
        activeView = "rewards";
      } else {
        activeView = "tasks";
        activeFilter = target;
      }
      render();
      return;
    }

    if (action === "back-to-tasks") {
      activeView = "tasks";
      render();
      return;
    }

    if (action === "open-task-modal") {
      activeModal = "task";
      notificationPanelOpen = false;
      render();
      queueMicrotask(() => document.querySelector("[name='title']")?.focus());
      return;
    }

    if (action === "open-login-modal") {
      activeModal = "login";
      notificationPanelOpen = false;
      render();
      return;
    }

    if (action === "add-member-row") {
      onboardingMembers.push({ id: uid("draft"), name: "", pin: "" });
      render();
      return;
    }

    if (action === "remove-member-row") {
      const index = Number(actionElement.dataset.memberIndex);
      onboardingMembers = onboardingMembers.filter((_, itemIndex) => itemIndex !== index);
      render();
      return;
    }

    if (action === "login-as") {
      state.currentUserId = actionElement.dataset.userId;
      activeModal = "login";
      render();
      return;
    }

    if (action === "logout") {
      clearSession();
      state.isAuthenticated = false;
      activeModal = null;
      notificationPanelOpen = false;
      persistLocalState(state);
      render();
      return;
    }

    if (action === "close-modal") {
      if (event.target === actionElement || actionElement.matches("button")) {
        activeModal = null;
        render();
      }
      return;
    }

    if (action === "select-task") {
      selectedTaskId = actionElement.dataset.taskId;
      activeView = "task-detail";
      state.notifications = state.notifications.map((item) =>
        item.taskId === selectedTaskId ? { ...item, read: true } : item
      );
      notificationPanelOpen = false;
      saveState();
      render();
      return;
    }

    if (action === "complete-task") {
      completeTask(actionElement.dataset.taskId);
      return;
    }

    if (action === "reopen-task") {
      reopenTask(actionElement.dataset.taskId);
      return;
    }

    if (action === "assign-me") {
      reassignTask(actionElement.dataset.taskId, state.currentUserId);
      toast("Zadanie przepisane", "Możesz teraz oznaczyć je jako ukończone.");
      return;
    }

    if (action === "remove-user") {
      removeUser(actionElement.dataset.userId);
      return;
    }

    if (action === "month-prev") {
      calendarCursor = addMonths(calendarCursor, -1);
      render();
      return;
    }

    if (action === "month-next") {
      calendarCursor = addMonths(calendarCursor, 1);
      render();
      return;
    }

    if (action === "calendar-select") {
      selectedDate = actionElement.dataset.date;
      render();
      return;
    }

    if (action === "toggle-notifications") {
      notificationPanelOpen = !notificationPanelOpen;
      if (notificationPanelOpen) {
        state.notifications = state.notifications.map((item) =>
          isNotificationVisible(item) ? { ...item, read: true } : item
        );
        saveState();
      }
      render();
      return;
    }

    if (action === "mark-notifications-read") {
      state.notifications = state.notifications.filter((item) => !isNotificationVisible(item));
      saveState();
      render();
      return;
    }

    if (action === "request-notifications") {
      requestNotifications();
      return;
    }

  }

  function handleChange(event) {
  }

  function handleInput(event) {
    if (event.target.matches("[data-action='search']")) {
      searchQuery = event.target.value;
      render();
    }

    if (event.target.matches("[data-member-field]")) {
      const index = Number(event.target.dataset.memberIndex);
      const field = event.target.dataset.memberField;
      if (onboardingMembers[index]) {
        onboardingMembers[index][field] = field === "pin" ? normalizePin(event.target.value) : event.target.value;
      }
    }
  }

  function handleSubmit(event) {
    const form = event.target.closest("form[data-form]");
    if (!form) {
      return;
    }

    event.preventDefault();
    const formType = form.dataset.form;

    if (formType === "login") {
      const data = new FormData(form);
      loginWithPin(String(data.get("householdId")), String(data.get("userId")), String(data.get("pin")));
      return;
    }

    if (formType === "known-login") {
      const data = new FormData(form);
      loginWithPin(String(data.get("householdId")), String(data.get("userId")), String(data.get("pin")));
      return;
    }

    if (formType === "create-household") {
      createHouseholdFromForm(form);
      return;
    }

    if (formType === "join-household") {
      joinHouseholdFromForm(form);
      return;
    }

    if (formType === "task") {
      const data = new FormData(form);
      const priority = data.get("priority");
      const task = {
        id: uid("task"),
        title: String(data.get("title")).trim(),
        room: String(data.get("room") || "Inne"),
        assigneeId: String(data.get("assigneeId")),
        createdById: state.currentUserId,
        dueDate: String(data.get("dueDate")),
        reminderTime: String(data.get("reminderTime")),
        assignedAt: new Date().toISOString(),
        priority,
        status: "open",
        completedAt: null,
        completedById: null,
        recurrence: {
          type: String(data.get("recurrenceType") || "none"),
          rotate: data.has("rotate")
        },
        points: PRIORITY[priority].points,
        comments: [],
        history: [historyEntry("Utworzono zadanie", state.currentUserId)],
        lastNotifiedAt: null
      };

      state.tasks.unshift(task);
      selectedTaskId = task.id;
      selectedDate = task.dueDate;
      calendarCursor = startOfMonth(fromISO(task.dueDate));
      activeModal = null;
      saveState();
      toast("Dodano zadanie", task.title);
      render();
      return;
    }

    if (formType === "add-user") {
      const data = new FormData(form);
      const name = String(data.get("name")).trim();
      const pin = normalizePin(data.get("pin"));
      if (!name || pin.length !== 4) {
        toast("Uzupełnij domownika", "Podaj imię i 4-cyfrowy PIN.");
        return;
      }

      const user = {
        id: uid("user"),
        name,
        pin,
        color: COLORS[state.users.length % COLORS.length],
        avatar: name.slice(0, 1).toUpperCase()
      };
      state.users.push(user);
      saveState();
      toast("Dodano domownika", name);
      render();
      return;
    }

    if (formType === "reassign") {
      const assigneeId = String(new FormData(form).get("assigneeId"));
      reassignTask(form.dataset.taskId, assigneeId);
      return;
    }

    if (formType === "comment") {
      const text = String(new FormData(form).get("comment")).trim();
      const task = getTask(form.dataset.taskId);
      if (!task || !text) {
        return;
      }

      task.comments.push({
        id: uid("comment"),
        userId: state.currentUserId,
        text,
        createdAt: new Date().toISOString()
      });
      task.history.push(historyEntry("Dodano komentarz", state.currentUserId));
      saveState();
      render();
    }
  }

  function completeTask(taskId) {
    const task = getTask(taskId);
    if (!task || task.status === "done") {
      return;
    }

    if (task.assigneeId !== state.currentUserId) {
      toast("Najpierw przepisz zadanie", "Ukończenie jest dostępne dla osoby przypisanej.");
      selectedTaskId = task.id;
      render();
      return;
    }

    const overdueDays = getOverdueDays(task);
    task.status = "done";
    task.completedAt = new Date().toISOString();
    task.completedById = state.currentUserId;
    task.history.push(historyEntry(`Ukończono zadanie za ${task.points} pkt`, state.currentUserId));
    completeRewardClaim(task);
    if (overdueDays > 0) {
      task.history.push(historyEntry(`Kara za zwłokę: -${overdueDays * 10} pkt`, state.currentUserId));
    }
    selectedTaskId = task.id;

    if (task.isRewardTask) {
      toast("Nagroda przyznana", "Zdobyto symboliczne 5 pkt.");
    } else if (task.recurrence.type !== "none") {
      const nextTask = createNextRecurringTask(task);
      state.tasks.unshift(nextTask);
      toast("Zadanie ukończone", `Dodano kolejny termin: ${formatHumanDate(nextTask.dueDate)}.`);
    } else {
      const penaltyText = overdueDays ? `, kara za zwłokę -${overdueDays * 10} pkt` : "";
      toast("Zadanie ukończone", `Zdobyto ${task.points} pkt${penaltyText}.`);
    }

    saveState();
    render();
  }

  function reopenTask(taskId) {
    const task = getTask(taskId);
    if (!task) {
      return;
    }

    task.status = "open";
    task.completedAt = null;
    task.completedById = null;
    task.history.push(historyEntry("Przywrócono zadanie", state.currentUserId));
    saveState();
    toast("Zadanie przywrócone", task.title);
    render();
  }

  function reassignTask(taskId, assigneeId) {
    const task = getTask(taskId);
    if (!task || task.assigneeId === assigneeId) {
      render();
      return;
    }

    const previousAssigneeId = task.assigneeId;
    const oldUser = getUser(task.assigneeId);
    const nextUser = getUser(assigneeId);
    const settledOverdueDays = getOverdueDays(task);
    if (settledOverdueDays > 0) {
      addPointEvent({
        userId: previousAssigneeId,
        taskId: task.id,
        delta: -settledOverdueDays * 10,
        type: "overdue",
        text: `Kara za ${settledOverdueDays} dni zwłoki przed przepisaniem zadania`
      });
    }

    task.assigneeId = assigneeId;
    task.assignedAt = new Date().toISOString();
    task.history.push(historyEntry(`Przepisano z ${oldUser.name} na ${nextUser.name}`, state.currentUserId));
    if (settledOverdueDays > 0) {
      task.history.push(historyEntry(`Rozliczono zwłokę ${oldUser.name}: -${settledOverdueDays * 10} pkt`, previousAssigneeId));
    }

    if (assigneeId === state.currentUserId && previousAssigneeId !== state.currentUserId) {
      addPointEvent({
        userId: state.currentUserId,
        taskId: task.id,
        delta: 10,
        type: "take",
        text: `Przejęto zadanie od ${oldUser.name}`
      });
      task.history.push(historyEntry("Bonus za przejęcie zadania: +10 pkt", state.currentUserId));
    } else if (previousAssigneeId === state.currentUserId && assigneeId !== state.currentUserId) {
      addPointEvent({
        userId: state.currentUserId,
        taskId: task.id,
        delta: -10,
        type: "give",
        text: `Oddano zadanie osobie: ${nextUser.name}`
      });
      task.history.push(historyEntry("Kara za oddanie zadania: -10 pkt", state.currentUserId));
    }

    selectedTaskId = task.id;
    saveState();
    toast("Przypisanie zmienione", `${task.title} → ${nextUser.name}`);
    render();
  }

  function removeUser(userId) {
    if (state.users.length <= 1) {
      toast("Nie można usunąć", "W domu musi zostać przynajmniej jeden domownik.");
      return;
    }

    const removedUser = getUser(userId);
    const remainingUsers = state.users.filter((user) => user.id !== userId);
    const openTasks = state.tasks.filter((task) => task.status !== "done" && task.assigneeId === userId);

    openTasks.forEach((task) => {
      const nextUser = pickUserForRedistributedTask(remainingUsers);
      task.assigneeId = nextUser.id;
      task.assignedAt = new Date().toISOString();
      task.history.push(historyEntry(`Przeniesiono po usunięciu: ${removedUser.name} → ${nextUser.name}`, state.currentUserId));
    });

    state.users = remainingUsers;
    if (state.currentUserId === userId) {
      const nextUser = remainingUsers[0];
      state.currentUserId = nextUser.id;
      session = { ...session, userId: nextUser.id, pin: nextUser.pin };
      saveSession(session);
    }

    rememberHousehold(state);
    saveState();
    toast("Usunięto domownika", openTasks.length ? "Otwarte zadania zostały rozdzielone." : removedUser.name);
    render();
  }

  function pickUserForRedistributedTask(users) {
    const workload = new Map(users.map((user) => [user.id, 0]));

    state.tasks.forEach((task) => {
      if (task.status !== "done" && workload.has(task.assigneeId)) {
        workload.set(task.assigneeId, workload.get(task.assigneeId) + task.points);
      }
    });

    return users
      .map((user) => ({ user, load: workload.get(user.id) || 0 }))
      .sort((a, b) => a.load - b.load)[0].user;
  }

  function createNextRecurringTask(task) {
    const dueDate = getNextDueDate(task.dueDate, task.recurrence.type);
    const assigneeId = task.recurrence.rotate ? getNextUserId(task.assigneeId) : task.assigneeId;
    const nextTask = {
      ...task,
      id: uid("task"),
      assigneeId,
      dueDate,
      status: "open",
      assignedAt: new Date().toISOString(),
      completedAt: null,
      completedById: null,
      comments: [],
      history: [historyEntry("Utworzono z cyklu", state.currentUserId)],
      lastNotifiedAt: null
    };

    return nextTask;
  }

  async function requestNotifications() {
    if (!("Notification" in window)) {
      toast("Powiadomienia niedostępne", "Ta przeglądarka nie obsługuje lokalnych powiadomień.");
      return;
    }

    const permission = await Notification.requestPermission();
    if (permission === "granted") {
      toast("Powiadomienia włączone", "Przypomnienia pojawią się o ustawionej godzinie.");
      runReminderSweep();
    } else {
      toast("Powiadomienia wyłączone", "Alerty w aplikacji nadal będą działać.");
    }
    render();
  }

  function runReminderSweep() {
    const dueTasks = getDueReminderTasks();
    if (!dueTasks.length) {
      return;
    }

    dueTasks.forEach((task) => {
      const assignee = getUser(task.assigneeId);
      const title = isOverdue(task) ? "Zaległe zadanie" : "Zadanie na dziś";
      const body = `${task.title} · ${assignee.name} · ${task.reminderTime}`;

      state.notifications.unshift({
        id: uid("notification"),
        taskId: task.id,
        title,
        body,
        recipientUserId: task.assigneeId,
        read: false,
        createdAt: new Date().toISOString()
      });

      task.lastNotifiedAt = new Date().toISOString();
      showSystemNotification(title, body, task.id);
    });

    state.notifications = state.notifications.slice(0, 30);
    saveState();
    render();
  }

  function getDueReminderTasks() {
    const now = new Date();
    const today = toISO(now);
    const currentMinutes = now.getHours() * 60 + now.getMinutes();

    return state.tasks.filter((task) => {
      if (task.status === "done" || !task.reminderTime || task.assigneeId !== state.currentUserId) {
        return false;
      }

      if (task.dueDate > today) {
        return false;
      }

      const [hour, minute] = task.reminderTime.split(":").map(Number);
      const reminderMinutes = hour * 60 + minute;
      if (currentMinutes < reminderMinutes) {
        return false;
      }

      if (!task.lastNotifiedAt) {
        return true;
      }

      const last = new Date(task.lastNotifiedAt);
      const diff = (now - last) / 60000;
      return diff >= REMINDER_REPEAT_MINUTES;
    });
  }

  async function showSystemNotification(title, body, taskId) {
    if (!("Notification" in window) || Notification.permission !== "granted") {
      return;
    }

    try {
      if (serviceWorkerRegistration?.showNotification) {
        await serviceWorkerRegistration.showNotification(title, {
          body,
          tag: taskId,
          icon: "./icon.svg",
          badge: "./icon.svg"
        });
      } else {
        const notification = new Notification(title, { body, icon: "./icon.svg", tag: taskId });
        notification.onclick = () => window.focus();
      }
    } catch (error) {
      console.warn("Nie udało się pokazać powiadomienia", error);
    }
  }

  async function registerServiceWorker() {
    if (!("serviceWorker" in navigator)) {
      return;
    }

    try {
      serviceWorkerRegistration = await navigator.serviceWorker.register("./sw.js");
    } catch (error) {
      console.warn("Service worker nie został zarejestrowany", error);
    }
  }

  function getFilteredTasks() {
    let tasks = [...state.tasks];

    if (activeFilter === "mine") {
      tasks = tasks.filter((task) => task.assigneeId === state.currentUserId);
    } else if (activeFilter === "mine-today") {
      tasks = tasks.filter((task) => task.assigneeId === state.currentUserId && isToday(task) && task.status !== "done");
    } else if (activeFilter === "mine-overdue") {
      tasks = tasks.filter((task) => task.assigneeId === state.currentUserId && isOverdue(task));
    } else if (activeFilter === "today") {
      tasks = tasks.filter((task) => isToday(task) && task.status !== "done");
    } else if (activeFilter === "overdue") {
      tasks = tasks.filter((task) => isOverdue(task));
    } else if (activeFilter === "done") {
      tasks = tasks.filter((task) => task.status === "done");
    }

    if (searchQuery.trim()) {
      const query = searchQuery.trim().toLocaleLowerCase("pl-PL");
      tasks = tasks.filter((task) =>
        `${task.title} ${task.room} ${getUser(task.assigneeId).name}`.toLocaleLowerCase("pl-PL").includes(query)
      );
    }

    return sortTasks(tasks);
  }

  function sortTasks(tasks) {
    return tasks.slice().sort((a, b) => {
      if (a.status !== b.status) {
        return a.status === "open" ? -1 : 1;
      }
      if (a.dueDate !== b.dueDate) {
        return a.dueDate.localeCompare(b.dueDate);
      }
      return priorityRank(a.priority) - priorityRank(b.priority);
    });
  }

  function getUpcomingReminders() {
    const today = toISO(new Date());
    return sortTasks(
      state.tasks.filter((task) => task.status !== "done" && task.dueDate >= today && task.reminderTime)
    ).sort((a, b) => `${a.dueDate} ${a.reminderTime}`.localeCompare(`${b.dueDate} ${b.reminderTime}`));
  }

  function getVisibleNotifications() {
    return state.notifications.filter((item) => isNotificationVisible(item));
  }

  function isNotificationVisible(item) {
    return !item.recipientUserId || item.recipientUserId === state.currentUserId;
  }

  function getRecentHistory() {
    return state.tasks
      .flatMap((task) =>
        task.history.map((entry) => ({
          ...entry,
          text: `${entry.text}: ${task.title}`,
          taskId: task.id
        }))
      )
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  }

  function getUserPoints(userId, lastDays = null) {
    const completedPoints = state.tasks
      .filter((task) => task.status === "done" && task.completedById === userId)
      .filter((task) => (lastDays ? isWithinLastDays(task.completedAt, lastDays) : true))
      .reduce((sum, task) => sum + task.points, 0);

    const transferPoints = state.pointEvents
      .filter((event) => event.userId === userId)
      .filter((event) => (lastDays ? isWithinLastDays(event.createdAt, lastDays) : true))
      .reduce((sum, event) => sum + event.delta, 0);

    const overduePenalty = state.tasks.reduce((sum, task) => {
      const penaltyUserId = getPenaltyUserId(task);
      if (penaltyUserId !== userId) {
        return sum;
      }
      return sum - getOverdueDays(task, lastDays) * 10;
    }, 0);

    return completedPoints + transferPoints + overduePenalty;
  }

  function getPenaltyUserId(task) {
    if (task.status === "done") {
      return task.completedById || task.assigneeId;
    }
    return task.assigneeId;
  }

  function getOverdueDays(task, lastDays = null) {
    const dueDate = fromISO(task.dueDate);
    const assignedDate = task.assignedAt ? fromISO(toISO(new Date(task.assignedAt))) : dueDate;
    const penaltyBaseDate = assignedDate > dueDate ? assignedDate : dueDate;
    const endDate =
      task.status === "done" && task.completedAt ? fromISO(toISO(new Date(task.completedAt))) : fromISO(toISO(new Date()));

    if (daysBetween(penaltyBaseDate, endDate) <= 0) {
      return 0;
    }

    let startDate = addDays(penaltyBaseDate, 1);
    if (lastDays) {
      const windowStart = fromISO(toISO(addDays(new Date(), -(lastDays - 1))));
      if (windowStart > startDate) {
        startDate = windowStart;
      }
    }

    if (startDate > endDate) {
      return 0;
    }

    return daysBetween(startDate, endDate) + 1;
  }

  function addPointEvent(event) {
    state.pointEvents.unshift({
      id: uid("points"),
      userId: event.userId,
      taskId: event.taskId,
      delta: event.delta,
      type: event.type,
      text: event.text,
      createdAt: new Date().toISOString()
    });
  }

  function syncRewardClaims() {
    if (!state.users.length) {
      return false;
    }

    let changed = false;
    state.rewardClaims = Array.isArray(state.rewardClaims) ? state.rewardClaims : [];

    state.users.forEach((user) => {
      const points = getUserPoints(user.id);

      REWARD_THRESHOLDS.forEach((threshold) => {
        const alreadyClaimed = state.rewardClaims.some(
          (claim) => claim.userId === user.id && claim.threshold === threshold.points
        );

        if (points < threshold.points || alreadyClaimed) {
          return;
        }

        const rewardAssignee = pickRewardAssignee(user.id);
        if (!rewardAssignee) {
          return;
        }

        const task = createRewardTask(user, rewardAssignee, threshold);

        state.rewardClaims.unshift({
          id: uid("reward"),
          userId: user.id,
          threshold: threshold.points,
          label: threshold.label,
          status: "pending",
          taskId: task.id,
          createdAt: new Date().toISOString(),
          completedAt: null
        });

        state.tasks.unshift(task);
        state.notifications.unshift({
          id: uid("notification"),
          taskId: task.id,
          title: "Nagroda do przyznania",
          body: `${user.name} zebrał(a) ${threshold.points} pkt i czeka na nagrodę.`,
          recipientUserId: rewardAssignee.id,
          read: false,
          createdAt: new Date().toISOString()
        });
        changed = true;
      });
    });

    state.notifications = state.notifications.slice(0, 40);
    return changed;
  }

  function pickRewardAssignee(rewardedUserId) {
    return state.users
      .filter((user) => user.id !== rewardedUserId)
      .map((user) => ({ user, points: getUserPoints(user.id) }))
      .sort((a, b) => a.points - b.points)[0]?.user;
  }

  function createRewardTask(rewardedUser, assignee, threshold) {
    const dueDate = toISO(addDays(new Date(), 7));

    return {
      id: uid("task"),
      title: `Przyznaj nagrodę dla ${rewardedUser.name}`,
      room: "Nagrody",
      assigneeId: assignee.id,
      createdById: rewardedUser.id,
      dueDate,
      reminderTime: "09:00",
      assignedAt: new Date().toISOString(),
      priority: "medium",
      status: "open",
      completedAt: null,
      completedById: null,
      recurrence: { type: "none", rotate: false },
      points: 5,
      isRewardTask: true,
      rewardForUserId: rewardedUser.id,
      rewardThreshold: threshold.points,
      comments: [],
      history: [historyEntry(`${rewardedUser.name} osiągnął/osiągnęła próg ${threshold.points} pkt`, rewardedUser.id)],
      lastNotifiedAt: null
    };
  }

  function completeRewardClaim(task) {
    if (!task.isRewardTask || !task.rewardForUserId || !task.rewardThreshold) {
      return;
    }

    const claim = state.rewardClaims.find(
      (item) =>
        item.userId === task.rewardForUserId &&
        item.threshold === task.rewardThreshold &&
        item.taskId === task.id
    );

    if (claim) {
      claim.status = "done";
      claim.completedAt = new Date().toISOString();
    }
  }

  function getCalendarDays(cursor) {
    const first = startOfMonth(cursor);
    const month = first.getMonth();
    const offset = (first.getDay() + 6) % 7;
    const start = addDays(first, -offset);

    return Array.from({ length: 42 }, (_, index) => {
      const date = addDays(start, index);
      return {
        date,
        iso: toISO(date),
        inMonth: date.getMonth() === month
      };
    });
  }

  function getNextDueDate(dateIso, recurrenceType) {
    const date = fromISO(dateIso);
    if (recurrenceType === "weekly") {
      return toISO(addDays(date, 7));
    }
    if (recurrenceType === "biweekly") {
      return toISO(addDays(date, 14));
    }
    if (recurrenceType === "monthly") {
      return toISO(addMonths(date, 1));
    }
    if (recurrenceType === "quarterly") {
      return toISO(addMonths(date, 3));
    }
    if (recurrenceType === "yearly") {
      return toISO(addMonths(date, 12));
    }
    return dateIso;
  }

  function getNextUserId(currentId) {
    const index = state.users.findIndex((user) => user.id === currentId);
    if (index === -1) {
      return state.users[0].id;
    }
    return state.users[(index + 1) % state.users.length].id;
  }

  function pickInitialTaskId() {
    const current = state.tasks
      ?.filter((task) => task.assigneeId === state.currentUserId && task.status !== "done")
      .sort((a, b) => a.dueDate.localeCompare(b.dueDate))[0];
    return current?.id || state.tasks?.[0]?.id || null;
  }

  function getTask(taskId) {
    return state.tasks.find((task) => task.id === taskId);
  }

  function getCurrentUser() {
    return getUser(state.currentUserId);
  }

  function getUser(userId) {
    return state.users.find((user) => user.id === userId) || state.users[0];
  }

  function isOpen(task) {
    return task.status !== "done";
  }

  function isToday(task) {
    return task.dueDate === toISO(new Date());
  }

  function isOverdue(task) {
    return task.status !== "done" && task.dueDate < toISO(new Date());
  }

  function isWithinLastDays(dateString, days) {
    if (!dateString) {
      return false;
    }
    const date = new Date(dateString);
    const start = new Date();
    start.setDate(start.getDate() - days);
    return date >= start;
  }

  function priorityRank(priority) {
    return { high: 0, medium: 1, low: 2 }[priority] ?? 1;
  }

  function historyEntry(text, userId) {
    return {
      id: uid("history"),
      text,
      userId,
      createdAt: new Date().toISOString()
    };
  }

  function avatar(user, size = "") {
    const safeUser = user || state.users[0];
    return `<span class="avatar ${size}" style="background:${safeUser.color}">${escapeHtml(safeUser.avatar || safeUser.name.slice(0, 1))}</span>`;
  }

  function toast(title, message) {
    const toastElement = document.createElement("div");
    toastElement.className = "toast";
    toastElement.innerHTML = `<strong>${escapeHtml(title)}</strong><span>${escapeHtml(message)}</span>`;
    toastRoot.appendChild(toastElement);
    setTimeout(() => toastElement.remove(), 3600);
  }

  function getNotificationPermissionText() {
    if (!("Notification" in window)) {
      return "Powiadomienia niedostępne";
    }
    if (Notification.permission === "granted") {
      return "Powiadomienia włączone";
    }
    if (Notification.permission === "denied") {
      return "Powiadomienia wyłączone";
    }
    return "Włącz powiadomienia";
  }

  function formatHumanDate(dateIso) {
    const today = toISO(new Date());
    const tomorrow = toISO(addDays(new Date(), 1));
    const yesterday = toISO(addDays(new Date(), -1));
    if (dateIso === today) {
      return "Dziś";
    }
    if (dateIso === tomorrow) {
      return "Jutro";
    }
    if (dateIso === yesterday) {
      return "Wczoraj";
    }
    return new Intl.DateTimeFormat("pl-PL", { day: "numeric", month: "short" }).format(fromISO(dateIso));
  }

  function formatShortDateTime(dateString) {
    return new Intl.DateTimeFormat("pl-PL", {
      day: "numeric",
      month: "short",
      hour: "2-digit",
      minute: "2-digit"
    }).format(new Date(dateString));
  }

  function toISO(date) {
    const copy = new Date(date);
    copy.setHours(12, 0, 0, 0);
    const offset = copy.getTimezoneOffset();
    return new Date(copy.getTime() - offset * 60000).toISOString().slice(0, 10);
  }

  function fromISO(dateIso) {
    const [year, month, day] = dateIso.split("-").map(Number);
    return new Date(year, month - 1, day, 12, 0, 0, 0);
  }

  function addDays(date, days) {
    const next = new Date(date);
    next.setDate(next.getDate() + days);
    return next;
  }

  function addMonths(date, months) {
    const next = new Date(date);
    next.setMonth(next.getMonth() + months);
    return next;
  }

  function daysBetween(start, end) {
    const startDate = fromISO(toISO(start));
    const endDate = fromISO(toISO(end));
    return Math.round((endDate - startDate) / 86400000);
  }

  function startOfMonth(date) {
    return new Date(date.getFullYear(), date.getMonth(), 1, 12, 0, 0, 0);
  }

  function uid(prefix) {
    return `${prefix}-${Math.random().toString(36).slice(2, 8)}-${Date.now().toString(36)}`;
  }

  function generateInviteCode() {
    const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    let code = "HOME-";
    for (let index = 0; index < 4; index += 1) {
      code += alphabet[Math.floor(Math.random() * alphabet.length)];
    }
    return code;
  }

  function capitalize(value) {
    return value.slice(0, 1).toUpperCase() + value.slice(1);
  }

  function escapeHtml(value) {
    return String(value)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function escapeAttribute(value) {
    return escapeHtml(value).replaceAll("\n", " ");
  }
})();
