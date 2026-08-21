# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

HomeJob is a Polish-language web/PWA app for managing household chores across multiple households ("gospodarstwa domowe"). Mobile-first, tuned specifically for iPhone. No build tooling — plain HTML/CSS/JS served as static files, deployed on Cloudflare Pages.

## Architecture

- **Frontend**: static files (`index.html`, `app.js`, `styles.css`, `sw.js`, `manifest.webmanifest`) served directly by Cloudflare Pages — no bundler, no framework, no package.json. Cache-busted via a shared `?v=NN` query param that must be bumped in `index.html`, `sw.js` (`CACHE_NAME` and `ASSETS`), and `manifest.webmanifest` together whenever any of those files changes.
- **`app.js`** is a single IIFE containing the entire client app: state, routing, rendering, and API sync. Key structure:
  - In-memory `state` object (household, users, tasks, pointEvents, notifications, rewardClaims) persisted to `localStorage` and synced to `/api/state` (debounced via `SYNC_DEBOUNCE_MS`).
  - `session` (current household/user/pin) is separate from `state` and stored under its own localStorage key; `knownHouseholds` caches previously joined households for quick re-login.
  - No client-side router library — `activeView` is a string switched in `renderActiveView()` (`dashboard`, `tasks`, `task-detail`, `calendar`, `team`, `reminders`, `activity`, `rewards`). Views beyond `dashboard`/`tasks`/`calendar`/`task-detail` live behind the mobile "Więcej" (More) menu.
  - Rendering is manual: `render()` re-generates HTML strings and diffs nothing — the whole app re-renders on every state change. Global `click`/`change`/`input`/`submit` listeners on `document` dispatch to handlers rather than per-element listeners.
  - Auth to the backend is PIN-based per household member, sent via `x-household-id` / `x-household-user` / `x-household-pin` headers (mirrored in `functions/api/*.js`) — there are no roles/admins, any member can edit anything.
- **Backend**: Cloudflare Pages Functions in `functions/api/*.js`, one file per route (`state.js` → `/api/state`, `push-subscription.js` → `/api/push-subscription`, `push-payload.js` → `/api/push-payload`). Each function calls its own `ensureSchema`/`ensurePushSchema` to create tables if missing, so schema also lives inline in the functions, in addition to the root `.sql` files.
- **Database**: Cloudflare D1. `schema.sql` is destructive (drops and recreates `households`); `push-schema.sql` is an additive, non-destructive migration for the push tables. Each household is one row in `households`, with the entire app state for that household serialized as JSON in the `value` column — there is no per-entity table for tasks/users/etc.
- **Push notifications**: `sw.js` handles service-worker push/notification-click and polls `/api/push-payload` for pending messages. Actual push delivery/scheduling is a separate Cloudflare Worker (`workers/push-reminders.js`, config in `workers/wrangler.toml`) running on a cron trigger, computing times in the `Europe/Warsaw` timezone, reading/writing the same D1 database via its own `DB` binding.

## Deployment

There is no local dev server or test suite in this repo — changes are validated by deploying.

- **Pages**: framework preset `None`, empty build command, build output directory `.`. Requires a D1 binding named exactly `DB`.
- **DB setup**: run `schema.sql` once to initialize (destructive — wipes existing data). Run `push-schema.sql` to add push tables to an existing database without losing data.
- **Worker** (`homejob-reminders`): needs its own `DB` binding to the same D1 database, cron `* * * * *`, and secret `VAPID_PRIVATE_KEY` (never commit this value). `VAPID_PUBLIC_KEY` must match between `workers/wrangler.toml` and the `VAPID_PUBLIC_KEY` constant hardcoded in `app.js`.
- See [README-DEPLOY.md](README-DEPLOY.md) and [workers/README-PUSH.md](workers/README-PUSH.md) for full step-by-step Cloudflare dashboard instructions.

## Conventions and preferences

- All user-facing strings are in Polish. Keep new UI text in Polish, matching the existing tone (warm/informal, non-technical).
- The user driving this project is a technical layperson working mostly from an iPhone. Prefer small, targeted diffs; when producing a patch/zip for them, list exactly which files changed and don't include the whole project if only a few files changed.
- Be conservative with CSS/layout changes: past regressions came from resizing form fields beyond what was asked. Touch only the specific element requested, especially around the `Termin` (due date) and `Przypomnienie` (reminder time) form fields, which have needed repeated pixel-level fixes for iOS (input zoom, vertical centering).
- Deferrals are business logic, not UI sugar: "Nie ma potrzeby" and postponing a due date both go through `state.taskRequests` — a written reason, a household vote (majority of `state.users`, requester auto-votes yes), and for postpones a per-user cap of `MONTHLY_POSTPONE_LIMIT` approved requests per calendar month. Pending requests silence that task's reminders (client sweep and worker alike) and expire after `REQUEST_EXPIRY_DAYS`. The task edit form may only move a due date **earlier**; moving it later must stay behind the request flow, otherwise the whole limit is bypassable.
- Recurring occurrences are always created strictly in the future (`getCaughtUpDueDate` loops while `next <= today`). Do not relax this to `<`: closing an overdue recurring task then re-created it for today, which fired reminders the same evening for a task that had just been closed.
- Points/rewards rules are business logic, not arbitrary constants — see `PRIORITY`, `SHOPPING_ITEM_POINTS`, `SHOPPING_DELIVERY_POINTS`, and `REWARD_THRESHOLDS` in `app.js` before changing scoring behavior.
