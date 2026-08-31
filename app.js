(() => {
  const STORAGE_KEY = "homeJob.householdState.v1";
  const LAST_SYNCED_KEY = "homeJob.lastSyncedPayload.v1";
  const LAST_SYNCED_AT_KEY = "homeJob.lastSyncedUpdatedAt.v1";
  const SESSION_KEY = "homeJob.session.v1";
  const KNOWN_HOUSEHOLDS_KEY = "homeJob.knownHouseholds.v1";
  const WEB_PUSH_ENABLED_KEY = "homeJob.webPushEnabled.v1";
  const API_STATE_ENDPOINT = "/api/state";
  const API_PUSH_SUBSCRIPTION_ENDPOINT = "/api/push-subscription";
  const API_USER_HEADER = "x-household-user";
  const API_HOUSEHOLD_HEADER = "x-household-id";
  const API_PIN_HEADER = "x-household-pin";
  const API_BASE_UPDATED_AT_HEADER = "x-base-updated-at";
  const DELETED_TASKS_LIMIT = 300;
  const REMOTE_REFRESH_MS = 60000;
  const VAPID_PUBLIC_KEY = "BPH53rxNE0dFaDrfpaxuYpNFwzuJILXc1dkm0GGxm4sMgPJ3pSXad8OWI9mgTowjPrQlLS3e2X1NicEhsKKrJ-U";
  const SYNC_DEBOUNCE_MS = 700;
  const RECURRING_PROJECTION_DAYS = 365;
  // Limit przekładania: tyle zatwierdzonych przełożeń może mieć jeden domownik
  // w miesiącu kalendarzowym. Zmiana terminu „w przód” idzie wyłącznie tą drogą.
  const MONTHLY_POSTPONE_LIMIT = 3;
  // Wniosek bez kompletu głosów nie może wisieć w nieskończoność — po tylu
  // dniach wygasa, a zadanie wraca do normalnego rytmu przypomnień.
  const REQUEST_EXPIRY_DAYS = 3;
  const MIN_REASON_LENGTH = 5;
  const NOTIFICATIONS_LIMIT = 60;
  const WEEKDAY_LABELS = ["Pon", "Wt", "Śr", "Czw", "Pt", "Sob", "Nd"];
  const SHOPPING_ITEM_POINTS = 0.5;
  const SHOPPING_DELIVERY_POINTS = 5;
  const COLORS = ["#6d28d9", "#db2777", "#2563eb", "#0d9488", "#ea580c", "#7c3aed"];
  const DEFAULT_REWARD_THRESHOLDS = [
    { points: 200, label: "Nagroda" },
    { points: 350, label: "Duża nagroda" },
    { points: 500, label: "Super nagroda" }
  ];
  const DEFAULT_DAY_START = 0;

  // Progi mogą być zmienione w ustawieniach; bez zmian obowiązują domyślne.
  function getRewardThresholds() {
    const wlasne = state.household?.rewardThresholds;
    if (!Array.isArray(wlasne) || wlasne.length !== DEFAULT_REWARD_THRESHOLDS.length) {
      return DEFAULT_REWARD_THRESHOLDS;
    }
    const progi = wlasne
      .map((prog, i) => ({
        points: Number(prog?.points),
        label: String(prog?.label || DEFAULT_REWARD_THRESHOLDS[i].label)
      }))
      .filter((prog) => Number.isFinite(prog.points) && prog.points > 0);
    if (progi.length !== DEFAULT_REWARD_THRESHOLDS.length) {
      return DEFAULT_REWARD_THRESHOLDS;
    }
    // Progi muszą rosnąć, inaczej oś nagród i wykrywanie zdobycia się sypią.
    for (let i = 1; i < progi.length; i += 1) {
      if (progi[i].points <= progi[i - 1].points) {
        return DEFAULT_REWARD_THRESHOLDS;
      }
    }
    return progi;
  }

  function getDayStartHour() {
    const h = Number(state.household?.dayStart);
    return Number.isInteger(h) && h >= 0 && h <= 23 ? h : DEFAULT_DAY_START;
  }

  function getDayEndHour() {
    const h = Number(state.household?.dayEnd);
    return Number.isInteger(h) && h >= 0 && h <= 23 ? h : getDayStartHour();
  }

  // „Dziś” zależy od godziny startu doby: przy starcie o 2:00 zadanie
  // odhaczone o 1:30 wciąż należy do dnia poprzedniego.
  function todayIso() {
    const now = new Date();
    if (now.getHours() < getDayStartHour()) {
      return toISO(addDays(now, -1));
    }
    return toISO(now);
  }

  const MONTHLY_GOAL = 500;
  const CARRYOVER_DIVISOR = 4;
  const HISTORY_FEED_LIMIT = 60;
  const RECENT_DONE_LIMIT = 8;

  const PRIORITY = {
    urgent: { label: "Bardzo wysoki", points: 25, className: "urgent" },
    high: { label: "Wysoki", points: 15, className: "high" },
    medium: { label: "Normalny", points: 10, className: "medium" },
    low: { label: "Lekki", points: 5, className: "low" }
  };

  const RECURRENCE = {
    none: "Jednorazowe",
    daily: "Codziennie",
    every2days: "Co 2 dni",
    every3days: "Co 3 dni",
    weekly: "Co tydzień",
    biweekly: "Co 2 tygodnie",
    triweekly: "Co 3 tygodnie",
    monthly: "Co miesiąc",
    quarterly: "Co 3 miesiące",
    yearly: "Co rok"
  };

  const REQUEST_LABELS = {
    skip: "Nie ma potrzeby",
    postpone: "Przełożenie terminu"
  };

  const app = document.querySelector("#app");
  const toastRoot = document.querySelector("#toast-root");

  let knownHouseholds = loadKnownHouseholds();
  let onboardingMembers = [
    { id: uid("draft"), name: "", pin: "" },
    { id: uid("draft"), name: "", pin: "" }
  ];
  let session = loadSession();
  let state = applySession(loadState());
  let routeTaskId = getRouteTaskId();
  let activeView = routeTaskId ? "task-detail" : "dashboard";
  let activeFilter = "all";
  let searchQuery = "";
  let selectedTaskId = routeTaskId || pickInitialTaskId();
  let selectedDate = todayIso();
  let calendarCursor = startOfMonth(new Date());
  let activeModal = null;
  let shoppingModalTaskId = null;
  let rewardCelebration = null;
  let settingsPanel = null;
  let settingsPanelTarget = null;
  let adminUnlocked = false;
  let editingTaskId = null;
  let taskModalKind = "standard";
  let requestTaskId = null;
  let requestKind = "postpone";
  let votingRequestId = null;
  let notificationPanelOpen = false;
  let lastRenderedViewKey = null;
  let pauseModalTarget = "dom";
  let knownRewardClaimIds = null;
  let countedValues = new Map();
  let moreMenuOpen = false;
  let serviceWorkerRegistration = null;
  let remoteHydrationFinished = false;
  let remoteSaveTimer = null;
  let lastRemotePayload = loadLastSyncedPayload();
  let lastRemoteUpdatedAt = loadLastSyncedUpdatedAt();

  registerServiceWorker();
  odswiezSubskrypcjePush();
  recomputeDerived();
  persistLocalState(state);
  render();
  hydrateRemoteState();
  runReminderSweep();
  setInterval(runReminderSweep, 30000);

  document.addEventListener("click", handleClick);
  document.addEventListener("change", handleChange);
  document.addEventListener("input", handleInput);
  document.addEventListener("submit", handleSubmit);
  document.addEventListener("visibilitychange", handleVisibilityChange);
  window.addEventListener("pagehide", flushPendingSync);
  setInterval(refreshFromRemote, REMOTE_REFRESH_MS);

  // Zdarzenia dotyku są delegowane na document, bo render() podmienia całe #app
  // i handlery przypięte do konkretnych kart znikałyby przy każdym przerysowaniu.
  document.addEventListener("touchstart", handleSwipeStart, { passive: true });
  document.addEventListener("touchmove", handleSwipeMove, { passive: true });
  document.addEventListener("touchend", handleSwipeEnd);
  document.addEventListener("touchcancel", handleSwipeEnd);

  function createSeedState() {
    return {
      household: {
        id: null,
        name: "HomeJob",
        inviteCode: "",
        pause: null,
        homeBonus: null,
        carryoverDonePeriod: null
      },
      isAuthenticated: false,
      currentUserId: null,
      users: [],
      tasks: [],
      pointEvents: [],
      notifications: [],
      rewardClaims: [],
      taskRequests: [],
      deletedTaskIds: [],
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
        inviteCode: data.household?.inviteCode || data.inviteCode || "",
        pause: normalizeDateRange(data.household?.pause),
        homeBonus: data.household?.homeBonus || null,
        carryoverDonePeriod: data.household?.carryoverDonePeriod || null
      },
      isAuthenticated: false,
      currentUserId: data.currentUserId,
      users: Array.isArray(data.users) ? data.users : fallbackState.users,
      tasks: Array.isArray(data.tasks) ? data.tasks : [],
      pointEvents: Array.isArray(data.pointEvents) ? data.pointEvents : [],
      notifications: Array.isArray(data.notifications) ? data.notifications.slice(0, NOTIFICATIONS_LIMIT) : [],
      rewardClaims: Array.isArray(data.rewardClaims) ? data.rewardClaims : [],
      taskRequests: normalizeTaskRequests(data.taskRequests),
      deletedTaskIds: Array.isArray(data.deletedTaskIds)
        ? data.deletedTaskIds
            .map((item) => ({
              id: item?.id || String(item || ""),
              deletedAt: item?.deletedAt || new Date().toISOString()
            }))
            .filter((item) => item.id)
            .slice(0, DELETED_TASKS_LIMIT)
        : [],
      createdAt: data.createdAt || new Date().toISOString()
    };

    nextState.users = nextState.users.map((user) => {
      return {
        id: user.id || uid("user"),
        name: user.name || "Domownik",
        color: user.color || COLORS[0],
        avatar: user.avatar || (user.name || "D").slice(0, 1).toUpperCase(),
        pin: normalizePin(user.pin),
        absence: normalizeDateRange(user.absence)
      };
    });

    nextState.currentUserId = nextState.users.some((user) => user.id === nextState.currentUserId)
      ? nextState.currentUserId
      : nextState.users[0]?.id || null;

    const validUserIds = new Set(nextState.users.map((user) => user.id));
    nextState.tasks = nextState.tasks.map((task) => {
      const recurrenceType = task.recurrence?.type === "seasonal" ? "quarterly" : task.recurrence?.type;
      const taskType = task.type === "shopping" ? "shopping" : "standard";
      const shoppingItems = normalizeShoppingItems(task.shoppingItems);
      const rawAssignees = Array.isArray(task.assigneeIds) && task.assigneeIds.length ? task.assigneeIds : [task.assigneeId];
      const assigneeIds = Array.from(new Set(rawAssignees.filter((id) => validUserIds.has(id))));
      if (!assigneeIds.length) {
        assigneeIds.push(nextState.users[0].id);
      }
      const status = task.status === "done" ? "done" : task.status === "skipped" ? "skipped" : "open";

      return {
        id: task.id || uid("task"),
        title: task.title || "Zadanie",
        type: taskType,
        room: task.room || (taskType === "shopping" ? "Zakupy" : "Inne"),
        assigneeId: assigneeIds[0],
        assigneeIds,
        createdById: task.createdById || nextState.users[0].id,
        dueDate: task.dueDate || todayIso(),
        reminderTime: task.reminderTime || "18:00",
        assignedAt: task.assignedAt || task.createdAt || `${task.dueDate || todayIso()}T12:00:00.000Z`,
        priority: taskType === "shopping" ? "medium" : PRIORITY[task.priority] ? task.priority : "medium",
        status,
        completedAt: task.completedAt || null,
        completedById: task.completedById || null,
        skippedById: task.skippedById || null,
        recurrence: {
          type: RECURRENCE[recurrenceType] ? recurrenceType : "none",
          rotate: Boolean(task.recurrence?.rotate),
          skipWeekdays: normalizeSkipWeekdays(task.recurrence?.skipWeekdays)
        },
        points:
          taskType === "shopping"
            ? getShoppingPotentialPoints(shoppingItems)
            : Number.isFinite(Number(task.points))
              ? Number(task.points)
              : PRIORITY[task.priority || "medium"].points,
        shoppingItems,
        isRewardTask: Boolean(task.isRewardTask),
        rewardForUserId: task.rewardForUserId || null,
        rewardThreshold: Number(task.rewardThreshold) || null,
        rewardPeriod: task.rewardPeriod || null,
        nextRecurringTaskId: task.nextRecurringTaskId || null,
        comments: Array.isArray(task.comments) ? task.comments : [],
        history: Array.isArray(task.history) ? task.history : [],
        lastNotifiedAt: task.lastNotifiedAt || null
      };
    });

    nextState.rewardClaims = nextState.rewardClaims.map((claim) => ({
      id: claim.id || uid("reward"),
      userId: claim.userId || nextState.users[0]?.id || null,
      threshold: Number(claim.threshold) || 0,
      label: claim.label || "Nagroda",
      status: claim.status === "done" ? "done" : "pending",
      taskId: claim.taskId || null,
      period: claim.period || getPointPeriodKey(claim.createdAt),
      createdAt: claim.createdAt || new Date().toISOString(),
      completedAt: claim.completedAt || null
    }));

    return nextState;
  }

  // Wnioski (przełożenie / „nie ma potrzeby”) trzymamy w jednej liście obok
  // zadań — dzięki temu limit 3 przełożeń na miesiąc i historia głosowań
  // przeżywają usunięcie samego zadania.
  function normalizeTaskRequests(value) {
    if (!Array.isArray(value)) {
      return [];
    }

    return value
      .filter((item) => item && item.taskId && (item.type === "skip" || item.type === "postpone"))
      .map((item) => ({
        id: item.id || uid("request"),
        taskId: String(item.taskId),
        taskTitle: item.taskTitle || "Zadanie",
        type: item.type,
        requestedById: item.requestedById || null,
        reason: String(item.reason || ""),
        previousDueDate: item.previousDueDate || null,
        proposedDueDate: item.proposedDueDate || null,
        status: item.status === "approved" || item.status === "rejected" ? item.status : "pending",
        votes: Array.isArray(item.votes)
          ? item.votes
              .filter((vote) => vote && vote.userId)
              .map((vote) => ({
                userId: vote.userId,
                value: vote.value === "no" ? "no" : "yes",
                reason: String(vote.reason || ""),
                createdAt: vote.createdAt || new Date().toISOString()
              }))
          : [],
        createdAt: item.createdAt || new Date().toISOString(),
        resolvedAt: item.resolvedAt || null
      }))
      .slice(0, 200);
  }

  function normalizePin(pin) {
    return String(pin || "").replace(/\D/g, "").slice(0, 4);
  }

  function normalizeSkipWeekdays(value) {
    if (!Array.isArray(value)) {
      return [];
    }
    return Array.from(
      new Set(value.map(Number).filter((day) => Number.isInteger(day) && day >= 0 && day <= 6))
    ).sort((a, b) => a - b);
  }

  function normalizeDateRange(value) {
    if (!value || !value.from || !value.until) {
      return null;
    }
    const from = String(value.from);
    const until = String(value.until);
    if (from > until) {
      return null;
    }
    return { from, until };
  }

  function isDateWithinPause(dateIso) {
    const pause = state.household.pause;
    return Boolean(pause && dateIso >= pause.from && dateIso <= pause.until);
  }

  function isHouseholdPausedNow() {
    return isDateWithinPause(todayIso());
  }

  function countPausedDaysInRange(startDate, endDate) {
    return countRangeOverlap(state.household.pause, startDate, endDate);
  }

  function countRangeOverlap(range, startDate, endDate) {
    if (!range) {
      return 0;
    }
    const rangeStart = fromISO(range.from);
    const rangeEnd = fromISO(range.until);
    const overlapStart = rangeStart > startDate ? rangeStart : startDate;
    const overlapEnd = rangeEnd < endDate ? rangeEnd : endDate;
    if (overlapStart > overlapEnd) {
      return 0;
    }
    return daysBetween(overlapStart, overlapEnd) + 1;
  }

  /* ============ Nieobecność domownika ============
     Pauza domu ("wyjeżdżamy wszyscy") i nieobecność pojedynczej osoby działają
     tak samo z punktu widzenia jednego domownika — stąd wspólne funkcje. */
  function getUserAbsence(userId) {
    return getUserById(userId)?.absence || null;
  }

  function isUserAbsentOn(userId, dateIso) {
    if (isDateWithinPause(dateIso)) {
      return true;
    }
    const absence = getUserAbsence(userId);
    return Boolean(absence && dateIso >= absence.from && dateIso <= absence.until);
  }

  function isUserAbsentNow(userId) {
    return isUserAbsentOn(userId, todayIso());
  }

  // Dni, za które nie nalicza się kara zwłoki: pauza domu plus własna nieobecność.
  // Zakresy mogą się nakładać, więc liczymy sumę mnogościową, nie sumę długości.
  function countExcusedDaysInRange(userId, startDate, endDate) {
    const pause = state.household.pause;
    const absence = getUserAbsence(userId);
    if (!pause && !absence) {
      return 0;
    }
    if (!pause || !absence) {
      return countRangeOverlap(pause || absence, startDate, endDate);
    }

    let dni = 0;
    for (let d = new Date(startDate); d <= endDate; d = addDays(d, 1)) {
      if (isUserAbsentOn(userId, toISO(d))) {
        dni += 1;
      }
    }
    return dni;
  }

  // Kto jest dostępny danego dnia — używane przy rotacji zadań cyklicznych.
  function getNextAvailableUserId(currentId, dateIso) {
    const index = state.users.findIndex((user) => user.id === currentId);
    const start = index === -1 ? 0 : index;
    for (let step = 1; step <= state.users.length; step += 1) {
      const kandydat = state.users[(start + step) % state.users.length];
      if (!isUserAbsentOn(kandydat.id, dateIso)) {
        return kandydat.id;
      }
    }
    // Wszyscy nieobecni — zostawiamy zwykłą kolejność.
    return getNextUserId(currentId);
  }

  function getAssigneeIds(task) {
    if (Array.isArray(task?.assigneeIds) && task.assigneeIds.length) {
      return task.assigneeIds;
    }
    return task?.assigneeId ? [task.assigneeId] : [];
  }

  function getAssignees(task) {
    return getAssigneeIds(task).map((id) => getUser(id));
  }

  function isAssignee(task, userId) {
    return getAssigneeIds(task).includes(userId);
  }

  function formatAssigneeNames(task) {
    return getAssignees(task)
      .map((user) => escapeHtml(user.name))
      .join(", ");
  }

  function renderAssigneeAvatars(task, size = "small") {
    return getAssignees(task)
      .map((user) => avatar(user, size))
      .join("");
  }

  function isSkipped(task) {
    return task?.status === "skipped";
  }

  function saveState() {
    recomputeDerived();
    persistLocalState(state);
    rememberHousehold(state);
    queueRemoteSave();
  }

  function recomputeDerived() {
    const carryoverChanged = processMonthlyCarryover();
    const bonusChanged = refreshHomeBonus();
    const claimsChanged = syncRewardClaims();
    const requestsChanged = expireStaleRequests();
    detectFreshRewardClaim();
    return carryoverChanged || bonusChanged || claimsChanged || requestsChanged;
  }

  function expireStaleRequests() {
    const cutoff = Date.now() - REQUEST_EXPIRY_DAYS * 24 * 60 * 60 * 1000;
    let changed = false;

    getPendingRequests().forEach((request) => {
      const createdAt = Date.parse(request.createdAt || "");
      if (Number.isFinite(createdAt) && createdAt > cutoff) {
        return;
      }

      request.status = "rejected";
      request.resolvedAt = new Date().toISOString();
      changed = true;

      const task = getTask(request.taskId);
      if (task) {
        task.history.push(historyEntry(`Wniosek wygasł bez kompletu głosów (${REQUEST_LABELS[request.type]})`, request.requestedById));
        task.lastNotifiedAt = null;
      }

      notifyUsers([request.requestedById], {
        title: "Wniosek wygasł",
        body: `Dom nie dogłosował w ciągu ${REQUEST_EXPIRY_DAYS} dni. „${request.taskTitle}” zostaje bez zmian.`,
        taskId: request.taskId,
        push: true
      });
    });

    return changed;
  }

  // Świętujemy wyłącznie próg zdobyty na żywo w tej sesji. Przy pierwszym
  // uruchomieniu tylko zapamiętujemy, co już jest, żeby otwarcie aplikacji nie
  // odpalało konfetti za nagrody sprzed tygodnia.
  function detectFreshRewardClaim() {
    const claims = Array.isArray(state.rewardClaims) ? state.rewardClaims : [];

    if (!knownRewardClaimIds) {
      knownRewardClaimIds = new Set(claims.map((claim) => claim.id));
      return;
    }

    const swiezy = claims.find((claim) => !knownRewardClaimIds.has(claim.id) && claim.userId === state.currentUserId);
    claims.forEach((claim) => knownRewardClaimIds.add(claim.id));

    if (swiezy) {
      // Próg przebity własnym zadaniem: miotła zostaje, konfetti dochodzi.
      sweepCelebration();
      startKonfetti(2800);
    }
  }

  function persistLocalState(nextState) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(nextState));
  }

  function loadLastSyncedPayload() {
    try {
      return localStorage.getItem(LAST_SYNCED_KEY) || "";
    } catch (error) {
      return "";
    }
  }

  function loadLastSyncedUpdatedAt() {
    try {
      return localStorage.getItem(LAST_SYNCED_AT_KEY) || "";
    } catch (error) {
      return "";
    }
  }

  function rememberSyncedPayload(payload, updatedAt) {
    lastRemotePayload = payload;
    if (updatedAt) {
      lastRemoteUpdatedAt = updatedAt;
    }
    try {
      localStorage.setItem(LAST_SYNCED_KEY, payload);
      localStorage.setItem(LAST_SYNCED_AT_KEY, lastRemoteUpdatedAt || "");
    } catch (error) {
      console.warn("Nie udało się zapisać znacznika synchronizacji", error);
    }
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
      taskRequests: state.taskRequests,
      deletedTaskIds: state.deletedTaskIds,
      createdAt: state.createdAt
    };
  }

  async function hydrateRemoteState() {
    if (!canUseRemoteApi() || !session?.pin) {
      remoteHydrationFinished = true;
      return;
    }

    const hasPendingLocalChanges = JSON.stringify(getRemoteStatePayload()) !== lastRemotePayload;

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

      if (hasPendingLocalChanges) {
        // Local device has changes from a previous session that never made it to the
        // server (e.g. the app was closed before the debounced save fired). Trusting the
        // server here would silently discard them, so push local state instead of
        // overwriting it.
        queueRemoteSave(100);
        return;
      }

      state = applySession(normalizeState(payload.state));
      rememberSyncedPayload(JSON.stringify(getRemoteStatePayload()), payload.updatedAt);
      const rewardClaimsChanged = recomputeDerived();
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

  function handleVisibilityChange() {
    if (document.visibilityState === "hidden") {
      flushPendingSync();
      return;
    }

    refreshFromRemote();
  }

  function flushPendingSync() {
    if (!remoteSaveTimer) {
      return;
    }

    clearTimeout(remoteSaveTimer);
    remoteSaveTimer = null;
    syncRemoteState();
  }

  async function refreshFromRemote() {
    if (!canUseRemoteApi() || !remoteHydrationFinished || !session?.pin || document.visibilityState === "hidden") {
      return;
    }

    // Re-rendering rebuilds the whole screen, which would wipe whatever the
    // user has typed into an open dialog. Skip this round; the next tick (or
    // the next foreground) picks it up once the dialog is closed.
    if (activeModal) {
      return;
    }

    if (JSON.stringify(getRemoteStatePayload()) !== lastRemotePayload) {
      queueRemoteSave(100);
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
        return;
      }

      const payload = await response.json();
      if (!payload.state || payload.updatedAt === lastRemoteUpdatedAt) {
        return;
      }

      state = applySession(normalizeState(payload.state));
      rememberSyncedPayload(JSON.stringify(getRemoteStatePayload()), payload.updatedAt);
      recomputeDerived();
      persistLocalState(state);
      rememberHousehold(state);

      if (!state.tasks.some((task) => task.id === selectedTaskId)) {
        selectedTaskId = pickInitialTaskId();
      }

      render();
    } catch (error) {
      console.warn("Remote refresh failed", error);
    }
  }

  async function syncRemoteState(attempt = 0) {
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
          [API_BASE_UPDATED_AT_HEADER]: lastRemoteUpdatedAt || "",
          ...getAuthHeaders()
        },
        body: payload
      });

      if (response.status === 409) {
        const conflict = await response.json().catch(() => null);
        if (conflict?.state && attempt < 3) {
          adoptMergedRemoteState(conflict.state, conflict.updatedAt);
          return syncRemoteState(attempt + 1);
        }
        console.warn("Remote save conflict could not be resolved");
        return;
      }

      if (!response.ok) {
        throw new Error(`API state responded with ${response.status}`);
      }

      const result = await response.json().catch(() => null);
      rememberSyncedPayload(payload, result?.updatedAt);
    } catch (error) {
      console.warn("Remote save failed", error);
    }
  }

  function adoptMergedRemoteState(serverState, serverUpdatedAt) {
    const merged = mergeStates(normalizeState(serverState), state);
    state = applySession(normalizeState(merged));
    if (serverUpdatedAt) {
      lastRemoteUpdatedAt = serverUpdatedAt;
      try {
        localStorage.setItem(LAST_SYNCED_AT_KEY, lastRemoteUpdatedAt);
      } catch (error) {
        console.warn("Nie udało się zapisać znacznika synchronizacji", error);
      }
    }
    recomputeDerived();
    persistLocalState(state);
    rememberHousehold(state);

    if (!state.tasks.some((task) => task.id === selectedTaskId)) {
      selectedTaskId = pickInitialTaskId();
    }

    render();
  }

  function mergeStates(serverState, localState) {
    const deletedById = new Map();
    [...(serverState.deletedTaskIds || []), ...(localState.deletedTaskIds || [])].forEach((item) => {
      if (item?.id && !deletedById.has(item.id)) {
        deletedById.set(item.id, item);
      }
    });

    const mergeById = (serverItems, localItems, pickOnConflict) => {
      const result = new Map();
      (serverItems || []).forEach((item) => {
        if (item?.id) {
          result.set(item.id, item);
        }
      });
      (localItems || []).forEach((item) => {
        if (!item?.id) {
          return;
        }
        const existing = result.get(item.id);
        result.set(item.id, existing ? pickOnConflict(existing, item) : item);
      });
      return Array.from(result.values());
    };

    const taskActivityStamp = (task) => {
      const historyAt = task.history?.length ? task.history[task.history.length - 1]?.createdAt : null;
      return Math.max(
        Date.parse(historyAt || "") || 0,
        Date.parse(task.completedAt || "") || 0,
        Date.parse(task.assignedAt || "") || 0
      );
    };

    const tasks = mergeById(serverState.tasks, localState.tasks, (serverTask, localTask) =>
      taskActivityStamp(localTask) >= taskActivityStamp(serverTask) ? localTask : serverTask
    ).filter((task) => !deletedById.has(task.id));

    return {
      household: localState.household,
      users: mergeById(serverState.users, localState.users, (serverUser, localUser) => localUser),
      tasks,
      pointEvents: mergeById(serverState.pointEvents, localState.pointEvents, (serverEvent, localEvent) => localEvent),
      notifications: mergeById(serverState.notifications, localState.notifications, (serverItem, localItem) => ({
        ...localItem,
        read: Boolean(serverItem.read || localItem.read)
      }))
        .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
        .slice(0, NOTIFICATIONS_LIMIT),
      rewardClaims: mergeById(serverState.rewardClaims, localState.rewardClaims, (serverClaim, localClaim) =>
        serverClaim.status === "done" && localClaim.status !== "done" ? serverClaim : localClaim
      ),
      // Dwa telefony mogą głosować równocześnie, więc przy konflikcie sklejamy
      // głosy z obu stron; rozstrzygnięty wniosek zawsze wygrywa z oczekującym.
      taskRequests: mergeById(serverState.taskRequests, localState.taskRequests, (serverRequest, localRequest) => {
        const votes = [...(serverRequest.votes || [])];
        (localRequest.votes || []).forEach((vote) => {
          if (!votes.some((item) => item.userId === vote.userId)) {
            votes.push(vote);
          }
        });
        const resolved =
          serverRequest.status !== "pending" ? serverRequest : localRequest.status !== "pending" ? localRequest : localRequest;
        return { ...resolved, votes };
      }),
      deletedTaskIds: Array.from(deletedById.values()).slice(0, DELETED_TASKS_LIMIT),
      createdAt: serverState.createdAt || localState.createdAt
    };
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
    rememberSyncedPayload(JSON.stringify(getRemoteStatePayload()), remotePayload?.updatedAt);
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
    let createdUpdatedAt = "";

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

        createdUpdatedAt = (await response.json().catch(() => null))?.updatedAt || "";
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
    rememberSyncedPayload(JSON.stringify(getRemoteStatePayload()), createdUpdatedAt);
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
      rememberSyncedPayload(JSON.stringify(getRemoteStatePayload()), payload.updatedAt);
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

    // The whole screen is rebuilt on every state change, so entry animations
    // must only run when the user actually switches view — otherwise ticking a
    // checkbox (or the 30s reminder sweep) would re-animate everything.
    const viewKey = `${activeView}:${activeModal || ""}`;
    const isEntering = viewKey !== lastRenderedViewKey;
    lastRenderedViewKey = viewKey;

    app.innerHTML = `
      <div class="app-shell">
        ${renderSidebar(currentUser)}
        <main class="main${isEntering ? " is-entering" : ""}">
          ${renderTopbar(currentUser)}
          ${renderActiveView()}
        </main>
      </div>
      ${activeModal === "task" ? renderTaskModal() : ""}
      ${activeModal === "request" ? renderRequestModal() : ""}
      ${activeModal === "vote" ? renderVoteModal() : ""}
      ${activeModal === "login" ? renderLoginModal() : ""}
      ${activeModal === "pause" ? renderPauseModal() : ""}
      ${activeModal === "shopping-item" ? renderShoppingItemModal() : ""}
      ${activeModal === "settings" ? renderSettingsModal() : ""}
      ${rewardCelebration ? renderRewardCelebration() : ""}
      ${notificationPanelOpen ? renderNotificationPanel() : ""}
    `;

    ustawBlokadePrzewijania(Boolean(activeModal) || notificationPanelOpen);
    dodajUchwytyArkuszy();
    growProgressBars();
    animateCounters();
  }

  // Strona pod otwartym oknem nie może jechać razem z palcem. Blokadę robi
  // sam CSS (overflow na body + overscroll-behavior na oknie i jego tle).
  // Wcześniej było tu position: fixed, ale to gubi pozycję przewijania i
  // gryzie się z klawiaturą iOS — po dotknięciu pola okno przestawało się
  // przewijać.
  // Pasek na górze arkusza musi być prawdziwym elementem, żeby dało się go
  // złapać palcem — jako ::before był tylko rysunkiem.
  function dodajUchwytyArkuszy() {
    document.querySelectorAll(".modal").forEach((sheet) => {
      if (!sheet.querySelector(":scope > .sheet-handle")) {
        sheet.insertAdjacentHTML("afterbegin", '<span class="sheet-handle" aria-hidden="true"></span>');
      }
    });
  }

  function ustawBlokadePrzewijania(zablokuj) {
    document.body.classList.toggle("is-modal-open", zablokuj);
  }

  function prefersReducedMotion() {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  }

  /* ===================== Konfetti nagrody =====================
     Osobny canvas poza #app (render() przebudowuje #app przy każdej zmianie
     stanu). Konfetti sypie się od góry ekranu w dół i samo wygasa. */
  let confettiCanvas = null;
  let confettiCtx = null;
  let confettiPieces = [];
  let confettiRunning = false;
  let confettiSypieDo = 0;

  const CONFETTI_COLORS = ["#e0a920", "#f7d774", "#a855f7", "#ff5ea8", "#6d28d9", "#ffd7b0", "#ffffff"];

  function ensureConfettiCanvas() {
    if (confettiCanvas) {
      return confettiCanvas;
    }
    confettiCanvas = document.createElement("canvas");
    confettiCanvas.className = "confetti-canvas";
    confettiCanvas.setAttribute("aria-hidden", "true");
    document.body.appendChild(confettiCanvas);
    confettiCtx = confettiCanvas.getContext("2d");
    resizeConfettiCanvas();
    window.addEventListener("resize", resizeConfettiCanvas);
    return confettiCanvas;
  }

  function resizeConfettiCanvas() {
    if (!confettiCanvas) {
      return;
    }
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    confettiCanvas.width = window.innerWidth * ratio;
    confettiCanvas.height = window.innerHeight * ratio;
    confettiCanvas.style.width = `${window.innerWidth}px`;
    confettiCanvas.style.height = `${window.innerHeight}px`;
    confettiCtx.setTransform(ratio, 0, 0, ratio, 0, 0);
  }

  function sypnijKonfetti(ile) {
    for (let i = 0; i < ile; i += 1) {
      confettiPieces.push({
        x: Math.random() * window.innerWidth,
        y: -20 - Math.random() * 80,
        vy: 1.6 + Math.random() * 3.2,
        vx: -0.6 + Math.random() * 1.2,
        size: 5 + Math.random() * 7,
        rot: Math.random() * Math.PI * 2,
        vr: -0.12 + Math.random() * 0.24,
        kolysanie: Math.random() * Math.PI * 2,
        tempo: 0.02 + Math.random() * 0.04,
        kolo: Math.random() < 0.28,
        color: CONFETTI_COLORS[Math.floor(Math.random() * CONFETTI_COLORS.length)]
      });
    }
  }

  function startKonfetti(czasMs) {
    if (prefersReducedMotion()) {
      return;
    }
    ensureConfettiCanvas();
    confettiSypieDo = performance.now() + czasMs;
    if (confettiRunning) {
      return;
    }
    confettiRunning = true;

    const step = () => {
      const teraz = performance.now();
      confettiCtx.clearRect(0, 0, confettiCanvas.width, confettiCanvas.height);

      if (teraz < confettiSypieDo) {
        sypnijKonfetti(2);
      }

      confettiPieces = confettiPieces.filter((p) => p.y < window.innerHeight + 40);
      confettiPieces.forEach((p) => {
        p.kolysanie += p.tempo;
        p.x += p.vx + Math.sin(p.kolysanie) * 0.9;
        p.y += p.vy;
        p.rot += p.vr;

        confettiCtx.save();
        confettiCtx.translate(p.x, p.y);
        confettiCtx.rotate(p.rot);
        confettiCtx.fillStyle = p.color;
        if (p.kolo) {
          confettiCtx.beginPath();
          confettiCtx.arc(0, 0, p.size * 0.42, 0, Math.PI * 2);
          confettiCtx.fill();
        } else {
          confettiCtx.fillRect(-p.size / 2, -p.size * 0.3, p.size, p.size * 0.6);
        }
        confettiCtx.restore();
      });

      if (confettiPieces.length || teraz < confettiSypieDo) {
        requestAnimationFrame(step);
      } else {
        confettiCtx.clearRect(0, 0, confettiCanvas.width, confettiCanvas.height);
        confettiRunning = false;
      }
    };
    requestAnimationFrame(step);
  }

  function stopKonfetti() {
    confettiSypieDo = 0;
  }

  /* ===================== Miotła =====================
     Jeden współdzielony canvas poza #app — render() przebudowuje #app przy
     każdej zmianie stanu, więc animacja musi żyć poza tym drzewem.
     Zamiast konfetti zadanie „wymiata” miotła: przejeżdża przez kartę i
     zostawia za sobą chmurę kurzu. */
  let sweepCanvas = null;
  let sweepCtx = null;
  let sweepMotes = [];
  let sweepBrooms = [];
  let sweepRunning = false;

  const DUST_COLORS = ["#c3b4f2", "#ffd7b0", "#ffbfd4", "#a855f7", "#f6d5a8", "#ffffff"];

  function ensureSweepCanvas() {
    if (sweepCanvas) {
      return sweepCanvas;
    }
    sweepCanvas = document.createElement("canvas");
    sweepCanvas.className = "sweep-canvas";
    sweepCanvas.setAttribute("aria-hidden", "true");
    document.body.appendChild(sweepCanvas);
    sweepCtx = sweepCanvas.getContext("2d");
    resizeSweepCanvas();
    window.addEventListener("resize", resizeSweepCanvas);
    return sweepCanvas;
  }

  function resizeSweepCanvas() {
    if (!sweepCanvas) {
      return;
    }
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    sweepCanvas.width = window.innerWidth * ratio;
    sweepCanvas.height = window.innerHeight * ratio;
    sweepCanvas.style.width = `${window.innerWidth}px`;
    sweepCanvas.style.height = `${window.innerHeight}px`;
    sweepCtx.setTransform(ratio, 0, 0, ratio, 0, 0);
  }

  // Kurz leci głównie w prawo i do góry — tak, jakby zmiótł go ruch miotły.
  function spawnDust(x, y, count, power) {
    for (let i = 0; i < count; i += 1) {
      const angle = -Math.PI * (0.04 + Math.random() * 0.46);
      const speed = power * (0.35 + Math.random() * 0.85);
      sweepMotes.push({
        x,
        y,
        vx: Math.cos(angle) * speed + power * 0.42,
        vy: Math.sin(angle) * speed,
        size: 2 + Math.random() * 5,
        color: DUST_COLORS[(Math.random() * DUST_COLORS.length) | 0],
        rot: Math.random() * Math.PI,
        vr: (Math.random() - 0.5) * 0.3,
        iskra: Math.random() < 0.3,
        life: 0,
        maxLife: 38 + Math.random() * 46
      });
    }
    startSweepLoop();
  }

  function spawnBroom(x, y, width, options = {}) {
    sweepBrooms.push({
      x0: x - width / 2,
      x1: x + width / 2,
      y,
      life: 0,
      maxLife: options.maxLife || 32,
      scale: options.scale || 1,
      power: options.power || 6,
      kurz: options.kurz !== false
    });
    startSweepLoop();
  }

  function drawBroom(x, y, angle, scale, alpha) {
    const ctx = sweepCtx;
    ctx.save();
    ctx.globalAlpha = Math.max(0, Math.min(1, alpha));
    ctx.translate(x, y);
    ctx.rotate(angle);
    ctx.scale(scale, scale);
    ctx.lineCap = "round";

    ctx.strokeStyle = "#8b5a2b";
    ctx.lineWidth = 5;
    ctx.beginPath();
    ctx.moveTo(0, -48);
    ctx.lineTo(0, 5);
    ctx.stroke();

    ctx.fillStyle = "#6d28d9";
    ctx.beginPath();
    ctx.roundRect ? ctx.roundRect(-7, 1, 14, 9, 3) : ctx.rect(-7, 1, 14, 9);
    ctx.fill();

    ctx.strokeStyle = "#e0a458";
    ctx.lineWidth = 3;
    for (let i = -6; i <= 6; i += 1) {
      ctx.beginPath();
      ctx.moveTo(i * 1.1, 9);
      ctx.lineTo(i * 2.7, 30 + Math.abs(i) * 0.6);
      ctx.stroke();
    }

    ctx.restore();
  }

  function startSweepLoop() {
    if (sweepRunning) {
      return;
    }
    sweepRunning = true;
    const step = () => {
      sweepCtx.clearRect(0, 0, sweepCanvas.width, sweepCanvas.height);

      sweepBrooms = sweepBrooms.filter((broom) => broom.life < broom.maxLife);
      sweepBrooms.forEach((broom) => {
        broom.life += 1;
        const t = broom.life / broom.maxLife;
        const eased = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
        const x = broom.x0 + (broom.x1 - broom.x0) * eased;
        const y = broom.y - Math.sin(t * Math.PI) * 8 * broom.scale;
        drawBroom(x, y, -0.5 + t * 1.05, broom.scale, Math.min(1, Math.sin(t * Math.PI) * 2.4));

        if (broom.kurz && broom.life % 2 === 0) {
          spawnDust(x - 12 * broom.scale, y + 26 * broom.scale, 3, broom.power);
        }
      });

      sweepMotes = sweepMotes.filter((p) => p.life < p.maxLife && p.y < window.innerHeight + 60);
      sweepMotes.forEach((p) => {
        p.life += 1;
        p.vy += 0.16;
        p.vx *= 0.975;
        p.x += p.vx;
        p.y += p.vy;
        p.rot += p.vr;

        sweepCtx.save();
        sweepCtx.globalAlpha = Math.max(0, 1 - p.life / p.maxLife) * 0.9;
        sweepCtx.translate(p.x, p.y);
        sweepCtx.rotate(p.rot);
        sweepCtx.fillStyle = p.color;

        if (p.iskra) {
          // Iskierka: krótki krzyżyk, żeby chmura kurzu nie była jednolita.
          sweepCtx.fillRect(-p.size, -p.size * 0.22, p.size * 2, p.size * 0.44);
          sweepCtx.fillRect(-p.size * 0.22, -p.size, p.size * 0.44, p.size * 2);
        } else {
          sweepCtx.beginPath();
          sweepCtx.arc(0, 0, p.size * 0.55, 0, Math.PI * 2);
          sweepCtx.fill();
        }

        sweepCtx.restore();
      });

      if (sweepMotes.length || sweepBrooms.length) {
        requestAnimationFrame(step);
      } else {
        sweepCtx.clearRect(0, 0, sweepCanvas.width, sweepCanvas.height);
        sweepRunning = false;
      }
    };
    requestAnimationFrame(step);
  }

  // Zamiecenie pojedynczego zadania. Punkt startu trzymamy w obrębie ekranu —
  // cząstki spoza widoku odsiewa filtr w pętli, więc animacja odpalona przy
  // karcie poniżej zgięcia w ogóle by się nie pokazała.
  function sweepBurst(x, y) {
    if (prefersReducedMotion()) {
      return;
    }
    ensureSweepCanvas();
    const bx = Math.min(Math.max(x, 70), window.innerWidth - 70);
    const by = Math.min(Math.max(y, 100), window.innerHeight - 130);
    spawnBroom(bx, by - 6, 210, { maxLife: 30, scale: 1, power: 6 });
    spawnDust(bx - 60, by + 16, 14, 6);
  }

  // Pełny ekran przy zdobyciu progu nagrody — kilka miotieł przez cały ekran.
  function sweepCelebration() {
    if (prefersReducedMotion()) {
      return;
    }
    ensureSweepCanvas();
    const w = window.innerWidth;
    const h = window.innerHeight;

    const fala = (delay, akcja) => window.setTimeout(akcja, delay);

    fala(0, () => {
      spawnBroom(w * 0.5, h * 0.42, w + 160, { maxLife: 44, scale: 1.5, power: 9 });
      spawnDust(w * 0.1, h * 0.5, 26, 9);
    });
    fala(220, () => spawnBroom(w * 0.5, h * 0.62, w + 160, { maxLife: 40, scale: 1.1, power: 7 }));
    fala(420, () => {
      spawnBroom(w * 0.5, h * 0.28, w + 160, { maxLife: 38, scale: 1.25, power: 8 });
      spawnDust(w * 0.2, h * 0.34, 22, 8);
    });
    fala(680, () => {
      spawnDust(w * 0.35, h * 0.55, 24, 7);
      spawnDust(w * 0.65, h * 0.48, 24, 7);
    });
  }

  /* ============ Przesuń w prawo, aby ukończyć ============ */
  // Uchwyt na górze arkusza sugerował, że da się go ściągnąć w dół — teraz
  // faktycznie się da. Przeciąganie startuje tylko, gdy treść jest na samej
  // górze, żeby nie odbierać zwykłego przewijania.
  const SHEET_CLOSE_DISTANCE = 110;
  let sheetDrag = null;

  function zamknijAktywneOkno() {
    if (rewardCelebration) {
      rewardCelebration = null;
      stopKonfetti();
      render();
      return true;
    }
    if (activeModal === "shopping-item") {
      activeModal = null;
      shoppingModalTaskId = null;
      render();
      return true;
    }
    if (activeModal) {
      activeModal = null;
      editingTaskId = null;
      taskModalKind = "standard";
      requestTaskId = null;
      votingRequestId = null;
      settingsPanel = null;
      render();
      return true;
    }
    return false;
  }

  function handleSheetStart(event) {
    if (event.touches.length !== 1) {
      return;
    }
    const sheet = event.target.closest(".modal, .reward-celebration-card");
    if (!sheet || window.innerWidth > 720) {
      return;
    }
    // Pola formularza mają swoje własne gesty — nie przejmujemy ich.
    if (event.target.closest("input, textarea, select")) {
      return;
    }
    if (sheet.scrollTop > 0) {
      return;
    }
    const t = event.touches[0];
    sheetDrag = { sheet, x: t.clientX, y: t.clientY, dy: 0, aktywny: false };
  }

  function handleSheetMove(event) {
    if (!sheetDrag || event.touches.length !== 1) {
      return;
    }
    const t = event.touches[0];
    const dx = t.clientX - sheetDrag.x;
    const dy = t.clientY - sheetDrag.y;

    if (!sheetDrag.aktywny) {
      if (Math.abs(dy) < 10 && Math.abs(dx) < 10) {
        return;
      }
      // Gest w bok albo w górę to nie zamykanie — odpuszczamy.
      if (dy <= 0 || Math.abs(dx) > Math.abs(dy)) {
        sheetDrag = null;
        return;
      }
      sheetDrag.aktywny = true;
      sheetDrag.sheet.style.transition = "none";
      // Animacja wejścia ma fill-mode: both, więc jej końcowy transform
      // wygrywa w kaskadzie ze stylem inline i arkusz nie ruszałby się
      // za palcem. Na czas gestu ją zdejmujemy.
      sheetDrag.sheet.style.animation = "none";
    }

    if (event.cancelable) {
      event.preventDefault();
    }
    sheetDrag.dy = Math.max(0, dy);
    sheetDrag.sheet.style.transform = `translateY(${sheetDrag.dy}px)`;
  }

  function handleSheetEnd() {
    if (!sheetDrag) {
      return;
    }
    const { sheet, dy, aktywny } = sheetDrag;
    sheetDrag = null;
    if (!aktywny) {
      return;
    }
    sheet.style.transition = "";
    if (dy < SHEET_CLOSE_DISTANCE) {
      sheet.style.transform = "";
      sheet.style.animation = "";
      return;
    }
    // Arkusz zjeżdża do końca, dopiero potem znika — bez tego okno
    // przepadało w jednej klatce.
    sheet.style.transform = `translateY(${Math.max(sheet.offsetHeight, dy)}px)`;
    const zamknij = () => {
      sheet.removeEventListener("transitionend", zamknij);
      zamknijAktywneOkno();
    };
    sheet.addEventListener("transitionend", zamknij);
    window.setTimeout(zamknij, 320);
  }

  // touchmove NIE może być pasywny: dopóki nie zablokujemy zdarzenia, przy
  // ciągnięciu arkusza przeglądarka przewija to, co jest pod spodem.
  document.addEventListener("touchstart", handleSheetStart, { passive: true });
  document.addEventListener("touchmove", handleSheetMove, { passive: false });
  document.addEventListener("touchend", handleSheetEnd, { passive: true });
  document.addEventListener("touchcancel", handleSheetEnd, { passive: true });

  const SWIPE_THRESHOLD = 96;
  let swipe = null;

  function handleSwipeStart(event) {
    if (event.touches.length !== 1 || prefersReducedMotion()) {
      return;
    }

    const card = event.target.closest(".task-card");
    // Gest ma sens tylko tam, gdzie przycisk ukończenia jest aktywny — inaczej
    // karta jechałaby na zielono, a completeTask() i tak by ją odrzucił.
    const check = card?.querySelector("[data-action='complete-task']:not([disabled])");
    if (!card || !check) {
      return;
    }

    swipe = {
      card,
      taskId: check.dataset.taskId,
      startX: event.touches[0].clientX,
      startY: event.touches[0].clientY,
      dx: 0,
      kierunek: null
    };
  }

  function handleSwipeMove(event) {
    if (!swipe || event.touches.length !== 1) {
      return;
    }

    const dx = event.touches[0].clientX - swipe.startX;
    const dy = event.touches[0].clientY - swipe.startY;

    // Zanim cokolwiek ruszymy, rozstrzygamy czy to przewijanie czy gest w bok.
    if (!swipe.kierunek) {
      if (Math.abs(dx) < 10 && Math.abs(dy) < 10) {
        return;
      }
      swipe.kierunek = Math.abs(dx) > Math.abs(dy) ? "poziomo" : "pionowo";
      if (swipe.kierunek === "poziomo") {
        swipe.card.classList.add("is-swiping");
      }
    }

    if (swipe.kierunek !== "poziomo") {
      return;
    }

    swipe.dx = Math.max(0, dx);
    swipe.card.style.transform = `translateX(${swipe.dx}px)`;
    swipe.card.classList.toggle("is-swipe-ready", swipe.dx > SWIPE_THRESHOLD);
  }

  function handleSwipeEnd() {
    if (!swipe) {
      return;
    }

    const { card, taskId, dx, kierunek } = swipe;
    swipe = null;

    if (kierunek !== "poziomo") {
      return;
    }

    card.classList.remove("is-swiping", "is-swipe-ready");
    card.style.transform = "";

    if (dx > SWIPE_THRESHOLD) {
      completeTaskWithFlourish(taskId, card);
    }
  }

  // completeTask() przebudowuje ekran i niszczy kartę, więc potwierdzenie musi
  // zagrać na istniejącym elemencie, zanim oddamy sterowanie. Miotła przejeżdża
  // przy każdym ukończeniu — także z widoku szczegółów, gdzie karty nie ma.
  function completeTaskWithFlourish(taskId, card, origin) {
    if (prefersReducedMotion()) {
      completeTask(taskId);
      return;
    }

    const zrodlo = card || origin;
    if (zrodlo) {
      const rect = zrodlo.getBoundingClientRect();
      sweepBurst(rect.left + rect.width / 2, rect.top + rect.height / 2);
    }

    if (!card) {
      completeTask(taskId);
      return;
    }

    card.classList.add("is-completing");
    window.setTimeout(() => completeTask(taskId), 320);
  }

  function growProgressBars() {
    const bars = app.querySelectorAll("[data-grow]");
    if (!bars.length) {
      return;
    }
    requestAnimationFrame(() => {
      bars.forEach((bar) => {
        bar.style.width = `${bar.dataset.grow}%`;
      });
    });
  }

  // Liczby doliczają się tylko wtedy, gdy naprawdę się zmieniły. Bez tego każde
  // przerysowanie (a jest ich sporo, także z timerów) startowałoby licznik od nowa.
  function animateCounters() {
    const nodes = app.querySelectorAll("[data-count]");
    nodes.forEach((node) => {
      const key = node.dataset.count;
      const target = Number(node.dataset.countTo);
      if (!Number.isFinite(target)) {
        return;
      }

      const previous = countedValues.get(key);
      countedValues.set(key, target);

      if (previous === undefined || previous === target || prefersReducedMotion()) {
        node.textContent = formatPoints(target);
        return;
      }

      const start = previous;
      const startedAt = performance.now();
      const duration = 620;

      const tick = (now) => {
        const progress = Math.min(1, (now - startedAt) / duration);
        const eased = 1 - Math.pow(1 - progress, 3);
        node.textContent = formatPoints(Math.round((start + (target - start) * eased) * 10) / 10);
        if (progress < 1) {
          requestAnimationFrame(tick);
        }
      };
      requestAnimationFrame(tick);
    });
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

        <nav class="nav ${moreMenuOpen ? "is-more-open" : ""}" aria-label="Nawigacja">
          ${navButton("dashboard", "⌂", "Dashboard", "nav-primary")}
          ${navButton("tasks", "☰", "Lista", "nav-primary")}
          ${navButton("calendar", "◱", "Kalendarz", "nav-primary")}
          ${navButton("team", "◎", "Domownicy", "nav-overflow")}
          ${navButton("reminders", "◉", "Przypomnienia", "nav-overflow")}
          ${navButton("activity", "↻", "Aktywność", "nav-overflow")}
          ${navButton("rewards", "★", "Punkty", "nav-overflow")}
          <button class="nav-button nav-more-button ${isMoreViewActive() ? "is-active" : ""}" type="button" data-action="toggle-more-menu" aria-expanded="${moreMenuOpen ? "true" : "false"}">
            <span class="nav-icon" aria-hidden="true">⋯</span>
            <span>Więcej</span>
          </button>
          <div class="more-menu-panel">
            ${navButton("team", "◎", "Domownicy", "more-menu-item")}
            ${navButton("reminders", "◉", "Przypomnienia", "more-menu-item")}
            ${navButton("activity", "↻", "Aktywność", "more-menu-item")}
            ${navButton("rewards", "★", "Punkty", "more-menu-item")}
          </div>
        </nav>

      </aside>
    `;
  }

  function navButton(id, icon, label, className = "") {
    const isActive = activeView === id || (id === "tasks" && activeView === "task-detail");
    return `
      <button class="nav-button ${className} ${isActive ? "is-active" : ""}" type="button" data-action="view" data-view="${id}">
        <span class="nav-icon" aria-hidden="true">${icon}</span>
        <span>${label}</span>
      </button>
    `;
  }

  function isMoreViewActive() {
    return ["team", "reminders", "activity", "rewards"].includes(activeView);
  }

  function renderPersonRow(user) {
    return `
      <div class="person-row">
        <div class="person-main">
          ${avatar(user)}
          <div class="person-name">${escapeHtml(user.name)}</div>
        </div>
        <div class="person-points">${formatPoints(getUserPoints(user.id))} pkt</div>
      </div>
    `;
  }

  function renderTopbar(currentUser) {
    const unreadCount = getVisibleNotifications().filter((item) => !item.read).length;

    return `
      <header class="topbar">
        <div class="topbar-brand">
          <div class="brand-mark" aria-hidden="true"><span class="brand-broom">🧹</span><span class="brand-dust"></span></div>
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
          <button class="button shopping-button" type="button" data-action="open-shopping-modal">
            <span class="action-icon" aria-hidden="true">＋</span>
            <span>Zakupy</span>
          </button>
        </div>
      </header>
    `;
  }

  function renderHouseholdBadge() {
    const isPaused = isHouseholdPausedNow() || state.users.some((user) => isUserAbsentNow(user.id));
    const hasPause = Boolean(state.household.pause) || state.users.some((user) => user.absence);

    return `
      <div class="household-badge household-badge-row">
        <button class="household-switch-button" type="button" data-action="change-household" aria-label="Zmień gospodarstwo">
          <strong>${escapeHtml(state.household.name)}</strong>
          <span class="household-meta">${state.users.length} ${
            state.users.length === 1 ? "domownik" : "domowników"
          } · </span><span class="household-code">${escapeHtml(state.household.inviteCode)}</span>
        </button>
        <button
          class="icon-button household-pause-button ${hasPause ? "is-active" : ""}"
          type="button"
          data-action="open-settings"
          aria-label="Ustawienia"
          title="${isPaused ? "Ustawienia — zadania wstrzymane" : "Ustawienia"}"
        >
          <span class="gear-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">
              <circle cx="12" cy="12" r="3.1" />
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9v.09a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
            </svg>
          </span>
        </button>
      </div>
    `;
  }

  function renderLoggedOutScreen() {
    return `
      <main class="login-page">
        <section class="login-card onboarding-card">
          <div class="topbar-brand">
            <div class="brand-mark" aria-hidden="true"><span class="brand-broom">🧹</span><span class="brand-dust"></span></div>
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
                    ${escapeHtml(user.name)} - ${formatPoints(getUserPoints(user.id))} pkt
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

  const PANELE_ADMINA = ["dzien", "progi"];

  function renderSettingsModal() {
    if (settingsPanel === "admin-pin") {
      return renderAdminPinPanel();
    }
    if (settingsPanel === "dzien") {
      return renderDayLengthPanel();
    }
    if (settingsPanel === "progi") {
      return renderThresholdsPanel();
    }

    const pauzaAktywna = Boolean(state.household.pause) || state.users.some((user) => user.absence);
    const zamek = () =>
      adminUnlocked
        ? `<span class="settings-lock is-open" title="Odblokowane">🔓</span>`
        : `<span class="settings-lock" title="Tylko admin domu">🔒</span>`;
    const start = getDayStartHour();
    const koniec = getDayEndHour();
    const progi = getRewardThresholds().map((prog) => prog.points).join(" · ");

    return `
      <div class="modal-backdrop" role="presentation" data-action="close-modal">
        <section class="modal modal-slim" role="dialog" aria-modal="true" aria-labelledby="settings-title">
          <div class="modal-head">
            <h2 class="modal-title" id="settings-title">Ustawienia</h2>
            <button class="icon-button" type="button" data-action="close-modal" aria-label="Zamknij">×</button>
          </div>
          <div class="settings-tiles">
            <button class="settings-tile" type="button" data-action="open-pause-modal">
              <span class="settings-tile-icon" aria-hidden="true">🏝️</span>
              <span class="settings-tile-body">
                <strong>Urlop i wstrzymanie</strong>
                <small>${pauzaAktywna ? "Aktywne — ktoś jest nieobecny" : "Nikt nie jest nieobecny"}</small>
              </span>
              <span class="settings-tile-arrow" aria-hidden="true">›</span>
            </button>
            <button class="settings-tile" type="button" data-action="settings-panel" data-panel="dzien">
              <span class="settings-tile-icon" aria-hidden="true">🕑</span>
              <span class="settings-tile-body">
                <strong>Trwanie dnia ${zamek()}</strong>
                <small>${formatHour(start)} — ${formatHour(koniec)}</small>
              </span>
              <span class="settings-tile-arrow" aria-hidden="true">›</span>
            </button>
            <button class="settings-tile" type="button" data-action="settings-panel" data-panel="progi">
              <span class="settings-tile-icon" aria-hidden="true">🎁</span>
              <span class="settings-tile-body">
                <strong>Progi punktowe ${zamek()}</strong>
                <small>${progi} pkt</small>
              </span>
              <span class="settings-tile-arrow" aria-hidden="true">›</span>
            </button>
          </div>
        </section>
      </div>
    `;
  }

  function renderAdminPinPanel() {
    const ustawiony = Boolean(state.household.adminPin);
    return `
      <div class="modal-backdrop" role="presentation" data-action="close-modal">
        <section class="modal modal-slim" role="dialog" aria-modal="true" aria-labelledby="admin-pin-title">
          <div class="modal-head">
            <h2 class="modal-title" id="admin-pin-title">
              <button class="icon-button" type="button" data-action="settings-panel" data-panel="" aria-label="Wróć">‹</button>
              ${ustawiony ? "PIN admina" : "Ustaw PIN admina"}
            </h2>
            <button class="icon-button" type="button" data-action="close-modal" aria-label="Zamknij">×</button>
          </div>
          <form class="task-form" data-form="admin-pin">
            <div class="form-grid">
              <label class="wide">
                <span class="label">${ustawiony ? "Podaj PIN admina" : "Nowy PIN admina (4 cyfry)"}</span>
                <input
                  class="input"
                  type="password"
                  name="adminPin"
                  inputmode="numeric"
                  pattern="[0-9]{4}"
                  maxlength="4"
                  autocomplete="off"
                  required
                />
              </label>
              <span class="form-hint wide">
                ${
                  ustawiony
                    ? "Trwanie dnia i progi punktowe zmienia tylko admin domu. Urlop pozostaje dostępny dla każdego."
                    : "Ten PIN chroni ustawienia wpływające na punkty całego domu. Zapamiętaj go — bez niego nikt nie zmieni progów ani godzin."
                }
              </span>
            </div>
            <div class="form-actions">
              <button class="ghost-button" type="button" data-action="settings-panel" data-panel="">Anuluj</button>
              <button class="button" type="submit">${ustawiony ? "Odblokuj" : "Ustaw PIN"}</button>
            </div>
          </form>
        </section>
      </div>
    `;
  }

  function formatHour(h) {
    return `${String(h).padStart(2, "0")}:00`;
  }

  function hourOptions(selected) {
    return Array.from({ length: 24 }, (_, h) =>
      `<option value="${h}" ${h === selected ? "selected" : ""}>${formatHour(h)}</option>`
    ).join("");
  }

  function renderDayLengthPanel() {
    return `
      <div class="modal-backdrop" role="presentation" data-action="close-modal">
        <section class="modal modal-slim" role="dialog" aria-modal="true" aria-labelledby="day-title">
          <div class="modal-head">
            <h2 class="modal-title" id="day-title">
              <button class="icon-button" type="button" data-action="settings-panel" data-panel="" aria-label="Wróć">‹</button>
              Trwanie dnia
            </h2>
            <button class="icon-button" type="button" data-action="close-modal" aria-label="Zamknij">×</button>
          </div>
          <form class="task-form" data-form="day-length">
            <div class="form-grid">
              <label>
                <span class="label">Dzień zaczyna się o</span>
                <select class="input" name="dayStart">${hourOptions(getDayStartHour())}</select>
              </label>
              <label>
                <span class="label">Dzień kończy się o</span>
                <select class="input" name="dayEnd">${hourOptions(getDayEndHour())}</select>
              </label>
              <span class="form-hint wide">
                Liczy się godzina startu: przy 02:00 zadanie odhaczone o 01:30 wciąż należy do dnia poprzedniego,
                a zadania na jutro pojawią się dopiero po drugiej w nocy. Ta sama godzina po obu stronach to zwykła doba.
              </span>
            </div>
            <div class="form-actions">
              <button class="ghost-button" type="button" data-action="settings-panel" data-panel="">Wróć</button>
              <button class="button" type="submit">Zapisz</button>
            </div>
          </form>
        </section>
      </div>
    `;
  }

  function renderThresholdsPanel() {
    const progi = getRewardThresholds();
    return `
      <div class="modal-backdrop" role="presentation" data-action="close-modal">
        <section class="modal modal-slim" role="dialog" aria-modal="true" aria-labelledby="thresholds-title">
          <div class="modal-head">
            <h2 class="modal-title" id="thresholds-title">
              <button class="icon-button" type="button" data-action="settings-panel" data-panel="" aria-label="Wróć">‹</button>
              Progi punktowe
            </h2>
            <button class="icon-button" type="button" data-action="close-modal" aria-label="Zamknij">×</button>
          </div>
          <form class="task-form" data-form="thresholds">
            <div class="form-grid">
              ${progi
                .map(
                  (prog, i) => `
                    <label>
                      <span class="label">${escapeHtml(prog.label)}</span>
                      <input class="input" type="number" name="prog${i}" value="${prog.points}" min="10" max="5000" step="10" required />
                    </label>
                  `
                )
                .join("")}
              <span class="form-hint wide">
                Progi muszą rosnąć. Zmiana działa od razu dla wszystkich domowników —
                nagrody już przyznane w tym miesiącu zostają.
              </span>
            </div>
            <div class="form-actions">
              <button class="ghost-button" type="button" data-action="settings-panel" data-panel="">Wróć</button>
              <button class="button" type="submit">Zapisz</button>
            </div>
          </form>
        </section>
      </div>
    `;
  }

  function renderPauseModal() {
    const today = todayIso();
    // Domyślnie edytujemy to, co już trwa: własną nieobecność albo pauzę domu.
    const wlasna = getUserAbsence(state.currentUserId);
    const zakres = pauseModalTarget === "dom" ? state.household.pause : getUserAbsence(pauseModalTarget);
    const values = {
      from: zakres?.from || today,
      until: zakres?.until || today
    };
    const edycja = Boolean(zakres);

    const opcje = [
      { id: "dom", nazwa: "Cały dom", aktywna: Boolean(state.household.pause) },
      ...state.users.map((user) => ({ id: user.id, nazwa: user.name, aktywna: Boolean(user.absence) }))
    ];

    return `
      <div class="modal-backdrop" role="presentation" data-action="close-modal">
        <section class="modal" role="dialog" aria-modal="true" aria-labelledby="pause-modal-title">
          <div class="modal-head">
            <h2 class="modal-title" id="pause-modal-title">${edycja ? "Edytuj nieobecność" : "Wstrzymaj zadania"}</h2>
            <button class="icon-button" type="button" data-action="close-modal" aria-label="Zamknij">×</button>
          </div>
          <form class="task-form" data-form="pause">
            <div class="form-grid">
              <label class="wide">
                <span class="label">Kogo dotyczy</span>
                <div class="weekday-picker">
                  ${opcje
                    .map(
                      (opcja) => `
                        <button
                          class="chip weekday-chip ${opcja.id === pauseModalTarget ? "is-active" : ""}"
                          type="button"
                          data-action="pause-target"
                          data-target="${opcja.id}"
                        >${escapeHtml(opcja.nazwa)}${opcja.aktywna ? " ●" : ""}</button>
                      `
                    )
                    .join("")}
                </div>
              </label>
              <label>
                <span class="label">Od</span>
                <input class="input" type="date" name="pauseFrom" value="${escapeAttribute(values.from)}" required />
              </label>
              <label>
                <span class="label">Do</span>
                <input class="input" type="date" name="pauseUntil" value="${escapeAttribute(values.until)}" required />
              </label>
              <input type="hidden" name="pauseTarget" value="${escapeAttribute(pauseModalTarget)}" />
              <span class="form-hint wide">${
                pauseModalTarget === "dom"
                  ? "Cały dom odpoczywa: nikt nie dostaje przypomnień, nikomu nie rosną zaległości."
                  : "Ta osoba nie dostaje przypomnień i nie zbiera kar za zwłokę. Rotacja zadań cyklicznych ją omija, a kto przejmie jej zadanie, robi to jako zastępstwo — bez transferu punktów."
              }</span>
            </div>
            ${
              edycja
                ? `<div class="status-line" style="margin-top: 12px">
                    <button class="ghost-button" type="button" data-action="resume-household">Wznów teraz</button>
                  </div>`
                : ""
            }
            <div class="form-actions">
              <button class="ghost-button" type="button" data-action="close-modal">Anuluj</button>
              <button class="button" type="submit">${edycja ? "Zapisz zmiany" : "Wstrzymaj"}</button>
            </div>
          </form>
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
    const mineToday = state.tasks.filter((task) => isAssignee(task, state.currentUserId) && isToday(task) && isOpen(task));
    const mineOverdue = state.tasks.filter(
      (task) => isAssignee(task, state.currentUserId) && isOverdue(task) && !isAbandonedByAbsence(task)
    );
    const homeOverdue = state.tasks.filter((task) => isOverdue(task));
    const homeToday = state.tasks.filter((task) => isToday(task) && isOpen(task));
    const weeklyPoints = getUserPoints(state.currentUserId, 7);

    return `
      <section class="view">
        ${renderDashboardHero(mineToday, mineOverdue, homeToday, weeklyPoints)}

        ${renderDashboardVotes()}

        ${renderDashboardOverdue(mineOverdue, homeOverdue)}

        <section class="section-block">
          <div class="section-head">
            <h2>Mini ranking</h2>
            <button class="chip" type="button" data-action="view" data-view="rewards">Pełny ranking</button>
          </div>
          ${renderMiniLeaderboard()}
          ${renderPointResetNote()}
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
      </section>
    `;
  }

  function renderDashboardHero(mineToday, mineOverdue, homeToday, weeklyPoints) {
    const currentUser = getCurrentUser();
    const hour = new Date().getHours();
    const greeting = hour < 5 ? "Dobrej nocy" : hour < 12 ? "Dzień dobry" : hour < 18 ? "Miłego dnia" : "Dobry wieczór";
    const doneToday = getUserTaskCounts(state.currentUserId).today;
    const totalToday = doneToday + mineToday.length;
    const percent = totalToday ? Math.round((doneToday / totalToday) * 100) : 100;
    const headline = mineToday.length
      ? `Masz dziś ${mineToday.length} ${mineToday.length === 1 ? "zadanie" : mineToday.length < 5 ? "zadania" : "zadań"}`
      : doneToday
        ? "Wszystko na dziś zrobione"
        : "Dziś nic nie zaplanowano";

    return `
      <section class="hero">
        <p class="hero-eyebrow">${greeting}, ${escapeHtml(currentUser.name)}</p>
        <h2 class="hero-title">${headline}</h2>
        <div class="hero-progress">
          <div class="hero-progress-label">
            <span><strong>${doneToday}</strong> z ${totalToday} na dziś</span>
            <span>${percent}%</span>
          </div>
          <div class="hero-progress-track">
            <span class="hero-progress-fill" data-grow="${percent}" style="width:0%"></span>
          </div>
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

  // Zaległości muszą być widoczne od razu po wejściu — sam licznik w kaflu
  // nie wystarczał, bo lista zaległych żyła wyłącznie w filtrze na innym ekranie.
  function renderDashboardOverdue(mineOverdue, homeOverdue) {
    if (!homeOverdue.length) {
      return "";
    }

    const mineIds = new Set(mineOverdue.map((task) => task.id));
    const pozostale = homeOverdue.filter((task) => !mineIds.has(task.id));
    const uporzadkowane = [...sortTasks(mineOverdue), ...sortTasks(pozostale)];

    return `
      <section class="section-block overdue-section">
        <div class="section-head">
          <h2>Zaległe${mineOverdue.length ? ` · Twoje: ${mineOverdue.length}` : ""}</h2>
          <button class="chip" type="button" data-action="quick-filter" data-filter="overdue">Pełna lista</button>
        </div>
        ${renderTaskList(uporzadkowane.slice(0, 6), "Bez zaległości", "Nic nie zostało z poprzednich dni.")}
      </section>
    `;
  }

  function renderDashboardVotes() {
    const pending = getPendingRequests();
    if (!pending.length) {
      return "";
    }

    const doGlosowania = pending.filter((request) => !hasVoted(request, state.currentUserId));
    const lista = doGlosowania.length ? doGlosowania : pending;

    return `
      <section class="section-block votes-section">
        <div class="section-head">
          <h2>${doGlosowania.length ? "Czekają na Twój głos" : "Wnioski w głosowaniu"}</h2>
        </div>
        <div class="reward-task-list">
          ${lista
            .map((request) => {
              const author = getUser(request.requestedById);
              const opis =
                request.type === "skip"
                  ? "nie ma potrzeby"
                  : `przełożenie na ${formatHumanDate(request.proposedDueDate)}`;
              return `
                <button class="reward-task-card" type="button" data-action="select-task" data-task-id="${request.taskId}">
                  ${avatar(author, "small")}
                  <span>
                    <strong>${escapeHtml(request.taskTitle)} · ${opis}</strong>
                    <small>${escapeHtml(author.name)}: ${escapeHtml(request.reason)}</small>
                  </span>
                </button>
              `;
            })
            .join("")}
        </div>
      </section>
    `;
  }

  function renderDashboardRewardTasks() {
    const rewardItems = state.rewardClaims
      .filter((claim) => claim.status !== "done")
      .map((claim) => ({ claim, task: getTask(claim.taskId), rewardedUser: getUser(claim.userId) }));

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
              const targetAttributes = task
                ? `data-action="select-task" data-task-id="${task.id}"`
                : `data-action="view" data-view="rewards"`;
              const taskMeta = task
                ? `Próg ${claim.threshold} pkt · termin ${formatHumanDate(task.dueDate)}`
                : `Próg ${claim.threshold} pkt · sprawdź w zakładce Punkty`;

              return `
                <button class="reward-task-card" type="button" ${targetAttributes}>
                  ${avatar(rewardedUser, "small")}
                  <span>
                    <strong>${escapeHtml(rewardedUser.name)} czeka na nagrodę</strong>
                    <small>${taskMeta}</small>
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
        <span class="metric-value" data-count="metric-${target}" data-count-to="${value}">${value}</span>
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
                </span>
                <span class="rank-points">${formatPoints(row.points)} pkt</span>
                ${renderRewardAxis(row.points, "compact", row.user.id)}
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
            ${filterButton("done-today", "Ukończone dziś")}
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

    const shopping = isShoppingTask(task);

    return `
      <section class="view task-detail-view">
        <div class="section-head detail-screen-head">
          <button class="ghost-button back-button" type="button" data-action="back-to-tasks">← Wróć do listy</button>
          <span class="pill ${task.status === "done" ? "done" : shopping ? "blue" : PRIORITY[task.priority].className}">
            ${task.status === "done" ? "Ukończone" : shopping ? "Zakupy" : PRIORITY[task.priority].label}
          </span>
        </div>
        ${shopping ? renderShoppingChecklist(task, "top") : ""}
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
    const rangeStart = days[0].iso;
    const rangeEnd = days[days.length - 1].iso;
    const projectedByDay = getProjectedOccurrencesByDay(rangeStart, rangeEnd);
    const selectedTasks = sortTasks(state.tasks.filter((task) => task.dueDate === selectedDate));
    const projectedForSelectedDay = projectedByDay.get(selectedDate) || [];
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
              ${days.map((day) => renderDayCell(day, projectedByDay.get(day.iso) || [])).join("")}
            </div>
          </section>

          <section class="section-block">
            <div class="section-head">
              <h2>${formatHumanDate(selectedDate)}</h2>
            </div>
            ${renderTaskList(selectedTasks, "Ten dzień jest pusty", "Nie ma tu jeszcze zadań.")}
            ${renderProjectedTaskList(projectedForSelectedDay)}
          </section>
        </div>
      </section>
    `;
  }

  function renderDayCell(day, projectedTasks = []) {
    const tasks = state.tasks.filter((task) => task.dueDate === day.iso);
    const allTasks = [...tasks, ...projectedTasks];
    const visibleDots = allTasks.slice(0, 5);
    const className = [
      "day-cell",
      day.inMonth ? "" : "is-muted",
      day.iso === todayIso() ? "is-today" : "",
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
                `<span class="dot ${task.status === "done" ? "done" : PRIORITY[task.priority].className} ${
                  task.isProjected ? "is-projected" : ""
                }" aria-hidden="true"></span>`
            )
            .join("")}
        </span>
        ${allTasks.length ? `<span class="day-count">${allTasks.length} zad.</span>` : ""}
      </button>
    `;
  }

  function renderTeamView() {
    const openTasks = state.tasks.filter((task) => task.status === "open");

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
              const assigned = openTasks.filter((task) => isAssignee(task, user.id));
              const nieobecny = isUserAbsentNow(user.id);
              const overdue = assigned.filter((task) => isOverdue(task)).length;
              const today = assigned.filter((task) => isToday(task)).length;
              return `
                <article class="person-card${nieobecny ? " is-away" : ""}">
                  <div class="person-card-head">
                    ${avatar(user)}
                    <div>
                      <h3>${escapeHtml(user.name)}</h3>
                      <p>${formatPoints(getUserPoints(user.id))} pkt w tym miesiącu</p>
                    </div>
                  </div>
                  ${
                    nieobecny
                      ? `<p class="away-note">Nieobecny${
                          user.absence ? ` do ${formatHumanDate(user.absence.until)}` : ""
                        } — zadania bez przypomnień i bez kar</p>`
                      : ""
                  }
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
                        <button class="notification-item" type="button" data-action="${
                      item.kind === "reward" || item.kind === "bonus" ? "open-reward-celebration" : "select-task"
                    }" data-task-id="${item.taskId}" data-notification-id="${item.id}">
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
          ${metric(formatPoints(getUserPoints(currentUser.id)), `Punkty: ${escapeHtml(currentUser.name)}`)}
          ${metric(formatPoints(getUserPoints(currentUser.id, 7)), "Moje 7 dni")}
          ${metric(completedThisWeek.length, "Zrobione w 7 dni")}
          ${metric(totalDone, "Zrobione łącznie")}
        </div>

        <div class="content-grid">
          <section class="section-block">
            <div class="section-head">
              <h2>Ranking</h2>
            </div>
            ${renderLeaderboard()}
            ${renderTaskCountSummary()}
            ${renderPointRulesNote()}
          </section>

          <section class="section-block">
            <div class="section-head">
              <h2>Ostatnie ukończenia</h2>
            </div>
            ${renderTaskList(
              sortByCompletedDesc(state.tasks.filter((task) => task.status === "done")).slice(0, RECENT_DONE_LIMIT),
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
            ${getRewardThresholds().map((threshold) =>
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

  function renderProjectedTaskList(occurrences) {
    if (!occurrences.length) {
      return "";
    }

    return `
      <div class="task-list projected-task-list">
        ${occurrences.map((occurrence) => renderProjectedTaskCard(occurrence)).join("")}
      </div>
    `;
  }

  function renderProjectedTaskCard(occurrence) {
    return `
      <article class="task-card is-projected">
        <span class="task-check" aria-hidden="true">↻</span>
        <div>
          <h3 class="task-title">${escapeHtml(occurrence.title)}</h3>
          <div class="task-meta">
            ${renderAssigneeAvatars(occurrence)}
            <span>${formatAssigneeNames(occurrence)}</span>
            <span>•</span>
            <span>${formatHumanDate(occurrence.dueDate)}</span>
            <span>•</span>
            <span>${occurrence.reminderTime}</span>
          </div>
          <div class="task-meta" style="margin-top: 7px">
            <span class="pill ${PRIORITY[occurrence.priority].className}">${PRIORITY[occurrence.priority].label}</span>
            <span class="pill blue">Zaplanowane</span>
          </div>
        </div>
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

  function renderAbsenceWarning(task) {
    if (!isAbandonedByAbsence(task) || !isOverdue(task)) {
      return "";
    }
    const nieobecni = getAssignees(task).map((user) => user.name).join(", ");
    const odmiana = getAssigneeIds(task).length > 1 ? "są nieobecni" : "jest nieobecny";
    return `
      <p class="absence-warning">
        <strong>${escapeHtml(nieobecni)} ${odmiana}.</strong>
        Jeśli nikt nie przejmie tego zadania, karę za zwłokę poniesie cały dom.
      </p>
    `;
  }

  function renderTaskCard(task) {
    const assignees = getAssignees(task);
    const shopping = isShoppingTask(task);
    const closed = task.status === "done" || isSkipped(task);
    const completeDisabled = closed || !isAssignee(task, state.currentUserId) || (shopping && !isShoppingResolved(task));
    const meta = [
      shopping
        ? `<span class="pill blue">Zakupy</span>`
        : `<span class="pill ${PRIORITY[task.priority].className}">${PRIORITY[task.priority].label}</span>`,
      isOverdue(task) ? `<span class="pill overdue">Zaległe</span>` : "",
      task.status === "done" ? `<span class="pill done">Ukończone</span>` : "",
      isSkipped(task) ? `<span class="pill skipped">Nie było potrzeby</span>` : "",
      !closed && getAssigneeIds(task).some((id) => isUserAbsentNow(id))
        ? `<span class="pill away">${escapeHtml(
            getAssignees(task).filter((user) => isUserAbsentNow(user.id)).map((user) => user.name).join(", ")
          )} — nieobecny</span>`
        : "",
      getPendingRequestForTask(task.id) ? `<span class="pill amber">Głosowanie</span>` : "",
      assignees.length > 1 ? `<span class="pill blue">${assignees.length} osoby</span>` : "",
      task.recurrence.type !== "none" ? `<span class="pill blue">${RECURRENCE[task.recurrence.type]}</span>` : ""
    ]
      .filter(Boolean)
      .join("");

    return `
      <div class="task-row${completeDisabled ? "" : " is-swipeable"}">
      ${completeDisabled ? "" : `<span class="swipe-reveal" aria-hidden="true">Ukończone ✓</span>`}
      <article class="task-card ${closed ? "is-done" : ""} ${isSkipped(task) ? "is-skipped" : ""} ${
      selectedTaskId === task.id ? "is-selected" : ""
    }">
        <button class="task-check" type="button" data-action="complete-task" data-task-id="${task.id}" ${
      completeDisabled ? "disabled" : ""
    } aria-label="Oznacz jako ukończone">✓</button>
        <div>
          <h3 class="task-title">${escapeHtml(task.title)}</h3>
          <div class="task-meta">
            ${renderAssigneeAvatars(task)}
            <span>${formatAssigneeNames(task)}</span>
            <span>•</span>
            <span>${formatHumanDate(task.dueDate)}</span>
            <span>•</span>
            <span>${task.reminderTime}</span>
            ${shopping ? `<span>•</span><span>${renderShoppingShortSummary(task)}</span>` : ""}
          </div>
          <div class="task-meta" style="margin-top: 7px">${meta}</div>
          ${renderAbsenceWarning(task)}
        </div>
        <div class="task-actions">
          ${
            !isAssignee(task, state.currentUserId) && !closed
              ? `<button class="quick-button" type="button" data-action="assign-me" data-task-id="${task.id}" aria-label="Przepisz na mnie">↙</button>`
              : ""
          }
          <button class="quick-button ${shopping ? "shopping-expand-button" : ""}" type="button" data-action="select-task" data-task-id="${
            task.id
          }" aria-label="${shopping ? "Rozwiń listę zakupów" : "Szczegóły"}">${
            shopping ? "Rozwiń listę zakupów" : "›"
          }</button>
        </div>
      </article>
      </div>
    `;
  }

  function renderInspector() {
    const task = state.tasks.find((item) => item.id === selectedTaskId);
    if (!task) {
      return renderInspectorFallback();
    }

    const creator = getUser(task.createdById);
    const closed = task.status === "done" || isSkipped(task);
    const canComplete = !closed && isAssignee(task, state.currentUserId);
    const overdueDays = getOverdueDays(task);
    const shopping = isShoppingTask(task);
    const statusPill = task.status === "done" ? "done" : isSkipped(task) ? "skipped" : shopping ? "blue" : PRIORITY[task.priority].className;
    const statusLabel = task.status === "done" ? "Ukończone" : isSkipped(task) ? "Nie było potrzeby" : shopping ? "Zakupy" : PRIORITY[task.priority].label;
    const pendingRequest = getPendingRequestForTask(task.id);

    return `
      <div class="inspector-stack">
        ${renderRequestPanel(task)}
        <section class="detail-card">
          <div class="section-head">
            <h2>Szczegóły</h2>
            <span class="pill ${statusPill}">${statusLabel}</span>
          </div>
          <h3 class="detail-title">${escapeHtml(task.title)}</h3>
          <div>
            ${detailRow("Osoba", `${renderAssigneeAvatars(task)}<span>${formatAssigneeNames(task)}</span>`)}
            ${detailRow("Termin", formatHumanDate(task.dueDate))}
            ${detailRow("Przypomn.", task.reminderTime)}
            ${detailRow("Punkty", getTaskPointsLabel(task))}
            ${overdueDays ? detailRow("Zwłoka", `${overdueDays} dni · -${overdueDays * 10} pkt`) : ""}
            ${detailRow(
              "Cykl",
              `${RECURRENCE[task.recurrence.type]}${task.recurrence.rotate ? " · rotacja" : ""}${
                task.recurrence.skipWeekdays?.length
                  ? ` · pomija: ${task.recurrence.skipWeekdays.map((day) => WEEKDAY_LABELS[day]).join(", ")}`
                  : ""
              }`
            )}
            ${detailRow("Autor", escapeHtml(creator.name))}
          </div>

          <div class="split-actions">
            ${
              closed
                ? `<button class="ghost-button" type="button" data-action="reopen-task" data-task-id="${task.id}">${
                    isSkipped(task) ? "Cofnij brak potrzeby" : "Cofnij ukończenie"
                  }</button>`
                : canComplete
                  ? `<button class="button" type="button" data-action="complete-task" data-task-id="${task.id}">${
                      shopping ? "Zakończ zakupy" : "Oznacz jako ukończone"
                    }</button>`
                  : `<button class="ghost-button" type="button" data-action="assign-me" data-task-id="${task.id}">${
                    getAssigneeIds(task).some((id) => isUserAbsentNow(id)) ? "Zastąp (bez transferu pkt)" : "Przepisz na mnie"
                  }</button>`
            }
            ${
              !closed && canComplete && !shopping && !pendingRequest
                ? `<button class="ghost-button" type="button" data-action="skip-task" data-task-id="${task.id}">Nie ma potrzeby</button>`
                : ""
            }
            ${
              !closed && canComplete && !task.isRewardTask && !pendingRequest
                ? `<button class="ghost-button" type="button" data-action="postpone-task" data-task-id="${task.id}">Przełóż</button>`
                : ""
            }
            <button class="ghost-button" type="button" data-action="edit-task" data-task-id="${task.id}">Edytuj</button>
            <button class="ghost-button" type="button" data-action="open-task-modal">Dodaj</button>
            <button class="danger-button" type="button" data-action="delete-task" data-task-id="${task.id}">Usuń</button>
          </div>
        </section>

        <section>
          <div class="section-head">
            <h3>Przypisanie</h3>
          </div>
          <form data-form="reassign" data-task-id="${task.id}">
            <div class="weekday-picker">
              ${state.users
                .map(
                  (user) => `
                    <label class="chip weekday-chip">
                      <input type="checkbox" name="assigneeId" value="${user.id}" ${
                        isAssignee(task, user.id) ? "checked" : ""
                      } />
                      ${escapeHtml(user.name)}
                    </label>
                  `
                )
                .join("")}
            </div>
            <div class="form-actions" style="margin-top: 10px">
              <button class="ghost-button" type="submit">Zmień przypisanie</button>
            </div>
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

  function renderShoppingChecklist(task, variant = "") {
    const canResolve = task.status === "open" && isAssignee(task, state.currentUserId);
    const summary = getShoppingSummary(task);

    return `
      <div class="shopping-panel ${variant === "top" ? "shopping-panel-top" : ""}">
        <div class="section-head">
          <h3>Lista zakupów</h3>
          <div class="shopping-head-side">
            <span class="pill blue">${summary.resolved}/${summary.total}</span>
            ${
              task.status === "done"
                ? ""
                : `<button class="ghost-button" type="button" data-action="open-shopping-item-modal" data-task-id="${task.id}">+ Produkt</button>`
            }
          </div>
        </div>
        <div class="shopping-list">
          ${task.shoppingItems
            .map((item) => {
              const bought = item.status === "bought";
              const unavailable = item.status === "unavailable";
              return `
                <div class="shopping-item ${unavailable ? "is-unavailable" : ""}">
                  <label class="shopping-check">
                    <input type="checkbox" data-action="shopping-item-bought" data-task-id="${task.id}" data-item-id="${
                item.id
              }" ${bought ? "checked" : ""} ${canResolve ? "" : "disabled"} />
                    <span>${escapeHtml(item.name)}</span>
                  </label>
                  <button class="ghost-button shopping-missing-button ${unavailable ? "is-active" : ""}" type="button" data-action="shopping-item-missing" data-task-id="${
                    task.id
                  }" data-item-id="${item.id}" ${canResolve ? "" : "disabled"}>
                    ${unavailable ? "Brak" : "Brak"}
                  </button>
                </div>
              `;
            })
            .join("")}
        </div>
        ${
          task.status === "done"
            ? `<p class="shopping-note">Zakupy zamknięte. Punkty naliczone za przyniesienie zakupów i kupione produkty.</p>`
            : `<p class="shopping-note">Zadanie zakończy się, gdy każdy produkt będzie kupiony albo oznaczony jako brak. Za przyniesienie zakupów doliczy się ${formatPoints(
                SHOPPING_DELIVERY_POINTS
              )} pkt.</p>`
        }
      </div>
    `;
  }

  function renderRequestPanel(task) {
    const request = getPendingRequestForTask(task.id);
    if (!request) {
      return "";
    }

    const author = getUser(request.requestedById);
    const yes = countVotes(request, "yes");
    const no = countVotes(request, "no");
    const required = getRequiredVotes();
    const mine = hasVoted(request, state.currentUserId);
    const isAuthor = request.requestedById === state.currentUserId;

    return `
      <section class="detail-card request-card">
        <div class="section-head">
          <h2>${REQUEST_LABELS[request.type]}</h2>
          <span class="pill amber">Głosowanie</span>
        </div>
        <p class="request-lead">${escapeHtml(author.name)} prosi o ${
          request.type === "skip"
            ? "zamknięcie zadania bez wykonania"
            : `przesunięcie terminu na ${formatHumanDate(request.proposedDueDate)}`
        }.</p>
        <p class="request-reason">„${escapeHtml(request.reason)}”</p>
        <div class="request-tally">
          <span class="pill done">Za: ${yes}</span>
          <span class="pill overdue">Przeciw: ${no}</span>
          <span class="pill blue">Potrzeba ${required} z ${state.users.length}</span>
        </div>
        ${renderVoteList(request)}
        <div class="split-actions">
          ${
            mine
              ? `<span class="form-hint">Twój głos jest już policzony. Czekamy na resztę domu.</span>`
              : `<button class="button" type="button" data-action="vote-yes" data-request-id="${request.id}">Zgadzam się</button>
                 <button class="danger-button" type="button" data-action="vote-no" data-request-id="${request.id}">Odmawiam</button>`
          }
          ${
            isAuthor
              ? `<button class="ghost-button" type="button" data-action="cancel-request" data-request-id="${request.id}">Wycofaj wniosek</button>`
              : ""
          }
        </div>
      </section>
    `;
  }

  function renderVoteList(request) {
    if (!request.votes?.length) {
      return "";
    }

    return `
      <div class="vote-list">
        ${request.votes
          .map((vote) => {
            const user = getUser(vote.userId);
            return `
              <div class="vote-item">
                ${avatar(user, "small")}
                <span class="item-body">
                  <span class="item-title">${escapeHtml(user.name)} · ${vote.value === "yes" ? "za" : "przeciw"}</span>
                  ${vote.reason ? `<span class="item-text">${escapeHtml(vote.reason)}</span>` : ""}
                </span>
              </div>
            `;
          })
          .join("")}
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

  function renderGoalHint() {
    if (isHomeBonusActive()) {
      return `<span class="form-hint goal-hint goal-hint-bonus">🎉 Premia domowa aktywna, punkty x2!</span>`;
    }
    const reached = state.users.filter((user) => hasReachedGoal(user.id));
    if (!reached.length) {
      return "";
    }
    const suggestion = getSuggestedAssignee();
    const reachedNames = reached.map((user) => escapeHtml(user.name)).join(", ");
    const suggestionText =
      suggestion && !hasReachedGoal(suggestion.id) ? ` Rozważ przypisanie na: ${escapeHtml(suggestion.name)}.` : "";
    return `<span class="form-hint goal-hint">${reachedNames} ${
      reached.length > 1 ? "osiągnęli" : "osiągnął(-ęła)"
    } cel ${MONTHLY_GOAL} pkt.${suggestionText}</span>`;
  }

  function cancelOwnRequest(requestId) {
    const request = getRequest(requestId);
    if (!request || request.status !== "pending") {
      return;
    }

    if (request.requestedById !== state.currentUserId) {
      toast("Tylko autor", "Wniosek wycofuje osoba, która go złożyła.");
      return;
    }

    state.taskRequests = getTaskRequests().filter((item) => item.id !== request.id);
    const task = getTask(request.taskId);
    if (task) {
      task.history.push(historyEntry("Wycofano wniosek", state.currentUserId));
      task.lastNotifiedAt = null;
      selectedTaskId = task.id;
    }

    saveState();
    toast("Wniosek wycofany", "Zadanie wraca do normalnego trybu.");
    render();
  }

  function renderRequestModal() {
    const task = requestTaskId ? getTask(requestTaskId) : null;
    if (!task) {
      return "";
    }

    const isSkip = requestKind === "skip";
    const remaining = getRemainingPostpones(state.currentUserId);
    const suggested = getSuggestedPostponeDate(task);
    const minDate = toISO(addDays(fromISO(task.dueDate), 1));
    const glosy = getRequiredVotes();

    return `
      <div class="modal-backdrop" role="presentation" data-action="close-modal">
        <section class="modal" role="dialog" aria-modal="true" aria-labelledby="request-modal-title">
          <div class="modal-head">
            <h2 class="modal-title" id="request-modal-title">${isSkip ? "Nie ma potrzeby" : "Przełóż zadanie"}</h2>
            <button class="icon-button" type="button" data-action="close-modal" aria-label="Zamknij">×</button>
          </div>
          <form class="task-form" data-form="request" data-task-id="${task.id}" data-kind="${requestKind}">
            <div class="form-grid">
              <p class="form-hint wide request-lead">
                ${escapeHtml(task.title)} · obecny termin ${formatHumanDate(task.dueDate)}
              </p>
              ${
                isSkip
                  ? `<span class="form-hint wide">Dom zdecyduje w głosowaniu. Potrzeba ${glosy} ${
                      glosy === 1 ? "głosu" : "głosów"
                    } „za”, żeby zamknąć zadanie bez wykonania.</span>`
                  : `<label>
                      <span class="label">Nowy termin</span>
                      <input class="input" type="date" name="requestDueDate" value="${escapeAttribute(suggested)}" min="${escapeAttribute(
                      minDate
                    )}" required />
                    </label>
                    <span class="form-hint wide">Pozostało przełożeń w tym miesiącu: <strong>${remaining}</strong> z ${MONTHLY_POSTPONE_LIMIT}. Potrzeba ${glosy} ${
                      glosy === 1 ? "głosu" : "głosów"
                    } „za”.</span>`
              }
              <label class="wide">
                <span class="label">Powód (zobaczą go domownicy)</span>
                <textarea class="textarea" name="requestReason" rows="3" maxlength="240" required placeholder="${
                  isSkip ? "Np. trawa jeszcze nie urosła" : "Np. wracam późno z pracy"
                }"></textarea>
              </label>
            </div>
            <div class="form-actions">
              <button class="ghost-button" type="button" data-action="close-modal">Anuluj</button>
              <button class="button" type="submit" ${
                !isSkip && !remaining ? "disabled" : ""
              }>Wyślij wniosek</button>
            </div>
          </form>
        </section>
      </div>
    `;
  }

  function renderVoteModal() {
    const request = votingRequestId ? getRequest(votingRequestId) : null;
    if (!request) {
      return "";
    }

    const author = getUser(request.requestedById);

    return `
      <div class="modal-backdrop" role="presentation" data-action="close-modal">
        <section class="modal" role="dialog" aria-modal="true" aria-labelledby="vote-modal-title">
          <div class="modal-head">
            <h2 class="modal-title" id="vote-modal-title">Odmawiasz — uzasadnij</h2>
            <button class="icon-button" type="button" data-action="close-modal" aria-label="Zamknij">×</button>
          </div>
          <form class="task-form" data-form="vote" data-request-id="${request.id}">
            <div class="form-grid">
              <p class="form-hint wide request-lead">
                ${escapeHtml(author.name)} · ${REQUEST_LABELS[request.type]} · ${escapeHtml(request.taskTitle)}
              </p>
              <label class="wide">
                <span class="label">Uzasadnienie odmowy</span>
                <textarea class="textarea" name="voteReason" rows="3" maxlength="240" required placeholder="Np. goście w sobotę, musi być zrobione wcześniej"></textarea>
              </label>
              <span class="form-hint wide">Trafi w powiadomieniu do osoby, która złożyła wniosek.</span>
            </div>
            <div class="form-actions">
              <button class="ghost-button" type="button" data-action="close-modal">Anuluj</button>
              <button class="danger-button" type="submit">Odmawiam</button>
            </div>
          </form>
        </section>
      </div>
    `;
  }

  function renderTaskModal() {
    const editingTask = editingTaskId ? getTask(editingTaskId) : null;
    const isEditing = Boolean(editingTask);
    const isShopping = isShoppingTask(editingTask) || (!editingTask && taskModalKind === "shopping");
    const values = {
      title: editingTask?.title || (isShopping ? "Zakupy" : ""),
      dueDate: editingTask?.dueDate || selectedDate || todayIso(),
      reminderTime: editingTask?.reminderTime || "18:00",
      assigneeIds: editingTask ? getAssigneeIds(editingTask) : [state.currentUserId],
      priority: PRIORITY[editingTask?.priority] ? editingTask.priority : "medium",
      recurrenceType: RECURRENCE[editingTask?.recurrence?.type] ? editingTask.recurrence.type : "none",
      rotate: editingTask ? Boolean(editingTask.recurrence?.rotate) : true,
      skipWeekdays: normalizeSkipWeekdays(editingTask?.recurrence?.skipWeekdays),
      shoppingItems: isShopping ? shoppingItemsToText(editingTask?.shoppingItems || []) : ""
    };

    return `
      <div class="modal-backdrop" role="presentation" data-action="close-modal">
        <section class="modal" role="dialog" aria-modal="true" aria-labelledby="task-modal-title">
          <div class="modal-head">
            <h2 class="modal-title" id="task-modal-title">${
              isEditing ? "Edytuj zadanie" : isShopping ? "Nowe zakupy" : "Nowe zadanie"
            }</h2>
            <button class="icon-button" type="button" data-action="close-modal" aria-label="Zamknij">×</button>
          </div>
          <form class="task-form" data-form="task" data-task-kind="${isShopping ? "shopping" : "standard"}">
            <div class="form-grid">
              ${
                isShopping
                  ? `<input type="hidden" name="title" value="Zakupy" />`
                  : `<label class="wide">
                      <span class="label">Nazwa</span>
                      <input class="input" name="title" value="${escapeAttribute(values.title)}" placeholder="Np. umyć podłogę" maxlength="90" required autofocus />
                    </label>`
              }
              <label>
                <span class="label">Termin</span>
                <input class="input" type="date" name="dueDate" value="${escapeAttribute(values.dueDate)}" required />
                ${
                  isEditing
                    ? `<span class="form-hint">Termin można tu tylko przyspieszyć. Przesunięcie na później idzie przez „Przełóż” i głosowanie domu.</span>`
                    : ""
                }
              </label>
              <label>
                <span class="label">Przypomnienie</span>
                <input class="input" type="time" name="reminderTime" value="${escapeAttribute(values.reminderTime)}" required />
              </label>
              <label class="wide">
                <span class="label">Osoba</span>
                <div class="weekday-picker">
                  ${state.users
                    .map(
                      (user) => `
                        <label class="chip weekday-chip">
                          <input type="checkbox" name="assigneeId" value="${user.id}" ${
                            values.assigneeIds.includes(user.id) ? "checked" : ""
                          } />
                          ${escapeHtml(user.name)}
                        </label>
                      `
                    )
                    .join("")}
                </div>
                ${renderGoalHint()}
              </label>
              ${
                isShopping
                  ? `<label class="wide">
                      <span class="label">Produkty</span>
                      <textarea class="textarea shopping-products-input" name="shoppingItems" rows="10" placeholder="Wpisz każdy produkt w osobnej linii" required>${escapeHtml(
                        values.shoppingItems
                      )}</textarea>
                      <span class="form-hint">Każda linia to inny produkt. Za przyniesienie zakupów nalicza się ${formatPoints(
                        SHOPPING_DELIVERY_POINTS
                      )} pkt, a za kupiony produkt ${formatPoints(SHOPPING_ITEM_POINTS)} pkt. Brak = 0 pkt.</span>
                    </label>`
                  : `<label>
                      <span class="label">Priorytet</span>
                      <select class="select" name="priority" required>
                        <option value="low" ${values.priority === "low" ? "selected" : ""}>Lekki · 5 pkt</option>
                        <option value="medium" ${values.priority === "medium" ? "selected" : ""}>Normalny · 10 pkt</option>
                        <option value="high" ${values.priority === "high" ? "selected" : ""}>Wysoki · 15 pkt</option>
                        <option value="urgent" ${values.priority === "urgent" ? "selected" : ""}>Bardzo wysoki · 25 pkt</option>
                      </select>
                    </label>`
              }
              <label>
                <span class="label">Powtarzanie</span>
                <select class="select" name="recurrenceType">
                  ${Object.entries(RECURRENCE)
                    .map(
                      ([value, label]) =>
                        `<option value="${value}" ${value === values.recurrenceType ? "selected" : ""}>${label}</option>`
                    )
                    .join("")}
                </select>
              </label>
              <label class="wide status-line">
                <input type="checkbox" name="rotate" ${values.rotate ? "checked" : ""} />
                <span>Rotacja między domownikami przy kolejnych cyklach</span>
              </label>
              <label class="wide">
                <span class="label">Pomiń w te dni</span>
                <div class="weekday-picker">
                  ${WEEKDAY_LABELS.map(
                    (label, index) => `
                      <label class="chip weekday-chip">
                        <input type="checkbox" name="skipWeekday" value="${index}" ${
                          values.skipWeekdays.includes(index) ? "checked" : ""
                        } />
                        ${label}
                      </label>
                    `
                  ).join("")}
                </div>
                <span class="form-hint">Dotyczy zadań cyklicznych — pominięty dzień przesuwa termin na kolejny.</span>
              </label>
            </div>
            <div class="form-actions">
              <button class="ghost-button" type="button" data-action="close-modal">Anuluj</button>
              <button class="button" type="submit">${isEditing ? "Zapisz zmiany" : "Dodaj zadanie"}</button>
            </div>
          </form>
        </section>
      </div>
    `;
  }

  function renderRewardCelebration() {
    const { userName, threshold, kind } = rewardCelebration;
    const premia = kind === "bonus";
    const eyebrow = premia ? "Premia domowa" : "Próg osiągnięty";
    const tytul = premia ? "Cały dom przekroczył 500 pkt!" : `${escapeHtml(userName)} ma ${threshold} pkt!`;
    const tresc = premia
      ? `Od teraz punkty ponad ${MONTHLY_GOAL} liczą się podwójnie. Pierwsze ${MONTHLY_GOAL} pkt zawsze pojedynczo.`
      : "Teraz Ty przyznajesz nagrodę.";
    return `
      <div class="reward-celebration" role="dialog" aria-modal="true" aria-labelledby="reward-celebration-title">
        <div class="reward-celebration-card">
          <span class="reward-celebration-badge" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">
              <rect x="3.5" y="10" width="17" height="10.5" rx="1.4" />
              <path d="M3.5 14h17" />
              <path d="M12 10v10.5" />
              <path d="M12 10C10.2 10 7.4 9.6 7.4 7.6S9.2 5.2 10.1 5.7 12 8.2 12 10z" />
              <path d="M12 10c1.8 0 4.6-.4 4.6-2.4S14.8 5.2 13.9 5.7 12 8.2 12 10z" />
            </svg>
          </span>
          <p class="reward-celebration-eyebrow">${eyebrow}</p>
          <h2 class="reward-celebration-title" id="reward-celebration-title">${tytul}</h2>
          <p class="reward-celebration-text">${tresc}</p>
          <div class="reward-celebration-actions">
            ${
              premia
                ? `<button class="button" type="button" data-action="close-reward-celebration">Super!</button>`
                : `<button class="button" type="button" data-action="open-reward-task">Zobacz zadanie</button>
                   <button class="ghost-button" type="button" data-action="close-reward-celebration">Później</button>`
            }
          </div>
        </div>
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
                    <button class="notification-item" type="button" data-action="${
                      item.kind === "reward" || item.kind === "bonus" ? "open-reward-celebration" : "select-task"
                    }" data-task-id="${item.taskId}" data-notification-id="${item.id}">
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
            const assignees = getAssignees(item);
            return `
              <button class="mini-item" type="button" data-action="select-task" data-task-id="${item.id}">
                ${avatar(assignees[0], "small")}
                <span class="item-body">
                  <span class="item-title">${escapeHtml(item.title)}</span>
                  <span class="item-text">${formatHumanDate(item.dueDate)} · ${item.reminderTime} · ${formatAssigneeNames(item)}</span>
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
      .map((user) => ({ user, points: getUserPoints(user.id), counts: getUserTaskCounts(user.id) }))
      .sort((a, b) => b.points - a.points);

    return `
      <div class="leaderboard">
        ${rows
          .map(
            (row) => `
              <div class="leader-row">
                ${avatar(row.user)}
                <div class="leader-person">
                  <strong>${escapeHtml(row.user.name)}</strong>
                  <span class="compact-meta">${row.counts.today} dziś · ${row.counts.week} w tygodniu · ${row.counts.month} w miesiącu</span>
                </div>
                <div class="person-points">${formatPoints(row.points)} pkt</div>
                ${renderRewardAxis(row.points, "", row.user.id)}
              </div>
            `
          )
          .join("")}
      </div>
    `;
  }

  function getUserTaskCounts(userId) {
    const doneTasks = state.tasks.filter((task) => task.status === "done" && isAssignee(task, userId));
    const today = todayIso();
    return {
      today: doneTasks.filter((task) => task.completedAt && toISO(new Date(task.completedAt)) === today).length,
      week: doneTasks.filter((task) => isWithinLastDays(task.completedAt, 7)).length,
      month: doneTasks.filter((task) => isInCurrentPointPeriod(task.completedAt)).length
    };
  }

  function getHouseholdTaskCounts() {
    const doneTasks = state.tasks.filter((task) => task.status === "done");
    return {
      total: doneTasks.length,
      week: doneTasks.filter((task) => isWithinLastDays(task.completedAt, 7)).length,
      month: doneTasks.filter((task) => isInCurrentPointPeriod(task.completedAt)).length
    };
  }

  function renderTaskCountSummary() {
    const counts = getHouseholdTaskCounts();
    return `<p class="points-reset-note">Zadania w domu: ${counts.total} od początku · ${counts.week} z 7 dni · ${counts.month} od początku miesiąca.</p>`;
  }

  // Mini ranking ma być krótki — zostaje sam reset. Reszta zasad żyje
  // w pełnym rankingu, gdzie jest miejsce, żeby je wyjaśnić.
  function renderPointResetNote() {
    return `
      ${renderHomeBonusBanner()}
      <p class="points-reset-note">Punkty resetują się 1. dnia każdego miesiąca.</p>
    `;
  }

  function renderPointRulesNote() {
    return `
      ${renderHomeBonusBanner()}
      <p class="points-reset-note">Punkty resetują się 1. dnia każdego miesiąca. Nadwyżka ponad ${MONTHLY_GOAL} pkt ÷ ${CARRYOVER_DIVISOR} wraca jako bonus w nowym miesiącu.</p>
      <p class="points-reset-note">Gdy <strong>każdy</strong> domownik przekroczy ${MONTHLY_GOAL} pkt, włącza się premia domowa: od tego momentu punkty ponad ${MONTHLY_GOAL} liczą się podwójnie. Pierwsze ${MONTHLY_GOAL} pkt zawsze liczy się pojedynczo.</p>
    `;
  }

  function renderHomeBonusBanner() {
    if (!isHomeBonusActive()) {
      return "";
    }
    return `<p class="home-bonus-banner">🎉 Premia domowa aktywna, punkty x2! Wszyscy przekroczyli ${MONTHLY_GOAL} pkt.</p>`;
  }

  // Nagroda liczy się jako przyznana tylko w bieżącym okresie punktowym —
  // punkty resetują się co miesiąc, więc ptaszek z lipca nie może wisieć
  // przy progu, do którego ktoś dopiero się wspina w sierpniu.
  function isRewardGranted(userId, thresholdPoints) {
    if (!userId) {
      return false;
    }
    const currentPeriod = getPointPeriodKey();
    return state.rewardClaims.some(
      (claim) =>
        claim.userId === userId &&
        claim.threshold === thresholdPoints &&
        claim.status === "done" &&
        getRewardClaimPeriod(claim) === currentPeriod
    );
  }

  function renderRewardGift(granted, reached) {
    const stan = granted ? " is-granted" : reached ? "" : " is-locked";
    return `
      <span class="reward-gift${stan}" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round">
          <rect x="3.5" y="10" width="17" height="10.5" rx="1.4" />
          <path d="M3.5 14h17" />
          <path d="M12 10v10.5" />
          <path d="M12 10C10.2 10 7.4 9.6 7.4 7.6S9.2 5.2 10.1 5.7 12 8.2 12 10z" />
          <path d="M12 10c1.8 0 4.6-.4 4.6-2.4S14.8 5.2 13.9 5.7 12 8.2 12 10z" />
        </svg>
        ${
          granted
            ? `<span class="reward-gift-check">
                 <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round">
                   <path d="M20 6.5 9.2 17.3 4 12.1" />
                 </svg>
               </span>`
            : ""
        }
      </span>
    `;
  }

  function renderRewardAxis(points, variant = "", userId = null) {
    const axisMax = Math.max(getRewardThresholds()[getRewardThresholds().length - 1].points, points, 1);
    const fillWidth = Math.min(100, Math.max(3, (points / axisMax) * 100));
    // Im więcej zdobytych progów, tym mocniejsza poświata. Na maksymalnym progu
    // pasek przechodzi w tryb "laser".
    const osiagniete = getRewardThresholds().filter((threshold) => points >= threshold.points).length;
    const maks = points >= getRewardThresholds()[getRewardThresholds().length - 1].points;

    return `
      <div class="reward-axis ${variant}" aria-label="Postęp do nagród">
        <span class="reward-axis-fill glow-${osiagniete}${maks ? " is-max" : ""}" style="width:${fillWidth}%"></span>
        ${getRewardThresholds().map((threshold) => {
          const left = Math.min(100, (threshold.points / axisMax) * 100);
          const osiagniety = points >= threshold.points;
          const reached = osiagniety ? "is-reached" : "";
          const granted = isRewardGranted(userId, threshold.points);
          const opis = granted
            ? `${threshold.label}: ${threshold.points} pkt — nagroda przyznana`
            : osiagniety
              ? `${threshold.label}: ${threshold.points} pkt — nagroda do przyznania`
              : `${threshold.label}: ${threshold.points} pkt — jeszcze nie zdobyta`;
          return `
            <span class="reward-axis-marker ${reached}" style="left:clamp(24px, ${left}%, calc(100% - 24px))" title="${escapeAttribute(opis)}">
              <span>${threshold.points}</span>
              ${variant === "compact" ? "" : renderRewardGift(granted, osiagniety)}
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

    if (action === "toggle-more-menu") {
      moreMenuOpen = !moreMenuOpen;
      notificationPanelOpen = false;
      render();
      return;
    }

    if (action === "view") {
      activeView = actionElement.dataset.view;
      moreMenuOpen = false;
      notificationPanelOpen = false;
      render();
      return;
    }

    if (action === "filter" || action === "quick-filter") {
      activeView = "tasks";
      activeFilter = actionElement.dataset.filter;
      moreMenuOpen = false;
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
      moreMenuOpen = false;
      render();
      return;
    }

    if (action === "back-to-tasks") {
      activeView = "tasks";
      moreMenuOpen = false;
      render();
      return;
    }

    if (action === "open-task-modal") {
      editingTaskId = null;
      taskModalKind = "standard";
      activeModal = "task";
      notificationPanelOpen = false;
      moreMenuOpen = false;
      render();
      queueMicrotask(() => document.querySelector("[name='title']")?.focus());
      return;
    }

    if (action === "open-settings") {
      settingsPanel = null;
      settingsPanelTarget = null;
      adminUnlocked = false;
      activeModal = "settings";
      notificationPanelOpen = false;
      moreMenuOpen = false;
      render();
      return;
    }

    if (action === "settings-panel") {
      const cel = actionElement.dataset.panel || null;
      if (cel && PANELE_ADMINA.includes(cel) && !adminUnlocked) {
        settingsPanelTarget = cel;
        settingsPanel = "admin-pin";
        render();
        queueMicrotask(() => document.querySelector("[name='adminPin']")?.focus());
        return;
      }
      settingsPanel = cel;
      render();
      return;
    }

    if (action === "open-reward-celebration") {
      const powiadomienie = state.notifications.find((item) => item.id === actionElement.dataset.notificationId);
      rewardCelebration = {
        kind: powiadomienie?.kind === "bonus" ? "bonus" : "reward",
        userName: powiadomienie?.rewardUserName || "Domownik",
        threshold: powiadomienie?.rewardThreshold || 0,
        taskId: actionElement.dataset.taskId || powiadomienie?.taskId || null
      };
      if (powiadomienie) {
        powiadomienie.read = true;
      }
      notificationPanelOpen = false;
      moreMenuOpen = false;
      saveState();
      render();
      startKonfetti(2800);
      return;
    }

    if (action === "close-reward-celebration") {
      rewardCelebration = null;
      stopKonfetti();
      render();
      return;
    }

    if (action === "open-reward-task") {
      const taskId = rewardCelebration?.taskId || null;
      rewardCelebration = null;
      stopKonfetti();
      if (taskId && getTask(taskId)) {
        selectedTaskId = taskId;
        activeView = "task-detail";
      }
      render();
      return;
    }

    if (action === "open-shopping-item-modal") {
      shoppingModalTaskId = actionElement.dataset.taskId || null;
      activeModal = "shopping-item";
      notificationPanelOpen = false;
      moreMenuOpen = false;
      render();
      queueMicrotask(() => document.querySelector("[name='produkt']")?.focus());
      return;
    }

    if (action === "close-shopping-item-modal") {
      if (event.target === actionElement || actionElement.matches("button")) {
        activeModal = null;
        shoppingModalTaskId = null;
        render();
      }
      return;
    }

    if (action === "remove-shopping-item") {
      removeShoppingItem(actionElement.dataset.taskId, actionElement.dataset.itemId);
      return;
    }

    if (action === "open-shopping-modal") {
      editingTaskId = null;
      taskModalKind = "shopping";
      activeModal = "task";
      notificationPanelOpen = false;
      moreMenuOpen = false;
      render();
      queueMicrotask(() => document.querySelector("[name='shoppingItems']")?.focus());
      return;
    }

    if (action === "open-login-modal") {
      activeModal = "login";
      notificationPanelOpen = false;
      moreMenuOpen = false;
      render();
      return;
    }

    if (action === "open-pause-modal") {
      // Otwieramy na tym, co już trwa: własna nieobecność ma pierwszeństwo,
      // potem pauza domu, a jeśli nic nie trwa — na sobie.
      pauseModalTarget = getUserAbsence(state.currentUserId)
        ? state.currentUserId
        : state.household.pause
          ? "dom"
          : state.currentUserId;
      activeModal = "pause";
      notificationPanelOpen = false;
      moreMenuOpen = false;
      render();
      return;
    }

    if (action === "pause-target") {
      pauseModalTarget = actionElement.dataset.target;
      render();
      return;
    }

    if (action === "resume-household") {
      if (pauseModalTarget === "dom") {
        state.household.pause = null;
      } else {
        const osoba = getUserById(pauseModalTarget);
        if (osoba) {
          osoba.absence = null;
        }
      }
      const nazwaCelu = pauseModalTarget === "dom" ? "Cały dom" : getUser(pauseModalTarget).name;
      activeModal = null;
      saveState();
      toast(`Wznowiono: ${nazwaCelu}`, "Przypomnienia i zaległości znów naliczają się normalnie.");
      render();
      return;
    }

    if (action === "change-household") {
      rememberHousehold(state);
      clearSession();
      state.isAuthenticated = false;
      activeModal = null;
      notificationPanelOpen = false;
      moreMenuOpen = false;
      persistLocalState(state);
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
        editingTaskId = null;
        taskModalKind = "standard";
        requestTaskId = null;
        votingRequestId = null;
        render();
      }
      return;
    }

    if (action === "edit-task") {
      const task = getTask(actionElement.dataset.taskId);
      if (!task) {
        toast("Nie znaleziono zadania", "Odśwież listę i spróbuj ponownie.");
        return;
      }

      selectedTaskId = task.id;
      editingTaskId = task.id;
      taskModalKind = isShoppingTask(task) ? "shopping" : "standard";
      activeModal = "task";
      notificationPanelOpen = false;
      moreMenuOpen = false;
      render();
      queueMicrotask(() => document.querySelector("[name='title']")?.focus());
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
      completeTaskWithFlourish(
        actionElement.dataset.taskId,
        actionElement.closest(".task-card"),
        actionElement
      );
      return;
    }

    if (action === "reopen-task") {
      reopenTask(actionElement.dataset.taskId);
      return;
    }

    if (action === "delete-task") {
      deleteTask(actionElement.dataset.taskId);
      return;
    }

    if (action === "shopping-item-missing") {
      toggleShoppingItemMissing(actionElement.dataset.taskId, actionElement.dataset.itemId);
      return;
    }

    if (action === "assign-me") {
      reassignTask(actionElement.dataset.taskId, [state.currentUserId]);
      return;
    }

    if (action === "skip-task" || action === "postpone-task") {
      const task = getTask(actionElement.dataset.taskId);
      if (!task) {
        toast("Nie znaleziono zadania", "Odśwież listę i spróbuj ponownie.");
        return;
      }

      requestTaskId = task.id;
      requestKind = action === "skip-task" ? "skip" : "postpone";
      selectedTaskId = task.id;
      activeModal = "request";
      notificationPanelOpen = false;
      moreMenuOpen = false;
      render();
      queueMicrotask(() => document.querySelector("[name='requestReason']")?.focus());
      return;
    }

    if (action === "vote-yes") {
      voteOnRequest(actionElement.dataset.requestId, "yes");
      return;
    }

    if (action === "vote-no") {
      votingRequestId = actionElement.dataset.requestId;
      activeModal = "vote";
      notificationPanelOpen = false;
      moreMenuOpen = false;
      render();
      queueMicrotask(() => document.querySelector("[name='voteReason']")?.focus());
      return;
    }

    if (action === "cancel-request") {
      cancelOwnRequest(actionElement.dataset.requestId);
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
      moreMenuOpen = false;
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
    if (event.target.matches("[data-action='shopping-item-bought']")) {
      updateShoppingItemStatus(
        event.target.dataset.taskId,
        event.target.dataset.itemId,
        event.target.checked ? "bought" : "pending"
      );
    }
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

    if (formType === "admin-pin") {
      const data = new FormData(form);
      const podany = String(data.get("adminPin") || "").trim();
      if (!/^[0-9]{4}$/.test(podany)) {
        toast("PIN to 4 cyfry", "Wpisz dokładnie cztery cyfry.");
        return;
      }
      if (!state.household.adminPin) {
        state.household.adminPin = podany;
        adminUnlocked = true;
        settingsPanel = settingsPanelTarget;
        settingsPanelTarget = null;
        saveState();
        render();
        toast("PIN admina ustawiony", "Od teraz chroni progi punktowe i trwanie dnia.");
        return;
      }
      if (podany !== state.household.adminPin) {
        toast("Zły PIN", "Spróbuj jeszcze raz.");
        return;
      }
      adminUnlocked = true;
      settingsPanel = settingsPanelTarget;
      settingsPanelTarget = null;
      render();
      return;
    }

    if (formType === "day-length") {
      const data = new FormData(form);
      state.household.dayStart = Number(data.get("dayStart"));
      state.household.dayEnd = Number(data.get("dayEnd"));
      settingsPanel = null;
      saveState();
      render();
      toast("Zapisano trwanie dnia", `Doba liczy się od ${formatHour(getDayStartHour())}.`);
      return;
    }

    if (formType === "thresholds") {
      const data = new FormData(form);
      const domyslne = getRewardThresholds();
      const progi = domyslne.map((prog, i) => ({
        points: Number(data.get(`prog${i}`)),
        label: prog.label
      }));
      const rosnace = progi.every(
        (prog, i) => Number.isFinite(prog.points) && prog.points > 0 && (i === 0 || prog.points > progi[i - 1].points)
      );
      if (!rosnace) {
        toast("Progi muszą rosnąć", "Każdy kolejny próg musi być wyższy od poprzedniego.");
        return;
      }
      state.household.rewardThresholds = progi;
      settingsPanel = null;
      saveState();
      render();
      toast("Zapisano progi", progi.map((prog) => prog.points).join(" · ") + " pkt");
      return;
    }

    if (formType === "shopping-item") {
      const data = new FormData(form);
      addShoppingItem(form.dataset.taskId, String(data.get("produkt") || ""));
      return;
    }

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

    if (formType === "pause") {
      const data = new FormData(form);
      const from = String(data.get("pauseFrom") || "");
      const until = String(data.get("pauseUntil") || "");

      if (!from || !until || from > until) {
        toast("Sprawdź daty", "Data „Do” nie może być wcześniejsza niż „Od”.");
        return;
      }

      const cel = String(data.get("pauseTarget") || "dom");
      if (cel === "dom") {
        state.household.pause = { from, until };
      } else {
        const osoba = getUserById(cel);
        if (!osoba) {
          toast("Nie znaleziono domownika", "Odśwież aplikację i spróbuj ponownie.");
          return;
        }
        osoba.absence = { from, until };
      }

      const nazwaCelu = cel === "dom" ? "Cały dom" : getUser(cel).name;
      activeModal = null;
      saveState();
      toast(`Wstrzymano: ${nazwaCelu}`, `${formatHumanDate(from)} – ${formatHumanDate(until)}`);
      render();
      return;
    }

    if (formType === "request") {
      const data = new FormData(form);
      const kind = form.dataset.kind === "skip" ? "skip" : "postpone";
      const created = createTaskRequest(
        form.dataset.taskId,
        kind,
        String(data.get("requestReason") || ""),
        kind === "postpone" ? String(data.get("requestDueDate") || "") : null
      );

      if (created) {
        activeModal = null;
        requestTaskId = null;
        render();
      }
      return;
    }

    if (formType === "vote") {
      const data = new FormData(form);
      const voted = voteOnRequest(form.dataset.requestId, "no", String(data.get("voteReason") || ""));
      if (voted) {
        activeModal = null;
        votingRequestId = null;
        render();
      }
      return;
    }

    if (formType === "task") {
      const data = new FormData(form);
      const editingTask = editingTaskId ? getTask(editingTaskId) : null;
      const taskType = isShoppingTask(editingTask) || form.dataset.taskKind === "shopping" ? "shopping" : "standard";
      const isShopping = taskType === "shopping";
      const rawPriority = String(data.get("priority"));
      const priority = isShopping ? "medium" : PRIORITY[rawPriority] ? rawPriority : "medium";
      const title = String(data.get("title")).trim() || (isShopping ? "Zakupy" : "");
      const dueDate = String(data.get("dueDate"));
      const reminderTime = String(data.get("reminderTime"));
      const assigneeIds = Array.from(new Set(data.getAll("assigneeId").map(String).filter((id) => getUserById(id))));
      const rawRecurrenceType = String(data.get("recurrenceType") || "none");
      const recurrenceType = RECURRENCE[rawRecurrenceType] ? rawRecurrenceType : "none";
      const skipWeekdays = normalizeSkipWeekdays(data.getAll("skipWeekday"));
      const shoppingItems = isShopping
        ? buildShoppingItemsFromText(String(data.get("shoppingItems") || ""), editingTask?.shoppingItems || [])
        : [];

      if (!title) {
        toast("Uzupełnij zadanie", "Podaj nazwę zadania.");
        return;
      }

      if (!assigneeIds.length) {
        toast("Wybierz osobę", "Zaznacz przynajmniej jednego domownika.");
        return;
      }

      if (isShopping && !shoppingItems.length) {
        toast("Dodaj produkty", "Wpisz przynajmniej jeden produkt do kupienia.");
        return;
      }

      if (editingTask) {
        // Furtka „odłożę bez konsekwencji” zamknięta: przez edycję termin da się
        // tylko przyspieszyć. Przesunięcie na później wymaga wniosku i głosów.
        if (dueDate > editingTask.dueDate && !editingTask.isRewardTask) {
          toast("Termin tylko przez wniosek", "Aby przesunąć zadanie na później, użyj przycisku „Przełóż”.");
          return;
        }

        const reminderChanged =
          editingTask.dueDate !== dueDate ||
          editingTask.reminderTime !== reminderTime ||
          getAssigneeIds(editingTask).join(",") !== assigneeIds.join(",");

        editingTask.title = title;
        editingTask.type = taskType;
        editingTask.room = isShopping ? "Zakupy" : editingTask.room || "Inne";
        editingTask.assigneeIds = assigneeIds;
        editingTask.assigneeId = assigneeIds[0];
        editingTask.dueDate = dueDate;
        editingTask.reminderTime = reminderTime;
        editingTask.priority = priority;
        editingTask.recurrence = {
          type: RECURRENCE[recurrenceType] ? recurrenceType : "none",
          rotate: data.has("rotate"),
          skipWeekdays
        };
        editingTask.shoppingItems = shoppingItems;
        editingTask.points = getTaskPotentialPoints(editingTask);
        editingTask.assignedAt = reminderChanged ? new Date().toISOString() : editingTask.assignedAt;
        editingTask.lastNotifiedAt = reminderChanged ? null : editingTask.lastNotifiedAt;
        editingTask.history.push(historyEntry("Edytowano zadanie", state.currentUserId));

        selectedTaskId = editingTask.id;
        selectedDate = editingTask.dueDate;
        calendarCursor = startOfMonth(fromISO(editingTask.dueDate));
        activeModal = null;
        editingTaskId = null;
        taskModalKind = "standard";
        saveState();
        toast("Zapisano zmiany", editingTask.title);
        render();
        return;
      }

      const task = {
        id: uid("task"),
        title,
        type: taskType,
        room: isShopping ? "Zakupy" : "Inne",
        assigneeIds,
        assigneeId: assigneeIds[0],
        createdById: state.currentUserId,
        dueDate,
        reminderTime,
        assignedAt: new Date().toISOString(),
        priority,
        status: "open",
        completedAt: null,
        completedById: null,
        skippedById: null,
        recurrence: {
          type: recurrenceType,
          rotate: data.has("rotate"),
          skipWeekdays
        },
        points: isShopping ? getShoppingPotentialPoints(shoppingItems) : PRIORITY[priority].points,
        shoppingItems,
        comments: [],
        history: [historyEntry("Utworzono zadanie", state.currentUserId)],
        lastNotifiedAt: null
      };

      state.tasks.unshift(task);
      notifyNewTask(task);
      maybeSuggestReassign(task);
      selectedTaskId = task.id;
      selectedDate = task.dueDate;
      calendarCursor = startOfMonth(fromISO(task.dueDate));
      activeModal = null;
      editingTaskId = null;
      taskModalKind = "standard";
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
      const assigneeIds = new FormData(form).getAll("assigneeId").map(String);
      if (!assigneeIds.length) {
        toast("Wybierz osobę", "Zadanie musi mieć przynajmniej jednego domownika.");
        return;
      }
      reassignTask(form.dataset.taskId, assigneeIds);
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

    if (!isAssignee(task, state.currentUserId)) {
      toast("Najpierw przepisz zadanie", "Ukończenie jest dostępne dla osoby przypisanej.");
      selectedTaskId = task.id;
      render();
      return;
    }

    if (isShoppingTask(task) && !isShoppingResolved(task)) {
      toast("Dokończ listę zakupów", "Każdy produkt musi być kupiony albo oznaczony jako brak.");
      selectedTaskId = task.id;
      render();
      return;
    }

    const overdueDays = getOverdueDays(task);
    const earnedPoints = getTaskPoints(task);
    const assigneeCount = getAssigneeIds(task).length;
    const perPerson = earnedPoints / assigneeCount;
    task.points = getTaskPotentialPoints(task);
    task.status = "done";
    task.completedAt = new Date().toISOString();
    task.completedById = state.currentUserId;
    const shareText =
      assigneeCount > 1
        ? ` (${formatPoints(perPerson)} pkt/os. dla ${assigneeCount} domowników)`
        : "";
    task.history.push(historyEntry(`Ukończono zadanie za ${formatPoints(earnedPoints)} pkt${shareText}`, state.currentUserId));
    completeRewardClaim(task);
    if (overdueDays > 0) {
      task.history.push(historyEntry(`Kara za zwłokę: -${overdueDays * 10} pkt`, state.currentUserId));
    }
    selectedTaskId = task.id;

    if (task.isRewardTask) {
      toast("Nagroda przyznana", "Zdobyto symboliczne 5 pkt.");
    } else if (task.recurrence.type !== "none") {
      const nextTask = createNextRecurringTask(task);
      task.nextRecurringTaskId = nextTask.id;
      state.tasks.unshift(nextTask);
      toast(isShoppingTask(task) ? "Zakupy zakończone" : "Zadanie ukończone", `Dodano kolejny termin: ${formatHumanDate(nextTask.dueDate)}.`);
    } else if (isShoppingTask(task)) {
      toast("Zakupy zakończone", `Zdobyto ${formatPoints(earnedPoints)} pkt.`);
    } else {
      const penaltyText = overdueDays ? `, kara za zwłokę -${overdueDays * 10} pkt` : "";
      toast("Zadanie ukończone", `Zdobyto ${formatPoints(assigneeCount > 1 ? perPerson : earnedPoints)} pkt${penaltyText}.`);
    }

    saveState();
    render();
  }

  /* ===================== Wnioski i głosowanie =====================
     „Nie ma potrzeby” i przełożenie terminu nie są już decyzją jednej osoby.
     Obie akcje zakładają wniosek z pisemnym powodem, o którym dom dostaje
     powiadomienie i który przechodzi przez głosowanie — wygrywa większość
     domowników. Dodatkowo każdy domownik ma limit przełożeń na miesiąc. */

  function getTaskRequests() {
    if (!Array.isArray(state.taskRequests)) {
      state.taskRequests = [];
    }
    return state.taskRequests;
  }

  function getPendingRequestForTask(taskId) {
    return getTaskRequests().find((item) => item.taskId === taskId && item.status === "pending") || null;
  }

  function getRequest(requestId) {
    return getTaskRequests().find((item) => item.id === requestId) || null;
  }

  function getPendingRequests() {
    return getTaskRequests().filter((item) => item.status === "pending");
  }

  function hasVoted(request, userId) {
    return (request.votes || []).some((vote) => vote.userId === userId);
  }

  function countVotes(request, value) {
    return (request.votes || []).filter((vote) => vote.value === value).length;
  }

  function getRequiredVotes() {
    return Math.floor(state.users.length / 2) + 1;
  }

  function getUsedPostponeCount(userId, periodKey = getPointPeriodKey()) {
    return getTaskRequests().filter(
      (item) =>
        item.type === "postpone" &&
        item.status === "approved" &&
        item.requestedById === userId &&
        getPointPeriodKey(item.resolvedAt || item.createdAt) === periodKey
    ).length;
  }

  function getRemainingPostpones(userId) {
    return Math.max(0, MONTHLY_POSTPONE_LIMIT - getUsedPostponeCount(userId));
  }

  function notifyUsers(userIds, { title, body, taskId = null, push = false }) {
    Array.from(new Set(userIds))
      .filter((id) => id && getUserById(id))
      .forEach((id) => {
        state.notifications.unshift({
          id: uid("notification"),
          taskId,
          title,
          body,
          recipientUserId: id,
          read: false,
          push,
          createdAt: new Date().toISOString()
        });
      });

    state.notifications = state.notifications.slice(0, NOTIFICATIONS_LIMIT);
  }

  function createTaskRequest(taskId, type, reason, proposedDueDate) {
    const task = getTask(taskId);
    if (!task) {
      toast("Nie znaleziono zadania", "Odśwież listę i spróbuj ponownie.");
      return false;
    }

    if (task.status !== "open") {
      toast("Zadanie jest zamknięte", "Wniosek dotyczy tylko otwartych zadań.");
      return false;
    }

    if (!isAssignee(task, state.currentUserId)) {
      toast("Najpierw przepisz zadanie", "Wniosek składa osoba, do której należy zadanie.");
      return false;
    }

    if (getPendingRequestForTask(task.id)) {
      toast("Wniosek już czeka", "Dom głosuje nad poprzednim wnioskiem do tego zadania.");
      return false;
    }

    const cleanReason = String(reason || "").trim();
    if (cleanReason.length < MIN_REASON_LENGTH) {
      toast("Podaj powód", "Domownicy zobaczą go w powiadomieniu — napisz choć jedno zdanie.");
      return false;
    }

    if (type === "postpone") {
      if (!getRemainingPostpones(state.currentUserId)) {
        toast("Limit wyczerpany", `W tym miesiącu masz już ${MONTHLY_POSTPONE_LIMIT} przełożenia. Kolejne od pierwszego dnia miesiąca.`);
        return false;
      }
      if (!proposedDueDate || proposedDueDate <= task.dueDate) {
        toast("Wybierz nowy termin", "Nowy termin musi być późniejszy niż obecny.");
        return false;
      }
    }

    const request = {
      id: uid("request"),
      taskId: task.id,
      taskTitle: task.title,
      type,
      requestedById: state.currentUserId,
      reason: cleanReason,
      previousDueDate: task.dueDate,
      proposedDueDate: type === "postpone" ? proposedDueDate : null,
      status: "pending",
      votes: [{ userId: state.currentUserId, value: "yes", reason: cleanReason, createdAt: new Date().toISOString() }],
      createdAt: new Date().toISOString(),
      resolvedAt: null
    };

    getTaskRequests().unshift(request);

    const author = getUser(state.currentUserId);
    const opis =
      type === "skip"
        ? `${author.name} chce zamknąć „${task.title}” bez wykonania.`
        : `${author.name} chce przełożyć „${task.title}” na ${formatHumanDate(proposedDueDate)}.`;

    task.history.push(
      historyEntry(
        type === "skip"
          ? `Wniosek: nie ma potrzeby — ${cleanReason}`
          : `Wniosek: przełożenie na ${formatHumanDate(proposedDueDate)} — ${cleanReason}`,
        state.currentUserId
      )
    );

    notifyUsers(
      state.users.map((user) => user.id).filter((id) => id !== state.currentUserId),
      {
        title: type === "skip" ? "Wniosek: nie ma potrzeby" : "Wniosek o przełożenie",
        body: `${opis} Powód: ${cleanReason}. Zagłosuj w zadaniu.`,
        taskId: task.id,
        push: true
      }
    );

    selectedTaskId = task.id;
    resolveRequestIfDecided(request);
    saveState();
    render();
    return true;
  }

  function voteOnRequest(requestId, value, reason = "") {
    const request = getRequest(requestId);
    if (!request || request.status !== "pending") {
      toast("Wniosek rozstrzygnięty", "Ten wniosek został już zamknięty.");
      render();
      return false;
    }

    if (hasVoted(request, state.currentUserId)) {
      toast("Głos już oddany", "Każdy domownik głosuje raz.");
      return false;
    }

    const cleanReason = String(reason || "").trim();
    if (value === "no" && cleanReason.length < MIN_REASON_LENGTH) {
      toast("Uzasadnij odmowę", "Osoba od zadania dostanie Twoje uzasadnienie w powiadomieniu.");
      return false;
    }

    request.votes.push({
      userId: state.currentUserId,
      value: value === "no" ? "no" : "yes",
      reason: cleanReason,
      createdAt: new Date().toISOString()
    });

    const task = getTask(request.taskId);
    if (task) {
      task.history.push(
        historyEntry(
          value === "no" ? `Głos przeciw${cleanReason ? ` — ${cleanReason}` : ""}` : "Głos za wnioskiem",
          state.currentUserId
        )
      );
      selectedTaskId = task.id;
    }

    resolveRequestIfDecided(request);

    // Gdy głos od razu przesądza sprawę, autor dostaje jedno powiadomienie
    // o decyzji (z uzasadnieniami w treści) — bez dublowania go sprzeciwem.
    if (value === "no" && request.status === "pending" && request.requestedById !== state.currentUserId) {
      notifyUsers([request.requestedById], {
        title: "Sprzeciw wobec wniosku",
        body: `${getUser(state.currentUserId).name} nie zgadza się na „${request.taskTitle}”. Uzasadnienie: ${cleanReason}`,
        taskId: request.taskId,
        push: true
      });
    }
    saveState();
    render();
    return true;
  }

  function resolveRequestIfDecided(request) {
    const required = getRequiredVotes();
    const yes = countVotes(request, "yes");
    const no = countVotes(request, "no");
    const everyoneVoted = (request.votes || []).length >= state.users.length;

    if (yes >= required) {
      approveRequest(request);
      return;
    }

    if (no >= required || (everyoneVoted && yes < required)) {
      rejectRequest(request);
    }
  }

  function approveRequest(request) {
    request.status = "approved";
    request.resolvedAt = new Date().toISOString();

    const task = getTask(request.taskId);
    if (!task || task.status !== "open") {
      return;
    }

    if (request.type === "skip") {
      applySkipToTask(task, request);
    } else {
      applyPostponeToTask(task, request);
    }
  }

  function rejectRequest(request) {
    request.status = "rejected";
    request.resolvedAt = new Date().toISOString();

    const powody = (request.votes || [])
      .filter((vote) => vote.value === "no" && vote.reason)
      .map((vote) => `${getUser(vote.userId).name}: ${vote.reason}`)
      .join(" · ");

    const task = getTask(request.taskId);
    if (task) {
      task.history.push(historyEntry(`Dom odrzucił wniosek (${REQUEST_LABELS[request.type]})`, state.currentUserId));
      task.lastNotifiedAt = null;
    }

    notifyUsers([request.requestedById], {
      title: "Wniosek odrzucony",
      body: `„${request.taskTitle}” zostaje bez zmian. ${powody || "Domownicy zagłosowali przeciw."}`,
      taskId: request.taskId,
      push: true
    });

    if (request.requestedById === state.currentUserId) {
      toast("Wniosek odrzucony", "Zadanie zostaje w obecnym terminie.");
    }
  }

  function applySkipToTask(task, request) {
    task.status = "skipped";
    task.completedAt = new Date().toISOString();
    task.skippedById = request.requestedById;
    task.history.push(historyEntry(`Dom zgodził się: nie było potrzeby (0 pkt) — ${request.reason}`, state.currentUserId));

    let nextInfo = "Zadanie zamknięte bez punktów.";
    if (task.recurrence.type !== "none" && !task.isRewardTask) {
      const nextTask = createNextRecurringTask(task);
      task.nextRecurringTaskId = nextTask.id;
      state.tasks.unshift(nextTask);
      nextInfo = `Kolejny termin: ${formatHumanDate(nextTask.dueDate)}.`;
    }

    notifyUsers(
      state.users.map((user) => user.id).filter((id) => id !== state.currentUserId),
      {
        title: "Zamknięto: nie było potrzeby",
        body: `„${task.title}” — ${request.reason}. ${nextInfo}`,
        taskId: task.id,
        push: false
      }
    );

    toast("Nie było potrzeby", nextInfo);
  }

  function applyPostponeToTask(task, request) {
    const previous = task.dueDate;
    task.dueDate = request.proposedDueDate;
    task.assignedAt = new Date().toISOString();
    task.lastNotifiedAt = null;
    task.history.push(
      historyEntry(
        `Dom zgodził się na przełożenie: ${formatHumanDate(previous)} → ${formatHumanDate(task.dueDate)} — ${request.reason}`,
        state.currentUserId
      )
    );

    const zostalo = getRemainingPostpones(request.requestedById);
    notifyUsers(
      state.users.map((user) => user.id).filter((id) => id !== state.currentUserId),
      {
        title: "Zadanie przełożone",
        body: `„${task.title}” → ${formatHumanDate(task.dueDate)}. Powód: ${request.reason}`,
        taskId: task.id,
        push: false
      }
    );

    selectedDate = task.dueDate;
    calendarCursor = startOfMonth(fromISO(task.dueDate));
    toast("Przełożono zadanie", `Nowy termin: ${formatHumanDate(task.dueDate)}. Pozostało przełożeń w tym miesiącu: ${zostalo}.`);
  }

  function getSuggestedPostponeDate(task) {
    const today = todayIso();
    const base = task.dueDate > today ? task.dueDate : today;
    const proposal =
      task.recurrence.type !== "none" ? getNextDueDate(task.dueDate, task.recurrence.type) : toISO(addDays(fromISO(base), 3));
    return proposal > base ? proposal : toISO(addDays(fromISO(base), 1));
  }

  function reopenTask(taskId) {
    const task = getTask(taskId);
    if (!task) {
      return;
    }

    const wasSkipped = isSkipped(task);
    state.taskRequests = getTaskRequests().filter((item) => item.taskId !== task.id || item.status !== "pending");
    task.status = "open";
    task.completedAt = null;
    task.completedById = null;
    task.skippedById = null;
    reopenRewardClaim(task);
    const removedNextTask = removeGeneratedRecurringTask(task);
    task.history.push(historyEntry(wasSkipped ? "Cofnięto brak potrzeby" : "Przywrócono zadanie", state.currentUserId));
    saveState();
    toast(wasSkipped ? "Cofnięto brak potrzeby" : "Cofnięto ukończenie", removedNextTask ? "Usunięto też kolejny termin z cyklu." : task.title);
    render();
  }

  function deleteTask(taskId) {
    const task = getTask(taskId);
    if (!task) {
      toast("Nie znaleziono zadania", "Odśwież listę i spróbuj ponownie.");
      return;
    }

    const pointsText = task.status === "done" ? " Punkty za to zadanie też zostaną usunięte." : "";
    const confirmed = window.confirm(`Usunąć zadanie "${task.title}"? Tej operacji nie można cofnąć.${pointsText}`);
    if (!confirmed) {
      return;
    }

    state.tasks.forEach((item) => {
      if (item.nextRecurringTaskId === task.id) {
        item.nextRecurringTaskId = null;
      }
    });
    state.tasks = state.tasks.filter((item) => item.id !== task.id);
    state.pointEvents = state.pointEvents.filter((event) => event.taskId !== task.id);
    state.notifications = state.notifications.filter((item) => item.taskId !== task.id);
    // Rozstrzygnięte wnioski zostają (liczą się do miesięcznego limitu), ale
    // trwające głosowanie nad nieistniejącym zadaniem nie ma już sensu.
    state.taskRequests = getTaskRequests().filter((item) => item.taskId !== task.id || item.status !== "pending");
    state.rewardClaims = state.rewardClaims.filter((claim) => claim.taskId !== task.id);
    rememberDeletedTask(task.id);

    selectedTaskId = pickInitialTaskId();
    activeView = "tasks";
    activeModal = null;
    editingTaskId = null;
    saveState();
    toast("Usunięto zadanie", task.title);
    render();
  }

  function reassignTask(taskId, assigneeIds) {
    const task = getTask(taskId);
    const nextIds = Array.from(new Set((Array.isArray(assigneeIds) ? assigneeIds : [assigneeIds]).filter((id) => getUserById(id))));
    if (!task || !nextIds.length) {
      render();
      return;
    }

    const previousIds = getAssigneeIds(task);
    if (previousIds.length === nextIds.length && previousIds.every((id) => nextIds.includes(id))) {
      render();
      return;
    }

    // Zastępstwo: zabranie zadania osobie, której nie ma w domu. Wtedy nie ma
    // ani kary za zwłokę, ani transferu +10/-10 — to nie jest zrzucanie
    // obowiązku, tylko pokrycie kogoś, kto legalnie jest nieobecny.
    const zastepstwo = previousIds.some((id) => isUserAbsentNow(id));

    if (!zastepstwo) {
      previousIds.forEach((prevId) => {
        const dniZwloki = getOverdueDays(task, null, prevId);
        if (dniZwloki <= 0) {
          return;
        }
        addPointEvent({
          userId: prevId,
          taskId: task.id,
          delta: -(dniZwloki * 10) / previousIds.length,
          type: "overdue",
          text: `Kara za ${dniZwloki} dni zwłoki przed przepisaniem zadania`
        });
      });
    }

    task.assigneeIds = nextIds;
    task.assigneeId = nextIds[0];
    task.assignedAt = new Date().toISOString();
    const nextNames = nextIds.map((id) => getUser(id).name).join(", ");
    task.history.push(historyEntry(`Zmieniono przypisanie na: ${nextNames}`, state.currentUserId));

    const wasMine = previousIds.includes(state.currentUserId);
    const isMine = nextIds.includes(state.currentUserId);
    if (zastepstwo) {
      const nieobecni = previousIds
        .filter((id) => isUserAbsentNow(id))
        .map((id) => getUser(id).name)
        .join(", ");
      task.history.push(historyEntry(`Zastępstwo za: ${nieobecni} (bez transferu punktów)`, state.currentUserId));
    } else if (isMine && !wasMine) {
      addPointEvent({
        userId: state.currentUserId,
        taskId: task.id,
        delta: 10,
        type: "take",
        text: "Przejęto zadanie"
      });
      task.history.push(historyEntry("Bonus za przejęcie zadania: +10 pkt", state.currentUserId));
    } else if (wasMine && !isMine) {
      addPointEvent({
        userId: state.currentUserId,
        taskId: task.id,
        delta: -10,
        type: "give",
        text: "Oddano zadanie"
      });
      task.history.push(historyEntry("Kara za oddanie zadania: -10 pkt", state.currentUserId));
    }

    selectedTaskId = task.id;
    saveState();
    toast(
      zastepstwo ? "Zastępstwo przyjęte" : "Przypisanie zmienione",
      zastepstwo ? `${task.title} — bez transferu punktów` : `${task.title} → ${nextNames}`
    );
    render();
  }

  function removeUser(userId) {
    if (state.users.length <= 1) {
      toast("Nie można usunąć", "W domu musi zostać przynajmniej jeden domownik.");
      return;
    }

    const removedUser = getUser(userId);
    const remainingUsers = state.users.filter((user) => user.id !== userId);
    const affectedTasks = state.tasks.filter((task) => task.status !== "done" && isAssignee(task, userId));

    affectedTasks.forEach((task) => {
      const remainingAssignees = getAssigneeIds(task).filter((id) => id !== userId);
      if (remainingAssignees.length) {
        task.assigneeIds = remainingAssignees;
      } else {
        const nextUser = pickUserForRedistributedTask(remainingUsers);
        task.assigneeIds = [nextUser.id];
        task.history.push(historyEntry(`Przeniesiono po usunięciu: ${removedUser.name} → ${nextUser.name}`, state.currentUserId));
      }
      task.assigneeId = task.assigneeIds[0];
      task.assignedAt = new Date().toISOString();
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
    toast("Usunięto domownika", affectedTasks.length ? "Otwarte zadania zostały rozdzielone." : removedUser.name);
    render();
  }

  function pickUserForRedistributedTask(users) {
    const workload = new Map(users.map((user) => [user.id, 0]));

    state.tasks.forEach((task) => {
      if (task.status !== "done") {
        const share = getTaskPotentialPoints(task) / getAssigneeIds(task).length;
        getAssigneeIds(task).forEach((id) => {
          if (workload.has(id)) {
            workload.set(id, workload.get(id) + share);
          }
        });
      }
    });

    return users
      .map((user) => ({ user, load: workload.get(user.id) || 0 }))
      .sort((a, b) => a.load - b.load)[0].user;
  }

  function createNextRecurringTask(task) {
    const dueDate = getCaughtUpDueDate(getNextValidDueDate(task.dueDate, task.recurrence), task.recurrence);
    const assigneeIds = task.recurrence.rotate
      ? Array.from(new Set(getAssigneeIds(task).map((id) => getNextAvailableUserId(id, dueDate))))
      : getAssigneeIds(task).slice();
    const shoppingItems = isShoppingTask(task)
      ? task.shoppingItems.map((item) => ({
          ...item,
          id: uid("shop"),
          status: "pending"
        }))
      : [];
    const nextTask = {
      ...task,
      id: uid("task"),
      assigneeIds,
      assigneeId: assigneeIds[0],
      dueDate,
      status: "open",
      assignedAt: new Date().toISOString(),
      completedAt: null,
      completedById: null,
      skippedById: null,
      points: isShoppingTask(task) ? getShoppingPotentialPoints(shoppingItems) : task.points,
      shoppingItems,
      comments: [],
      history: [historyEntry("Utworzono z cyklu", state.currentUserId)],
      lastNotifiedAt: null,
      nextRecurringTaskId: null
    };

    return nextTask;
  }

  async function requestNotifications() {
    if (!("Notification" in window)) {
      toast("Powiadomienia niedostępne", "Ta przeglądarka nie obsługuje powiadomień.");
      return;
    }

    if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
      toast("Push niedostępny", "Na iPhonie dodaj HomeJob do ekranu początkowego i otwórz aplikację z ikony.");
      return;
    }

    if (!window.isSecureContext) {
      toast("Wymagane HTTPS", "Push działa dopiero na opublikowanej stronie HTTPS.");
      return;
    }

    try {
      const permission = await Notification.requestPermission();
      if (permission !== "granted") {
        localStorage.removeItem(WEB_PUSH_ENABLED_KEY);
        toast("Powiadomienia wyłączone", "Alerty w aplikacji nadal będą działać po jej otwarciu.");
        render();
        return;
      }

      const registration = serviceWorkerRegistration || (await registerServiceWorker());
      if (!registration?.pushManager) {
        toast("Push niedostępny", "Nie udało się uruchomić service workera.");
        return;
      }

      const existingSubscription = await registration.pushManager.getSubscription();
      const subscription =
        existingSubscription ||
        (await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY)
        }));

      await savePushSubscription(subscription);
      localStorage.setItem(WEB_PUSH_ENABLED_KEY, "true");
      toast("Powiadomienia push włączone", "Dostaniesz plan dnia o 08:00 i przypomnienia o godzinie zadania.");
    } catch (error) {
      console.warn("Nie udało się włączyć Web Push", error);
      localStorage.removeItem(WEB_PUSH_ENABLED_KEY);
      toast("Nie udało się włączyć push", "Sprawdź uprawnienia powiadomień i spróbuj ponownie.");
    }

    render();
  }

  // iOS potrafi unieważnić subskrypcję bez pytania. Wcześniej adres trafiał
  // na serwer wyłącznie przy ręcznym włączeniu powiadomień, więc po rotacji
  // worker wysyłał w pustkę: usługa push przyjmowała żądanie (sent_at bez
  // błędu), a telefon nie dostawał nic. Teraz przy każdym starcie
  // przypominamy serwerowi aktualny adres.
  async function odswiezSubskrypcjePush() {
    try {
      if (!("serviceWorker" in navigator) || typeof Notification === "undefined") {
        return;
      }
      // Nie sprawdzamy własnej flagi w localStorage: usunięcie aplikacji z
      // ekranu głównego kasuje ją razem z service workerem i subskrypcją.
      // Zgoda systemowa zostaje, więc to ona decyduje, czy się rejestrować.
      if (Notification.permission !== "granted") {
        return;
      }
      const registration = await navigator.serviceWorker.ready;
      const subscription = await registration.pushManager?.getSubscription();
      if (subscription) {
        await savePushSubscription(subscription);
        localStorage.setItem(WEB_PUSH_ENABLED_KEY, "true");
        return;
      }
      // Subskrypcja zniknęła — zakładamy ją od nowa.
      const swieza = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY)
      });
      await savePushSubscription(swieza);
      localStorage.setItem(WEB_PUSH_ENABLED_KEY, "true");
    } catch (error) {
      console.warn("Nie udało się odświeżyć subskrypcji push", error);
    }
  }

  async function savePushSubscription(subscription) {
    const response = await fetch(API_PUSH_SUBSCRIPTION_ENDPOINT, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        ...getAuthHeaders()
      },
      body: JSON.stringify({ subscription: subscription.toJSON() })
    });

    if (!response.ok) {
      throw new Error(`Push subscription responded with ${response.status}`);
    }
  }

  function notifyNewTask(task) {
    const creator = getUser(state.currentUserId);
    const isRecurring = task.recurrence.type !== "none";
    const title = isRecurring ? "Nowe zadanie cykliczne" : "Nowe zadanie";
    const body = `${creator.name} dodał(a): ${task.title}`;

    state.users
      .filter((user) => user.id !== state.currentUserId)
      .forEach((user) => {
        state.notifications.unshift({
          id: uid("notification"),
          taskId: task.id,
          title,
          body,
          recipientUserId: user.id,
          read: false,
          createdAt: new Date().toISOString()
        });
      });

    state.notifications = state.notifications.slice(0, NOTIFICATIONS_LIMIT);
  }

  function maybeSuggestReassign(task) {
    if (isHomeBonusActive()) {
      return;
    }
    const assigneeIds = getAssigneeIds(task);
    if (!assigneeIds.every((id) => hasReachedGoal(id))) {
      return;
    }
    const suggestion = getSuggestedAssignee();
    if (suggestion && !assigneeIds.includes(suggestion.id) && !hasReachedGoal(suggestion.id)) {
      toast("Cel osiągnięty", `Rozważ przypisanie kolejnych zadań na: ${suggestion.name}.`);
    }
  }

  function runReminderSweep() {
    const dueTasks = getDueReminderTasks();
    if (!dueTasks.length) {
      return;
    }

    dueTasks.forEach((task) => {
      const title = isOverdue(task) ? "Zaległe zadanie" : "Zadanie na dziś";
      const body = `${task.title} · ${formatAssigneeNames(task)} · ${task.reminderTime}`;

      state.notifications.unshift({
        id: uid("notification"),
        taskId: task.id,
        title,
        body,
        recipientUserId: state.currentUserId,
        read: false,
        createdAt: new Date().toISOString()
      });

      task.lastNotifiedAt = new Date().toISOString();
      if (!isWebPushEnabled()) {
        showSystemNotification(title, body, task.id);
      }
    });

    state.notifications = state.notifications.slice(0, NOTIFICATIONS_LIMIT);
    saveState();
    if (!activeModal) {
      render();
    }
  }

  function getDueReminderTasks() {
    if (isUserAbsentNow(state.currentUserId)) {
      return [];
    }

    const now = new Date();
    const today = toISO(now);
    const currentMinutes = now.getHours() * 60 + now.getMinutes();

    return state.tasks.filter((task) => {
      if (task.status !== "open" || !task.reminderTime || !isAssignee(task, state.currentUserId)) {
        return false;
      }

      if (task.dueDate > today) {
        return false;
      }

      // Zadanie z wnioskiem w głosowaniu czeka na decyzję domu — nie ma po co
      // o nim przypominać, dopóki nie wiadomo, czy zostaje na dziś.
      if (getPendingRequestForTask(task.id)) {
        return false;
      }

      const [hour, minute] = task.reminderTime.split(":").map(Number);
      const reminderMinutes = hour * 60 + minute;
      if (currentMinutes < reminderMinutes) {
        return false;
      }

      // Jedno przypomnienie na zadanie na dobę. Wcześniej powtarzało się co
      // 30 minut aż do północy, co przy kilku zaległościach zasypywało telefon.
      return !task.lastNotifiedAt || toISO(new Date(task.lastNotifiedAt)) !== today;
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
          icon: "./icon-192.png?v=48",
          badge: "./icon-192.png?v=48"
        });
      } else {
        const notification = new Notification(title, { body, icon: "./icon-192.png?v=48", tag: taskId });
        notification.onclick = () => window.focus();
      }
    } catch (error) {
      console.warn("Nie udało się pokazać powiadomienia", error);
    }
  }

  function isWebPushEnabled() {
    return localStorage.getItem(WEB_PUSH_ENABLED_KEY) === "true";
  }

  function urlBase64ToUint8Array(value) {
    const padding = "=".repeat((4 - (value.length % 4)) % 4);
    const base64 = `${value}${padding}`.replace(/-/g, "+").replace(/_/g, "/");
    const raw = window.atob(base64);
    const output = new Uint8Array(raw.length);

    for (let index = 0; index < raw.length; index += 1) {
      output[index] = raw.charCodeAt(index);
    }

    return output;
  }

  async function registerServiceWorker() {
    if (!("serviceWorker" in navigator)) {
      return null;
    }

    try {
      serviceWorkerRegistration = await navigator.serviceWorker.register("./sw.js");
      return serviceWorkerRegistration;
    } catch (error) {
      console.warn("Service worker nie został zarejestrowany", error);
      return null;
    }
  }

  function getFilteredTasks() {
    let tasks = [...state.tasks];

    if (activeFilter === "mine") {
      tasks = tasks.filter((task) => isAssignee(task, state.currentUserId));
    } else if (activeFilter === "mine-today") {
      tasks = tasks.filter((task) => isAssignee(task, state.currentUserId) && isToday(task) && task.status === "open");
    } else if (activeFilter === "mine-overdue") {
      tasks = tasks.filter((task) => isAssignee(task, state.currentUserId) && isOverdue(task));
    } else if (activeFilter === "today") {
      tasks = tasks.filter((task) => isToday(task) && task.status === "open");
    } else if (activeFilter === "overdue") {
      tasks = tasks.filter((task) => isOverdue(task));
    } else if (activeFilter === "done") {
      tasks = tasks.filter((task) => task.status === "done");
    } else if (activeFilter === "done-today") {
      tasks = tasks.filter((task) => task.status === "done" && task.completedAt && toISO(new Date(task.completedAt)) === todayIso());
    }

    if (searchQuery.trim()) {
      const query = searchQuery.trim().toLocaleLowerCase("pl-PL");
      tasks = tasks.filter((task) =>
        `${task.title} ${isShoppingTask(task) ? "zakupy " + shoppingItemsToText(task.shoppingItems) : ""} ${
          getAssignees(task).map((user) => user.name).join(" ")
        }`
          .toLocaleLowerCase("pl-PL")
          .includes(query)
      );
    }

    return sortTasks(tasks);
  }

  // sortTasks porządkuje po terminie, co przy liście ukończonych wypychało
  // na górę najstarsze zadania. Tutaj liczy się moment ukończenia.
  function sortByCompletedDesc(tasks) {
    return tasks.slice().sort((a, b) => {
      const czasA = a.completedAt ? new Date(a.completedAt).getTime() : 0;
      const czasB = b.completedAt ? new Date(b.completedAt).getTime() : 0;
      if (czasA !== czasB) {
        return czasB - czasA;
      }
      return b.dueDate.localeCompare(a.dueDate);
    });
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
    const today = todayIso();
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
      // Od najnowszych — aktywność czyta się od tego, co przed chwilą się wydarzyło.
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
      .slice(0, HISTORY_FEED_LIMIT);
  }

  function isShoppingTask(task) {
    return task?.type === "shopping";
  }

  function normalizeShoppingItems(items) {
    if (!Array.isArray(items)) {
      return [];
    }

    return items
      .map((item) => {
        const name = String(item?.name || "").trim();
        const status = ["pending", "bought", "unavailable"].includes(item?.status) ? item.status : "pending";
        return {
          id: item?.id || uid("shop"),
          name,
          status
        };
      })
      .filter((item) => item.name);
  }

  function buildShoppingItemsFromText(text, existingItems = []) {
    const existingByName = new Map(
      normalizeShoppingItems(existingItems).map((item) => [item.name.toLocaleLowerCase("pl-PL"), item])
    );

    return String(text || "")
      .split(/\r?\n/)
      .map((item) => item.trim())
      .filter(Boolean)
      .map((name) => {
        const existing = existingByName.get(name.toLocaleLowerCase("pl-PL"));
        return {
          id: existing?.id || uid("shop"),
          name,
          status: existing?.status || "pending"
        };
      });
  }

  function shoppingItemsToText(items) {
    return normalizeShoppingItems(items)
      .map((item) => item.name)
      .join("\n");
  }

  function getShoppingSummary(task) {
    const items = normalizeShoppingItems(task.shoppingItems);
    const bought = items.filter((item) => item.status === "bought").length;
    const unavailable = items.filter((item) => item.status === "unavailable").length;
    return {
      total: items.length,
      bought,
      unavailable,
      resolved: bought + unavailable
    };
  }

  function isShoppingResolved(task) {
    const summary = getShoppingSummary(task);
    return summary.total > 0 && summary.resolved === summary.total;
  }

  function getShoppingPotentialPoints(items) {
    return SHOPPING_DELIVERY_POINTS + normalizeShoppingItems(items).length * SHOPPING_ITEM_POINTS;
  }

  function getShoppingCurrentPoints(task) {
    const deliveryPoints = task.status === "done" || isShoppingResolved(task) ? SHOPPING_DELIVERY_POINTS : 0;
    return deliveryPoints + getShoppingSummary(task).bought * SHOPPING_ITEM_POINTS;
  }

  function getTaskPotentialPoints(task) {
    if (task.isRewardTask) {
      return 5;
    }
    if (isShoppingTask(task)) {
      return getShoppingPotentialPoints(task.shoppingItems);
    }
    return Number(task.points) || PRIORITY[task.priority || "medium"].points;
  }

  function getTaskPoints(task) {
    if (task.isRewardTask) {
      return 5;
    }
    if (isShoppingTask(task)) {
      return getShoppingCurrentPoints(task);
    }
    return Number(task.points) || 0;
  }

  function getTaskPointsLabel(task) {
    if (!isShoppingTask(task)) {
      const total = getTaskPoints(task);
      const count = getAssigneeIds(task).length;
      if (count > 1) {
        return `${formatPoints(total)} pkt (${formatPoints(total / count)} pkt/os. × ${count})`;
      }
      return `${formatPoints(total)} pkt`;
    }

    return `${formatPoints(getShoppingCurrentPoints(task))} / ${formatPoints(getShoppingPotentialPoints(task.shoppingItems))} pkt`;
  }

  function renderShoppingShortSummary(task) {
    const summary = getShoppingSummary(task);
    return `${summary.bought}/${summary.total} kupione`;
  }

  function formatPoints(points) {
    const value = Number(points) || 0;
    return Number.isInteger(value) ? String(value) : value.toLocaleString("pl-PL", { maximumFractionDigits: 1 });
  }

  function renderShoppingItemModal() {
    const task = getTask(shoppingModalTaskId);
    if (!task || !isShoppingTask(task)) {
      return "";
    }

    const items = normalizeShoppingItems(task.shoppingItems);

    return `
      <div class="modal-backdrop" role="presentation" data-action="close-shopping-item-modal">
        <section class="modal modal-slim" role="dialog" aria-modal="true" aria-labelledby="shopping-item-title">
          <div class="modal-head">
            <h2 class="modal-title" id="shopping-item-title">Dodaj produkt</h2>
            <button class="icon-button" type="button" data-action="close-shopping-item-modal" aria-label="Zamknij">×</button>
          </div>
          <form class="shopping-add-form" data-form="shopping-item" data-task-id="${task.id}">
            <input
              class="input"
              name="produkt"
              placeholder="Np. mleko"
              autocomplete="off"
              enterkeyhint="done"
              maxlength="60"
              required
            />
            <button class="button" type="submit">Dodaj</button>
          </form>
          <p class="form-hint">Produkt dopisze się na koniec listy. Możesz dodać kilka po kolei.</p>
          <div class="shopping-add-list">
            ${
              items.length
                ? items
                    .map(
                      (item) => `
                        <div class="shopping-add-row">
                          <span>${escapeHtml(item.name)}</span>
                          <button
                            class="ghost-button"
                            type="button"
                            data-action="remove-shopping-item"
                            data-task-id="${task.id}"
                            data-item-id="${item.id}"
                            aria-label="Usuń ${escapeAttribute(item.name)}"
                          >Usuń</button>
                        </div>
                      `
                    )
                    .join("")
                : `<p class="form-hint">Lista jest jeszcze pusta.</p>`
            }
          </div>
          <div class="form-actions">
            <button class="button" type="button" data-action="close-shopping-item-modal">Gotowe</button>
          </div>
        </section>
      </div>
    `;
  }

  function addShoppingItem(taskId, rawName) {
    const task = getTask(taskId);
    if (!task || !isShoppingTask(task) || task.status === "done") {
      return;
    }

    const name = String(rawName || "").trim();
    if (!name) {
      return;
    }

    const items = normalizeShoppingItems(task.shoppingItems);
    const juzJest = items.some((item) => item.name.toLocaleLowerCase("pl-PL") === name.toLocaleLowerCase("pl-PL"));
    if (juzJest) {
      toast("Ten produkt już tam jest", `„${name}" jest na liście.`);
      render();
      return;
    }

    task.shoppingItems = [...items, { id: uid("shop"), name, status: "pending" }];
    task.points = getTaskPotentialPoints(task);
    task.history.push(historyEntry(`Dopisano do listy: ${name}`, state.currentUserId));

    saveState();
    render();
    queueMicrotask(() => document.querySelector("[name='produkt']")?.focus());
  }

  function removeShoppingItem(taskId, itemId) {
    const task = getTask(taskId);
    if (!task || !isShoppingTask(task) || task.status === "done") {
      return;
    }

    const items = normalizeShoppingItems(task.shoppingItems);
    const item = items.find((entry) => entry.id === itemId);
    if (!item) {
      return;
    }

    if (items.length === 1) {
      toast("Lista nie może zostać pusta", "Zakupy bez produktów nie mają czego rozliczyć.");
      render();
      return;
    }

    task.shoppingItems = items.filter((entry) => entry.id !== itemId);
    task.points = getTaskPotentialPoints(task);
    task.history.push(historyEntry(`Usunięto z listy: ${item.name}`, state.currentUserId));

    saveState();
    render();
  }

  function updateShoppingItemStatus(taskId, itemId, status) {
    const task = getTask(taskId);
    if (!task || !isShoppingTask(task) || task.status === "done") {
      return;
    }

    if (!isAssignee(task, state.currentUserId)) {
      toast("To nie Twoje zakupy", "Najpierw przepisz zadanie na siebie.");
      render();
      return;
    }

    const item = task.shoppingItems.find((entry) => entry.id === itemId);
    if (!item) {
      return;
    }

    item.status = status;
    task.points = getTaskPotentialPoints(task);

    if (isShoppingResolved(task)) {
      completeTask(task.id);
      return;
    }

    saveState();
    render();
  }

  function toggleShoppingItemMissing(taskId, itemId) {
    const task = getTask(taskId);
    const item = task?.shoppingItems?.find((entry) => entry.id === itemId);
    if (!item) {
      return;
    }

    updateShoppingItemStatus(taskId, itemId, item.status === "unavailable" ? "pending" : "unavailable");
  }

  function getBaseUserPoints(userId, lastDays = null) {
    const completedPoints = state.tasks
      .filter((task) => task.status === "done" && isAssignee(task, userId))
      .filter((task) => (lastDays ? isWithinLastDays(task.completedAt, lastDays) : isInCurrentPointPeriod(task.completedAt)))
      .reduce((sum, task) => sum + getTaskPoints(task) / getAssigneeIds(task).length, 0);

    const transferPoints = state.pointEvents
      .filter((event) => event.userId === userId)
      .filter((event) => (lastDays ? isWithinLastDays(event.createdAt, lastDays) : isInCurrentPointPeriod(event.createdAt)))
      .reduce((sum, event) => sum + event.delta, 0);

    const overduePenalty = state.tasks.reduce((sum, task) => {
      const penaltyIds = getPenaltyUserIds(task);
      if (!penaltyIds.includes(userId)) {
        return sum;
      }
      return sum - (getOverdueDays(task, lastDays || "month", userId) * 10) / penaltyIds.length;
    }, 0);

    return completedPoints + transferPoints + overduePenalty;
  }

  function getUserPoints(userId, lastDays = null) {
    const base = getBaseUserPoints(userId, lastDays);
    if (lastDays != null || !isHomeBonusActive() || base <= MONTHLY_GOAL) {
      return base;
    }
    // Premia dotyczy wyłącznie NADWYŻKI ponad cel. Podwajanie całej puli
    // sprawiało, że sama premia wypychała każdego przez progi nagród —
    // wystarczyło przenieść punkty na nowy miesiąc, żeby nagroda należała
    // się od pierwszego dnia.
    return MONTHLY_GOAL + (base - MONTHLY_GOAL) * 2;
  }

  // Zadanie porzucone przez nieobecnych staje się długiem całego domu: nieobecny
  // nie płaci nic, płacą ci, którzy byli na miejscu i mogli je przejąć. Bez tego
  // wyjazd zamieniał się w rosnący minus dla osoby, która i tak nie mogła nic zrobić.
  function isAbandonedByAbsence(task) {
    if (task.status !== "open" || isSkipped(task) || task.isRewardTask) {
      return false;
    }
    const assignees = getAssigneeIds(task);
    if (!assignees.length || !assignees.every((id) => isUserAbsentNow(id))) {
      return false;
    }
    // Pauza całego domu to nie porzucenie — wtedy nikt nie płaci.
    return getPresentUserIds().length > 0;
  }

  function getPresentUserIds() {
    return state.users.filter((user) => !isUserAbsentNow(user.id)).map((user) => user.id);
  }

  function getPenaltyUserIds(task) {
    if (isSkipped(task)) {
      return [];
    }
    if (task.status === "done") {
      return getAssigneeIds(task);
    }
    if (isAbandonedByAbsence(task)) {
      return getPresentUserIds();
    }
    return getAssigneeIds(task);
  }

  function hasReachedGoal(userId) {
    return getBaseUserPoints(userId) >= MONTHLY_GOAL;
  }

  function isHomeBonusActive() {
    return Boolean(state.household.homeBonus && state.household.homeBonus === getPointPeriodKey());
  }

  function refreshHomeBonus() {
    if (state.users.length < 2) {
      return false;
    }
    const currentPeriod = getPointPeriodKey();
    if (state.household.homeBonus === currentPeriod) {
      return false;
    }
    const everyoneReached = state.users.every((user) => getBaseUserPoints(user.id) >= MONTHLY_GOAL);
    if (everyoneReached) {
      state.household.homeBonus = currentPeriod;
      state.users.forEach((user) => {
        state.notifications.unshift({
          id: uid("notification"),
          taskId: null,
          kind: "bonus",
          push: true,
          title: "Premia domowa włączona",
          body: `Cały dom przekroczył ${MONTHLY_GOAL} pkt. Od teraz punkty ponad ${MONTHLY_GOAL} liczą się podwójnie.`,
          recipientUserId: user.id,
          read: false,
          createdAt: new Date().toISOString()
        });
      });
      state.notifications = state.notifications.slice(0, NOTIFICATIONS_LIMIT);
      return true;
    }
    return false;
  }

  function getSuggestedAssignee(excludeUserId = null) {
    return state.users
      .filter((user) => user.id !== excludeUserId)
      .map((user) => ({ user, points: getBaseUserPoints(user.id) }))
      .sort((a, b) => a.points - b.points)[0]?.user;
  }

  function processMonthlyCarryover() {
    if (!state.users.length) {
      return false;
    }
    const currentPeriod = getPointPeriodKey();
    if (state.household.carryoverDonePeriod === currentPeriod) {
      return false;
    }

    const prevPeriodDate = new Date(getPointPeriodStart().getTime() - 24 * 60 * 60 * 1000);
    const prevPeriod = getPointPeriodKey(prevPeriodDate);
    let changed = false;

    state.users.forEach((user) => {
      const prevTotal = getPeriodEarnedPoints(user.id, prevPeriod);
      const overflow = Math.max(0, prevTotal - MONTHLY_GOAL);
      const bonus = Math.floor(overflow / CARRYOVER_DIVISOR);
      if (bonus <= 0) {
        return;
      }
      const eventId = `carryover-${user.id}-${currentPeriod}`;
      if (state.pointEvents.some((event) => event.id === eventId)) {
        return;
      }
      state.pointEvents.unshift({
        id: eventId,
        userId: user.id,
        taskId: null,
        delta: bonus,
        type: "carryover",
        text: `Bonus z poprzedniego miesiąca (nadwyżka ${formatPoints(overflow)} pkt ÷ ${CARRYOVER_DIVISOR})`,
        createdAt: new Date().toISOString()
      });
      changed = true;
    });

    state.household.carryoverDonePeriod = currentPeriod;
    return changed || true;
  }

  function getPeriodEarnedPoints(userId, periodKey) {
    const completedPoints = state.tasks
      .filter((task) => task.status === "done" && isAssignee(task, userId))
      .filter((task) => getPointPeriodKey(task.completedAt) === periodKey)
      .reduce((sum, task) => sum + getTaskPoints(task) / getAssigneeIds(task).length, 0);

    const transferPoints = state.pointEvents
      .filter((event) => event.userId === userId && event.type !== "carryover")
      .filter((event) => getPointPeriodKey(event.createdAt) === periodKey)
      .reduce((sum, event) => sum + event.delta, 0);

    return completedPoints + transferPoints;
  }

  function getOverdueDays(task, lastDays = null, userId = null) {
    if (isSkipped(task) || task.isRewardTask) {
      return 0;
    }
    const dueDate = fromISO(task.dueDate);
    const assignedDate = task.assignedAt ? fromISO(toISO(new Date(task.assignedAt))) : dueDate;
    const penaltyBaseDate = assignedDate > dueDate ? assignedDate : dueDate;
    const endDate =
      task.status === "done" && task.completedAt ? fromISO(toISO(new Date(task.completedAt))) : fromISO(todayIso());

    if (daysBetween(penaltyBaseDate, endDate) <= 0) {
      return 0;
    }

    let startDate = addDays(penaltyBaseDate, 1);
    if (lastDays === "month") {
      const windowStart = getPointPeriodStart();
      if (windowStart > startDate) {
        startDate = windowStart;
      }
    } else if (lastDays) {
      const windowStart = fromISO(toISO(addDays(new Date(), -(lastDays - 1))));
      if (windowStart > startDate) {
        startDate = windowStart;
      }
    }

    if (startDate > endDate) {
      return 0;
    }

    const totalDays = daysBetween(startDate, endDate) + 1;
    // Bez wskazanej osoby odliczamy tylko pauzę domu; ze wskazaną — również jej
    // własną nieobecność, żeby wyjazd nie generował kar za zwłokę.
    const excusedDays = userId
      ? countExcusedDaysInRange(userId, startDate, endDate)
      : countPausedDaysInRange(startDate, endDate);
    return Math.max(0, totalDays - excusedDays);
  }

  function getPointPeriodStart(date = new Date()) {
    return new Date(date.getFullYear(), date.getMonth(), 1);
  }

  function getPointPeriodKey(dateValue = new Date()) {
    const date = dateValue instanceof Date ? dateValue : new Date(dateValue || Date.now());
    const month = String(date.getMonth() + 1).padStart(2, "0");
    return `${date.getFullYear()}-${month}`;
  }

  function isInCurrentPointPeriod(dateString) {
    if (!dateString) {
      return false;
    }
    return new Date(dateString) >= getPointPeriodStart();
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
    const currentPeriod = getPointPeriodKey();

    state.users.forEach((user) => {
      const points = getUserPoints(user.id);

      getRewardThresholds().forEach((threshold) => {
        const alreadyClaimed = state.rewardClaims.some(
          (claim) =>
            claim.userId === user.id &&
            claim.threshold === threshold.points &&
            getRewardClaimPeriod(claim) === currentPeriod
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
          period: currentPeriod,
          createdAt: new Date().toISOString(),
          completedAt: null
        });

        state.tasks.unshift(task);
        state.notifications.unshift({
          id: uid("notification"),
          taskId: task.id,
          kind: "reward",
          push: true,
          rewardUserName: user.name,
          rewardThreshold: threshold.points,
          title: "Nagroda do przyznania",
          body: `${user.name} ma już ${threshold.points} pkt i czeka na nagrodę.`,
          recipientUserId: rewardAssignee.id,
          read: false,
          createdAt: new Date().toISOString()
        });
        changed = true;
      });
    });

    state.notifications = state.notifications.slice(0, NOTIFICATIONS_LIMIT);
    return changed;
  }

  function pickRewardAssignee(rewardedUserId) {
    return state.users
      .filter((user) => user.id !== rewardedUserId)
      .map((user) => ({ user, points: getUserPoints(user.id) }))
      .sort((a, b) => a.points - b.points)[0]?.user;
  }

  function getRewardClaimPeriod(claim) {
    return claim.period || getPointPeriodKey(claim.createdAt);
  }

  function createRewardTask(rewardedUser, assignee, threshold) {
    const dueDate = toISO(addDays(new Date(), 7));

    return {
      id: uid("task"),
      title: `Przyznaj nagrodę dla ${rewardedUser.name}`,
      room: "Nagrody",
      assigneeId: assignee.id,
      assigneeIds: [assignee.id],
      createdById: rewardedUser.id,
      dueDate,
      reminderTime: "09:00",
      assignedAt: new Date().toISOString(),
      priority: "medium",
      status: "open",
      completedAt: null,
      completedById: null,
      skippedById: null,
      recurrence: { type: "none", rotate: false },
      points: 5,
      isRewardTask: true,
      rewardForUserId: rewardedUser.id,
      rewardThreshold: threshold.points,
      rewardPeriod: getPointPeriodKey(),
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

  function reopenRewardClaim(task) {
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
      claim.status = "pending";
      claim.completedAt = null;
    }
  }

  function removeGeneratedRecurringTask(task) {
    if (!task.nextRecurringTaskId) {
      return false;
    }

    const generatedTask = getTask(task.nextRecurringTaskId);
    task.nextRecurringTaskId = null;

    if (!generatedTask || generatedTask.status === "done") {
      return false;
    }

    state.tasks = state.tasks.filter((item) => item.id !== generatedTask.id);
    rememberDeletedTask(generatedTask.id);
    task.history.push(historyEntry("Usunięto kolejne wystąpienie z cyklu", state.currentUserId));
    return true;
  }

  function rememberDeletedTask(taskId) {
    state.deletedTaskIds = [
      { id: taskId, deletedAt: new Date().toISOString() },
      ...(state.deletedTaskIds || []).filter((item) => item.id !== taskId)
    ].slice(0, DELETED_TASKS_LIMIT);
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
    if (recurrenceType === "daily") {
      return toISO(addDays(date, 1));
    }
    if (recurrenceType === "every2days") {
      return toISO(addDays(date, 2));
    }
    if (recurrenceType === "every3days") {
      return toISO(addDays(date, 3));
    }
    if (recurrenceType === "weekly") {
      return toISO(addDays(date, 7));
    }
    if (recurrenceType === "biweekly") {
      return toISO(addDays(date, 14));
    }
    if (recurrenceType === "triweekly") {
      return toISO(addDays(date, 21));
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

  function getIsoWeekday(dateIso) {
    return (fromISO(dateIso).getDay() + 6) % 7;
  }

  function getNextValidDueDate(dateIso, recurrence) {
    let next = getNextDueDate(dateIso, recurrence.type);
    let guard = 0;
    while (guard < 400) {
      const skippedWeekday = recurrence.skipWeekdays?.length && recurrence.skipWeekdays.includes(getIsoWeekday(next));
      const pausedDay = isDateWithinPause(next);
      if (!skippedWeekday && !pausedDay) {
        break;
      }
      next = getNextDueDate(next, recurrence.type);
      guard += 1;
    }
    return next;
  }

  // Kolejne wystąpienie cyklu musi wypaść PO dzisiejszym dniu. Wcześniej pętla
  // kończyła się na „dziś”, więc zamknięcie zaległego zadania (a zwłaszcza
  // „nie ma potrzeby”) natychmiast tworzyło nowe zadanie na dziś — z terminem,
  // który już minął. Efekt: przypomnienia i „niewykonane zadanie” tego samego
  // wieczoru, mimo że zadanie zostało właśnie zamknięte.
  function getCaughtUpDueDate(dateIso, recurrence) {
    const today = todayIso();
    let next = dateIso;
    let guard = 0;
    while (next <= today && guard < 1000) {
      next = getNextValidDueDate(next, recurrence);
      guard += 1;
    }
    return next;
  }

  function getNextUserId(currentId) {
    const index = state.users.findIndex((user) => user.id === currentId);
    if (index === -1) {
      return state.users[0].id;
    }
    return state.users[(index + 1) % state.users.length].id;
  }

  function getProjectedOccurrencesByDay(rangeStartIso, rangeEndIso) {
    const byDay = new Map();

    state.tasks.forEach((task) => {
      if (task.status !== "open" || task.recurrence.type === "none" || task.isRewardTask || isShoppingTask(task)) {
        return;
      }

      const horizon = toISO(addDays(fromISO(task.dueDate), RECURRING_PROJECTION_DAYS));
      let dueDate = task.dueDate;
      let assigneeIds = getAssigneeIds(task);
      let guard = 0;

      while (guard < 500) {
        guard += 1;
        dueDate = getNextValidDueDate(dueDate, task.recurrence);
        if (dueDate > horizon || dueDate > rangeEndIso) {
          break;
        }

        assigneeIds = task.recurrence.rotate
          ? Array.from(new Set(assigneeIds.map((id) => getNextUserId(id))))
          : assigneeIds;

        if (dueDate >= rangeStartIso) {
          const occurrence = {
            id: `${task.id}__projected__${dueDate}`,
            sourceTaskId: task.id,
            title: task.title,
            dueDate,
            reminderTime: task.reminderTime,
            assigneeIds,
            assigneeId: assigneeIds[0],
            priority: task.priority,
            recurrence: task.recurrence,
            isProjected: true
          };
          if (!byDay.has(dueDate)) {
            byDay.set(dueDate, []);
          }
          byDay.get(dueDate).push(occurrence);
        }
      }
    });

    return byDay;
  }

  function pickInitialTaskId() {
    const current = state.tasks
      ?.filter((task) => isAssignee(task, state.currentUserId) && task.status === "open")
      .sort((a, b) => a.dueDate.localeCompare(b.dueDate))[0];
    return current?.id || state.tasks?.[0]?.id || null;
  }

  function getRouteTaskId() {
    return new URLSearchParams(window.location.search).get("task");
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

  function getUserById(userId) {
    return state.users.find((user) => user.id === userId) || null;
  }

  function isOpen(task) {
    return task.status === "open";
  }

  function isToday(task) {
    return task.dueDate === todayIso();
  }

  function isOverdue(task) {
    return task.status === "open" && task.dueDate < todayIso();
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
    return { urgent: -1, high: 0, medium: 1, low: 2 }[priority] ?? 1;
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
    const today = todayIso();
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
