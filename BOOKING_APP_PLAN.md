# Postre Live Booking App — Comprehensive Implementation Plan

**Version 2 — STANDALONE.** Supersedes the v1 plan, which assumed the booking app would be built
*inside* the `MEssenger-bot` repo and server. That is **no longer the design**.

**Project home (new repo):** `C:\Users\Mizeri Jiwu\Desktop\sofiapostrebooking`
**Messenger-bot:** `C:\Users\Mizeri Jiwu\Desktop\MEssenger-bot` — **read-only reference. Never modified.**
**Status:** Plan only — no code written yet

---

## 0. The boundary (read this first)

> **The Messenger-bot codebase is never modified.** Not a line. No edits to `src/`, `public/`,
> `package.json`, `Dockerfile`, `tsconfig.json`, `scripts/`, or the Supabase migrations it owns.

The booking app is a **separate repository, a separate server, a separate deploy** that points at the
**same Supabase project** using the same `SUPABASE_URL` / `SUPABASE_SERVICE_KEY` / `DATABASE_URL`.

### 0.1 What is shared, and what is not

| | Shared with Messenger-bot | Private to the booking app |
|---|---|---|
| **Supabase project** | ✅ same `DATABASE_URL`, `SUPABASE_URL`, `SUPABASE_SERVICE_KEY` | — |
| **Tables** | ❌ Messenger-bot's 28 tables are **never read and never written** | ✅ every booking table is `bk_*` |
| **Users** | ❌ **its own `bk_users` table** (see §0.2) | ✅ manager + riders |
| **JWT** | ❌ **its own `BK_JWT_SECRET`** (see §0.3) | ✅ its own signing key |
| **VAPID push keys** | ❌ **its own** `BK_VAPID_*` pair | ✅ its own push subscription table |
| **Code** | ❌ nothing | ✅ the entire repo |
| **Server / deploy** | ❌ its own Render service, own URL, own Dockerfile | ✅ |
| **Env vars** | only `SUPABASE_*` / `DATABASE_URL` | ✅ everything else is new |

### 0.2 Why the booking app gets its OWN `bk_users` table — not the shared `admins`

This is the single most important consequence of the boundary, and it is **not** a stylistic choice.

`MEssenger-bot` has an **Admins** tab (`public/admin/app.js:808`) backed by:

```ts
// src/api/admin.ts:1523
r.get('/admins', requireAdmin, async (_req, res) => {
  const { data } = await supa().from('admins').select('id, username, role, created_at').order('id');
  res.json(data || []);
});
```

If riders were stored as rows in the shared `admins` table, then:

1. **every rider would appear in the Messenger-bot admin panel's Admins list** — that is, in plain
   terms, the Messenger-bot UI would be changed by our data;
2. Messenger-bot's `DELETE /admins/:id` (`admin.ts:1573`, guarded only by `requireAdmin`) could
   **delete a booking-app rider's account**, silently breaking their login;
3. its `PUT /admins/:id` password-change route could **overwrite a rider's password**;
4. a `role: 'RIDER'` row is a role value Messenger-bot has no concept of.

So the booking app creates **`bk_users`**, with its own bcrypt hashing and its own JWT. Sharing the
`admins` table would have "touched" Messenger-bot in the most damaging way possible while looking like
convenience.

### 0.3 Why a separate `BK_JWT_SECRET`

Tokens are only dangerous when two systems accept each other's. If the booking app signed with the same
`JWT_SECRET` and the same claims, then **any Messenger-bot admin token would be a valid booking-app
manager token** — and vice versa. One leaked token from either app escalates in the other. A separate
secret makes that impossible. "Same credentials" is honoured where it was asked for — the database —
and deliberately not extended to session tokens.

### 0.4 Hard rules for every developer on this project

1. **Never write to, or `ALTER`, a table that does not start with `bk_`.** Messenger-bot's 28 tables
   are read-only *and write-closed* — we do not read them either.
2. **Never add, remove or change a row in `app_settings`.** That is Messenger-bot's settings store
   (it holds `branches`, `webview_enabled`, `admin_remember:*`). The booking app uses **`bk_settings`**.
3. **Every migration is strictly additive** and uses `IF NOT EXISTS`. A `DROP`, `TRUNCATE`, or `RENAME`
   is forbidden — a typo would destroy live Messenger-bot data.
4. **Never `ENABLE ROW LEVEL SECURITY` on an existing table.** RLS is only ever enabled on new `bk_*`
   tables.
5. **No import from, or file path pointing into, the Messenger-bot repo.** Shared logic is **ported**
   (see §2.2), never linked.
6. **Never call the Messenger-bot's HTTP API** at runtime. There is no cross-app request.

### 0.5 What this costs, stated honestly

Duplication is the price of the boundary, and it is deliberate. Roughly 200 lines of small pure
functions — date parsing, Waze URL building, the peso formatter, an SSE hub, a money splitter — are
re-implemented rather than imported. That is a *good* trade: it means the Messenger-bot cannot be
broken by a booking-app deploy, and the booking app can be rewritten or replaced without touching a
live ordering system. §2.2 lists exactly what is ported so nothing is ported by accident.

---

## 1. Executive Summary

A **live, Android-installable booking & rider-dispatch app** for **Postre Food Products**. It is a
**completely separate application** — its own repository, server and deploy — sharing only the
Supabase database with the Messenger ordering system, and **never modifying it** (§0).

| Role | What they do |
|---|---|
| **Booking Manager** | Registers riders, pastes booking details copied from Messenger → the booking appears on the dashboard, sees which riders are online (green dot), approves/rejects rider requests, assigns or transfers/swaps bookings, tracks delivery, **earns 15% commission on every booking**, manages settings + own profile, and runs the team chat |
| **Rider** | Logs in separately, sees unassigned/bookable bookings, **requests** to take one, accepts, picks up, delivers, sees their **own earnings**, and uses the team chat |

### Key architectural decisions

1. **Standalone project.** New repo, new server, new deploy, own `bk_users`, own `BK_JWT_SECRET`, own
   VAPID keys. **The Messenger-bot is never modified.** Shared: the Supabase project only. (§0)
2. **Every table is `bk_*`.** Messenger-bot's 28 tables are never read, never written. Migrations are
   strictly additive — a stray `DROP` would destroy live ordering data. (§0.4)
2b. **One branch, one dispatch day at a time.** No branch field, no date parsing, no per-booking date.
   The board is today; a day closes at a store-local cutoff and freezes its takings. (§6.1.1)
3. **PWA first, then Capacitor → signed APK** served from our own domain and downloadable in the
   browser. (§8)
4. **Live updates via SSE**, with **Web Push** as the backgrounded-app fallback.
5. **Green dot presence** = server-authoritative heartbeat (fresh within 60s) + a server sweep, so a
   crashed app never shows a stale "online".
6. **Clear live state on every booking**: 🟡 Open · 🔵 Claimed · 🟠 **Ongoing (a rider has taken it)** ·
   ⚪ Closed. `is_ongoing` is **derived from the status, never stored**, so it can never drift. (§6.4.1)
7. **Only two numbers feed the money: the booking `total` and the delivery fee (`Df`).** The commission
   base is the **food value** (`total − Df`); the 15% / 85% split is **snapshotted at creation**, so
   changing the rate later never rewrites past earnings. (§6.6.1)
8. **Commission accrues on delivery**, and earned / paid / owed are three separate numbers so the
   manager always knows what they still owe each rider. (§6.6.3)
9. **Full history for both roles** from one audit ledger. Bookings are **archived, never
   hard-deleted**, so the money trail survives. (§6.10)
10. **Day boundaries use the store's timezone** (`Asia/Manila`), never UTC, so an 11:30 PM booking
    lands in the right day. (§6.10.7)
11. **Mobile-first is the primary constraint, not a retrofit** — one-handed, outdoors, on mobile data,
    at 360 × 640. (§10.6)
12. **A live community chat** connects the manager and all online riders. Booking cards are claimable
    from the card, but **plain chatter is never pushed** — only cards and `@mention`s, because
    notification fatigue would silently break dispatch. (§6.11)

---

## 2. Goals, Scope, Non-Goals

### 2.1 Goals

- Manager can **register/deactivate riders**, each with their own login.
- **One branch, one dispatch day at a time** - the board is today's; a day closes at a store-local
  cutoff and freezes its totals; past days stay readable with their frozen figures. (S6.1.1)
- **One branch, one dispatch day at a time** — the board is today's, the day closes at a store-local
  cutoff and freezes its totals, and past days stay readable with their frozen figures. (§6.1.1)
- Manager can **paste booking text copied from Messenger**; the app **parses it** and the booking appears
  **immediately** on the dashboard.
- Riders **request** to take an unassigned booking; the request is **pending until the manager approves**.
- Manager can **assign** to any **online** rider when nobody is requesting, and **transfer / swap** an
  assigned booking with a required reason and a full audit trail.
- **Separate login screens** for manager and rider, with role-locked navigation **and** API guards.
- **Live** app: bookings, requests, presence and chat push to every connected device in real time.
- **Green dot online indicator** per rider, visible to the manager.
- **Per-booking money**: `Total` and `Df` from the paste; a 15% manager commission on the food value,
  the rider's 85%, earned-vs-paid-vs-owed, and per-rider earnings on their profile.
- **Full history** for both roles.
- **Live community chat** between the manager and all online riders.
- **Android APK** downloadable from a browser.

### 2.2 Non-Goals

- **Any change to the Messenger-bot** — not its code, not its data, not its tables. (§0)
- Reading orders out of the Messenger-bot database. Bookings arrive **only** by paste or manual entry;
  the human is the integration boundary, and that is what makes this a separate system.
- Slot capacity / business hours / closed dates, and **no date or time parsing at all**. The booking app
  is a **dispatch** tool, not a reservation diary: the date and time live inside `details_text`
  exactly as pasted, and all day grouping uses the dispatch day (§6.1.1).
- **Multiple branches and multiple days.** The app serves **one branch, one dispatch day at a time** (§6.1.1).
- Payments, GCash settlement, invoicing, rider payouts or earnings payouts to riders' bank.
- Offline-first read cache (online-first; see risk R6).

### 2.3 Reference material from Messenger-bot (read-only)

Everything below was read from `C:\Users\Mizeri Jiwu\Desktop\MEssenger-bot` to design this app. It is
**reference only — nothing is imported, and nothing there is modified.**

**What we learn from it (and re-implement ourselves):**

| From Messenger-bot | What we take | Where it goes in this repo |
|---|---|---|
| `services/branches.ts` → `buildWazeAppUrl` / `buildWazeUrl` / `buildGoogleMapsUrl` | 3 one-line URL builders | `src/lib/nav.ts` |
| `messenger/webhook.ts` → `parseDateInput` / `parseTimeInput` | the accepted date + time formats | `src/lib/datetime.ts` |
| `services/orders.ts` → `stripNavLines` regexes | the legacy Waze-line stripping | `src/lib/nav.ts` |
| `services/admin-events.ts` | the SSE hub pattern (20s heartbeat, client set) | `src/services/events.ts` |
| `public/admin/app.js` → `openWaze()` (line 2062) | the proven Waze-app-then-https-fallback algorithm | `public/app.js` |
| `public/admin/app.js` → `esc()` | the HTML-escaping helper | `public/app.js` |
| `server.ts` rate-limiter pattern | `express-rate-limit` setup | `src/server.ts` |
| `admin/app.js:613` → `generateBookingDetails()` | **the exact text the manager will paste** | parser fixtures (§3.2) |
| `public/webview/style.css` | the proven mobile CSS conventions | `public/style.css` |

**What we deliberately do NOT take:** the `admins` table, `app_settings`, `reservations`, the VAPID
keys, `JWT_SECRET`, and every Messenger route.

---

## 3. Reference: the Messenger-bot, and the text we must parse

`C:\Users\Mizeri Jiwu\Desktop\MEssenger-bot` is our **read-only reference**. We do not link to it and
do not modify it. This section records the two things we genuinely need from it: the **stack
conventions we choose to follow** (because they are proven), and the **exact paste text**.

### 3.1 Stack we adopt (chosen to match a known-working codebase)

| Concern | Choice | Note |
|---|---|---|
| Runtime | Node.js 22, `node:22-bookworm-slim` | same as Messenger-bot's Dockerfile — a proven base |
| Server | Express 4 + TypeScript (CommonJS → `dist/`) | same |
| Build | `tsc && cpSync('public' → 'dist/public')` | our own `public/`, our own build script |
| DB | Supabase Postgres. Query-builder client for reads/writes, `pg` Pool for aggregations | same two-client pattern, **our own modules** |
| Migrations | idempotent, additive DDL run at boot **and** shipped as a paste-into-Supabase `.sql` | §5.4 |
| Auth | `bcryptjs` + `jsonwebtoken`, 12h access + rotating refresh | **our own `bk_users`**, **our own `BK_JWT_SECRET`** |
| Live | SSE hub, 20s heartbeat | our own `src/services/events.ts` |
| Push | Web Push + our own VAPID pair | `BK_VAPID_*` |
| Frontend | **Vanilla JS, no framework, no bundler** | one `public/`, no build step for the frontend |
| Deploy | Render (Docker), own service, own domain | e.g. `postre-booking.onrender.com` |

> Everything in this table is a *convention we copy*, not code we import. Our repo is self-contained.

### 3.2 The text the manager will paste

The manager copies from the Messenger-bot admin panel's **📋 Booking Details** button
(`public/admin/app.js:613`, `generateBookingDetails()`). That is the real, primary input format:

```
pick up:
POSTRE
Zone 5 San Francisco Magarao sa may padahkan pa right side daretso lang…

Drop off;
📍Date&Time: 30 Sep 2026 (2:30 PM)
Name: Maria Santos
Contact#: 09171234567
Order:
Honey Chicken
- Java Rice
Df ₱50
Total:₱1,000

Delivery to;
123 Example St, Naga City
📍 Navigate (tap to open Waze app): https://waze.com/ul?ll=13.5234,123.4567&navigate=yes
;;;WAZE=%7B%22app%22%3A%22waze%3A%2F%2F%3Fll%3D13.5234%2C123.4567%26navigate%3Dyes%22%2C%22https%22%3A…
```

**Two facts this gives us:**

1. **`Df` and `Total:` are separate lines** — these are the **only two money inputs** (§6.6.1).
2. **The `;;;WAZE=<url-encoded JSON>` trailer is machine-readable** — `{ app, https }`, a far more
   reliable coordinate source than scraping the visible link. §6.5.1.

A **secondary** format is the Messenger confirmation bubble, in case the manager copies from the chat
instead of the admin panel:

```
🧾 Your order…
Order #: PP-1001
💰 Total: ₱1,234
📦 Delivery
📍 123 Example St, Naga City
📅 2026-09-25 at 2:30 PM
💳 GCASH
📝 Items:
• Honey Chicken x2 - ₱900
━━━━━━━━━━━━━━━━━━━
```

And a **third**, when the manager copies a Messenger *reservation form* (styled Unicode labels —
`𝑵𝒂𝒎𝒆`, `𝑪𝒐𝒏𝒕𝒂𝒄𝒕#`, `𝑶𝒓𝒅𝒆𝒓`):

```
𝙍𝙀𝙎𝙀𝙍𝙑𝘼𝙄𝙊𝙉 𝙁𝙊𝙍𝙈
📍Date&Time: 2026-09-25 2:30 PM
𝑵𝒂𝒎𝒆: Maria Santos
𝑪𝒐𝒏𝒕𝒂𝒄𝒕#: 09171234567
𝑶𝒓𝒅𝒆𝒓: Delivery
𝑳𝒐𝒄𝒂𝒕𝒊𝒐𝒏,𝒍𝒂𝒏𝒅𝒎𝒂𝒓𝒌: 123 Example St, Naga City}
```

> The trailing `}` in that last block is a **live bug in the Messenger-bot** (`src/messenger/send.ts:690`
> — a stray `$` in a template literal). We must **not fix it** (§0). Our parser simply strips a
> trailing `}` so the text still parses correctly. It is noted here only so nobody later mistakes our
> strip for a workaround of our own bug.

---

## 4. End-to-End User Journeys

### 4.1 Manager: paste a Messenger booking → live on the dashboard

```
Manager opens the app (APK or the booking site) → "Manager" login → Dashboard
  → taps [ + New Booking ] → Paste screen (big textarea, "Paste" button)
  → pastes the Booking Details text copied from the Messenger admin panel → taps [ Parse ]
  → POST /api/manager/bookings/parse  → the 3-row preview: Total, Df, pin found
  → taps [ Create Booking ]
  → POST /api/bookings
  → bk_bookings row (status PENDING) + bk_booking_events row (CREATED)
  → emit('bookings')  ─────────────►  every connected Manager device updates instantly
                                  ►  every ONLINE rider gets a Web Push:
                                    "🆕 New job BK-1042"
                                  ►  the team chat gets a 📋 BK-1042 card
  → booking card appears at the top of the Manager's Home/Dashboard
```

### 4.2 Rider: request to take a booking → manager approval

```
Rider opens the app → "Rider" login (own credentials) → Home
  → "Open" tab shows PENDING bookings only (a job another rider has taken is never listed)
  → taps [ Request ] (+ optional note "near me, can deliver by 3")
  → POST /api/rider/jobs/:id/request  → bk_booking_requests row (PENDING)
  → emit('requests')  ─────────────►  Manager device: badge "1 new request" + chime
                                  ►  Manager Web Push: "🔔 Jose requests BK-1042"
  → Manager taps the request → [ Approve ]  (or [ Reject ])
  → POST /api/manager/requests/:id/approve
  → status = ASSIGNED, assigned_rider_id set, competing requests auto-rejected
  → emit('bookings')  ────────────►  Approving rider: "✅ You got BK-1042 — Accept / Decline"
                                  ►  Losing riders: "BK-1042 was taken"
                                  ►  Manager Web Push: "BK-1042 → Jose"
```

### 4.3 Manager: assign directly to an online rider (nobody requesting)

```
Dashboard → booking card → [ Assign ]
  → rider picker sheet lists every rider WITH a green/grey dot
  → manager taps "Marlon 🟢" → POST /api/manager/bookings/:id/assign
  → status ASSIGNED, event ASSIGNED recorded
  → rider device: push + live "New assignment — Accept / Decline"
```

### 4.4 Manager: transfer / swap an already-assigned booking

```
Booking card (status ASSIGNED or ACCEPTED) → [ Transfer ]
  → sheet: current rider shown, target rider selected (green dot list), reason (required)
  → POST /api/manager/bookings/:id/transfer { to_rider_id, reason }
  → previous rider auto-released, new rider ASSIGNED, history keeps BOTH assignments
  → both riders notified, manager Web Push confirms
```

### 4.5 Live presence (green dot)

```
Rider app opens / resumes / becomes visible
  → POST /api/heartbeat { instance_id }  (every 20s while open, and on every SSE reconnect)
  → server upserts bk_rider_presence(rider_id, instance_id, last_seen_at = now)
  → server recomputes the online set; if it CHANGED → emit('presence', { online: [...] })
  → every Manager device repaints the dots without a reload

Rider closes the app / loses network
  → best effort POST /api/heartbeat/offline (or navigator.sendBeacon on pagehide)
  → server sweep every 30s marks anyone with no fresh presence row OFFLINE
  → Manager's dot flips to grey within ≤90s
```

### 4.6 Delivery lifecycle (rider-driven)

```
PENDING --manager assigns--> ASSIGNED --rider accepts--> ACCEPTED
                                                 --rider picks up--> PICKED_UP
                                                 --rider delivers--> DELIVERED
ASSIGNED --rider declines--> PENDING (reopens for requests)
Any non-terminal state --manager cancels--> CANCELLED
```

### 4.7 Team chat (manager + all online riders)

```
Manager taps 💬 in the nav → types → [Send]  ──► SSE ──► every rider's screen updates instantly
Manager taps [ Post job ] on a booking → 📋 BK-1042 card appears for every rider
Rider taps [ Take it ] on the card → a request is created, the manager sees it in-chat
Rider @mentions @Maria → only Maria is pushed if her app is backgrounded
```

---

## 5. Architecture

**Decision: a standalone repository, a standalone server, and its own `bk_*` tables in the shared
Supabase project. The Messenger-bot is never touched (§0).**

```
C:\Users\Mizeri Jiwu\Desktop\sofiapostrebooking          ← the NEW repo (this project)
├── src/
│   ├── server.ts                        server bootstrap, rate limiters, static, /api mount
│   ├── db/
│   │   ├── supabase.ts                  query-builder client (service key)
│   │   ├── pg.ts                        pg Pool for aggregations
│   │   └── migrate.ts                   additive, idempotent bk_* DDL (runs at boot)
│   ├── lib/                             pure, dependency-free helpers (ported, not imported)
│   │   ├── datetime.ts                  parseDateInput / parseTimeInput / store-timezone helpers
│   │   ├── nav.ts                       buildWazeAppUrl / buildWazeUrl / buildGoogleMapsUrl / stripNavLines
│   │   └── money.ts                     peso formatting + the ONLY computeSplit()
│   ├── services/
│   │   ├── auth.ts                      bk_users, bcrypt, JWT, refresh rotation, role guards
│   │   ├── bookings.ts                  state machine + live_group + queries
│   │   ├── money.ts                     applySplit / accrueOnDelivery / riderEarnings / recordPayout
│   │   ├── parse.ts                     the paste parser (pure)
│   │   ├── events.ts                    audience-aware SSE hub
│   │   ├── presence.ts                  heartbeat + online/offline sweep
│   │   ├── history.ts                   audit ledger, CSV, archive
│   │   ├── chat.ts                      messages, kinds, mentions, system events
│   │   ├── push.ts                      Web Push with our own VAPID pair
│   │   └── settings.ts                  bk_settings key/value + 60s cache
│   ├── routes/                          Express routers (§9)
│   │   ├── auth.ts  bookings.ts  riders.ts  money.ts  history.ts  chat.ts  config.ts
│   └── ...
├── migrations/
│   └── 001_bk_init.sql                  ← paste into the Supabase SQL Editor once
├── public/                              the SPA (manager + rider) + PWA + APK
│   ├── index.html  app.js  style.css  sw.js  manifest.json  install.html
│   ├── icons/   apk/postre-booking.apk   android/   (Capacitor project)
├── scripts/verify-*.ts                  e2e tests (tsx, live DB, self-cleaning)
├── Dockerfile                           OUR OWN — node:22, multi-stage, non-root
├── package.json  tsconfig.json  .env.example  README.md
└── render.yaml                          OUR OWN Render service definition
```

### 5.1 Why standalone, even though we share the database

| Reason | Detail |
|---|---|
| **The Messenger-bot cannot break** | It has zero imports from us and zero shared code. A booking-app deploy cannot alter its behaviour, and a Messenger-bot deploy cannot alter ours. The only shared thing is a database. |
| **No cross-app UI contamination** | Because riders live in `bk_users` and not `admins` (§0.2), nothing we write ever appears in the Messenger-bot admin panel. |
| **No token confusion** | Separate `BK_JWT_SECRET` (§0.3) means a token from one app is worthless in the other. |
| **Independent release & rollback** | Two repos, two deploys. A bad booking release is reverted in seconds without touching a live ordering system. |
| **The data boundary is explicit** | `bk_*` tables make it obvious at a glance which data is ours. A stray write is a naming violation, visible in review. |

### 5.2 Shared-database discipline

- **All DDL is additive and idempotent** (`CREATE TABLE IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`).
  No `DROP`, no `TRUNCATE`, no `RENAME`, no `ALTER` on a pre-existing table.
- **Every object we create is prefixed `bk_`** — tables, indexes, and the `bk_` enum-ish check values.
- **A boot-time guard asserts the boundary.** On start, `src/db/migrate.ts` runs a read-only check that
  every table we expect to own exists, and logs a loud warning naming any **missing** `bk_*` table. It
  never inspects, counts, or touches a non-`bk_` table.
- **Connection budget.** Two services share one Supabase pooler. Our `pg` Pool is capped at **5** (not
  the 10 Messenger-bot uses) so the two together stay well inside the pooler limit. Most work goes
  through the query-builder client, which does not hold a dedicated connection per request.
- **RLS is enabled on `bk_*` tables only.** Our service-role key bypasses it; it is enabled as defence
  in depth so a future anon key mistake cannot read them.
- **`bk_settings` replaces `app_settings`.** Messenger-bot owns `app_settings`; we never read or write
  a row in it, so our keys can never collide with theirs.

### 5.3 The one place humans are the integration layer

The manager copies text from the Messenger admin panel and pastes it here. **That is the entire
integration.** It means:

- no API call into the Messenger-bot, ever;
- no shared table, so the two systems can be taken down independently;
- a booking is a **dispatch record**, not a mirror of an order — its own reference `BK-####`, its own
  lifecycle, its own money.

This is why the app can be genuinely standalone, and it is also why the parser (§6.5) is treated as a
first-class, heavily tested component rather than an afterthought.

### 5.4 Migrations

Two delivery paths, both required, because they fail differently:

| Path | When | Why |
|---|---|---|
| `migrations/001_bk_init.sql` pasted into the Supabase SQL Editor | **Before first deploy** | Creates the tables in the real project. Reviewable as a single artefact, and reversible by hand. |
| `src/db/migrate.ts` at boot | Every deploy | Idempotent, so a fresh database self-heals. A failure is **non-fatal** — the app still boots and serves, logging a loud error rather than crash-looping. |

Every statement is `IF NOT EXISTS`, so running both, in either order, more than once, is safe.

---

## 6. Design

### 6.1 Data model (`bk_*`)

Two delivery paths (§5.4): `migrations/001_bk_init.sql` for the Supabase SQL Editor, mirrored by
`src/db/migrate.ts` at boot. Every statement is `IF NOT EXISTS`. **Every object is `bk_*`** — nothing
here touches a Messenger-bot table.

```sql
-- ══ bk_001: our own identity + settings ═══════════════════════════════════════
-- We do NOT use Messenger-bot's `admins` or `app_settings` (§0.2, §0.4).

CREATE TABLE IF NOT EXISTS bk_users (
  id             INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  username       TEXT UNIQUE NOT NULL,
  password_hash  TEXT NOT NULL,                 -- bcryptjs, cost 10
  role           TEXT NOT NULL DEFAULT 'RIDER', -- MANAGER | RIDER
  full_name      TEXT NOT NULL,
  phone          TEXT,
  is_active      INTEGER NOT NULL DEFAULT 1,
  password_reset_required INTEGER NOT NULL DEFAULT 0,  -- forced change on first login
  last_login_at  TIMESTAMPTZ,
  created_by     INTEGER REFERENCES bk_users(id),
  created_at     TEXT NOT NULL DEFAULT (now()::text),
  updated_at     TEXT NOT NULL DEFAULT (now()::text)
);
CREATE INDEX IF NOT EXISTS idx_bk_users_role ON bk_users(role, is_active);

-- Settings key/value. Deliberately NOT `app_settings` — that is Messenger-bot's.
CREATE TABLE IF NOT EXISTS bk_settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT DEFAULT (now()::text)
);
```

```sql
-- ══ bk_002: riders ════════════════════════════════════════════════════════════
-- Rider profile. Credentials live in bk_users; this is dispatch-specific data only.
CREATE TABLE IF NOT EXISTS bk_riders (
  id         INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES bk_users(id) ON DELETE CASCADE,
  full_name  TEXT NOT NULL,
  phone      TEXT,
  vehicle    TEXT,                    -- 'motorcycle' | 'bike' | 'foot' | NULL
  plate      TEXT,
  is_active  INTEGER NOT NULL DEFAULT 1,
  notes      TEXT,
  created_by INTEGER REFERENCES bk_users(id),
  created_at TEXT DEFAULT (now()::text),
  updated_at TEXT DEFAULT (now()::text),
  UNIQUE(user_id)                     -- one rider profile per login
);

-- ══ bk_003: ONE branch, ONE dispatch day at a time (§6.1.1) ═════════════════════
-- The app serves a single branch and a single operating day. `date_ref` is the
-- business date the manager sees on screen; `opened_at` is when the day actually
-- started in real time. A day normally rolls over automatically at
-- `day_cutoff_hour` (store-local), but the manager can also close it by hand.
CREATE TABLE IF NOT EXISTS bk_dispatch_days (
  id             INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  date_ref       TEXT UNIQUE NOT NULL,       -- 'YYYY-MM-DD' as the manager sees it
  status         TEXT NOT NULL DEFAULT 'OPEN',  -- OPEN | CLOSED
  opened_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  closed_at      TIMESTAMPTZ,
  closed_by      INTEGER REFERENCES bk_users(id),
  -- Frozen at close so a day's takings can never silently change afterwards.
  totals_snapshot TEXT,                     -- JSON: booking count, food value, commission, rider payouts
  note           TEXT
);
CREATE INDEX IF NOT EXISTS idx_bk_days_status ON bk_dispatch_days(status, date_ref DESC);

CREATE TABLE IF NOT EXISTS bk_bookings (
  id                INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  ref               TEXT UNIQUE NOT NULL,           -- BK-1001
  day_id            INTEGER NOT NULL REFERENCES bk_dispatch_days(id),  -- the one board it lives on
  status            TEXT NOT NULL DEFAULT 'PENDING',
                    -- PENDING | ASSIGNED | ACCEPTED | PICKED_UP | DELIVERED | CANCELLED
                    -- `live_group` / `is_ongoing` are DERIVED at read time, never stored (§6.4.1)
  priority          TEXT NOT NULL DEFAULT 'NORMAL', -- NORMAL | HIGH
  source            TEXT NOT NULL DEFAULT 'PASTE',  -- PASTE | MANUAL

  -- ── THE ONLY TWO NUMBERS WE PARSE (§6.5) ───────────────────────────────────
  total             INTEGER NOT NULL DEFAULT 0,    -- "Total:" — what the customer pays
  delivery_fee      INTEGER NOT NULL DEFAULT 0,    -- "Df" — 0 when there is no Df line
  -- Everything else in the paste is NEVER parsed. The verbatim text is kept below
  -- and shown to the rider as-is; the manager may add a name by hand.

  -- Drop-off pin, from the Waze link in the paste (§6.5.3). Powers the
  -- 🗺️ Navigate button. The URL itself is NEVER stored — only the two numbers.
  delivery_lat      DOUBLE PRECISION,
  delivery_lng      DOUBLE PRECISION,
  pin_source        TEXT,                           -- 'PASTE_LINK' | 'MAP_PICK' | NULL

  -- Optional, typed by the manager. Never auto-filled from the paste.
  customer_name     TEXT,
  customer_phone    TEXT,
  notes             TEXT,

  -- The pasted text, kept VERBATIM. This is what the rider reads, so nothing
  -- can be lost to a parser that chose not to understand it.
  details_text      TEXT,

  payment_status    TEXT NOT NULL DEFAULT 'UNPAID',
  assigned_rider_id INTEGER REFERENCES bk_riders(id) ON DELETE SET NULL,
  assigned_at       TIMESTAMPTZ,
  accepted_at       TIMESTAMPTZ,
  picked_up_at      TIMESTAMPTZ,
  delivered_at      TIMESTAMPTZ,
  cancelled_at      TIMESTAMPTZ,
  cancel_reason     TEXT,
  created_by        INTEGER REFERENCES bk_users(id),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_bk_bookings_status   ON bk_bookings(status);
CREATE INDEX IF NOT EXISTS idx_bk_bookings_day     ON bk_bookings(day_id, status);
CREATE INDEX IF NOT EXISTS idx_bk_bookings_dayref  ON bk_bookings(day_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_bk_bookings_rider   ON bk_bookings(assigned_rider_id);
CREATE INDEX IF NOT EXISTS idx_bk_bookings_pin     ON bk_bookings(delivery_lat, delivery_lng)
  WHERE delivery_lat IS NOT NULL;          -- partial: not every job has a pin
```


```sql
-- Rider claim on an unassigned booking. MANY riders may request the SAME booking.
CREATE TABLE IF NOT EXISTS bk_booking_requests (
  id          INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  booking_id  INTEGER NOT NULL REFERENCES bk_bookings(id) ON DELETE CASCADE,
  rider_id    INTEGER NOT NULL REFERENCES bk_riders(id) ON DELETE CASCADE,
  status      TEXT NOT NULL DEFAULT 'PENDING',   -- PENDING|APPROVED|REJECTED|WITHDRAWN
  note        TEXT,
  created_at  TEXT DEFAULT (now()::text),
  resolved_at TEXT,
  resolved_by INTEGER REFERENCES bk_users(id),
  UNIQUE(booking_id, rider_id)                   -- one live claim per rider per booking
);
CREATE INDEX IF NOT EXISTS idx_bk_breq_booking_status ON bk_booking_requests(booking_id, status);
CREATE INDEX IF NOT EXISTS idx_bk_breq_rider         ON bk_booking_requests(rider_id, status);

-- Immutable audit timeline ("who did what, when").
CREATE TABLE IF NOT EXISTS bk_booking_events (
  id         INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  booking_id INTEGER NOT NULL REFERENCES bk_bookings(id) ON DELETE CASCADE,
  type       TEXT NOT NULL,   -- CREATED|ASSIGNED|TRANSFERRED|REQUESTED|APPROVED|REJECTED
                               -- |WITHDRAWN|ACCEPTED|DECLINED|PICKED_UP|DELIVERED
                               -- |CANCELLED|EDITED|NOTE
  message    TEXT,
  actor_type TEXT,             -- MANAGER | RIDER | SYSTEM
  actor_id   INTEGER,
  actor_name TEXT,
  meta       TEXT,             -- JSON
  created_at TEXT DEFAULT (now()::text)
);
CREATE INDEX IF NOT EXISTS idx_bk_bevents_booking ON bk_booking_events(booking_id, id);
```

```sql
-- ── LIVE PRESENCE: one row per rider PER DEVICE INSTALL ──────────────────────
-- WHY a table and not a `last_seen` column on `riders`: a rider may have the app
-- open on a phone AND a tablet. Presence must be "ANY instance fresh", not
-- "last writer wins" — otherwise closing one device yanks the green dot off a
-- rider who is still actively working on the other.
CREATE TABLE IF NOT EXISTS bk_rider_presence (
  rider_id     INTEGER NOT NULL REFERENCES bk_riders(id) ON DELETE CASCADE,
  instance_id  TEXT NOT NULL,     -- uuid generated by the app, stored on device
  platform     TEXT,              -- 'android' | 'web'
  app_version  TEXT,
  last_seen_at TEXT NOT NULL,
  PRIMARY KEY (rider_id, instance_id)
);

-- Push subscriptions, scoped so a rider never receives manager-only alerts.
CREATE TABLE IF NOT EXISTS bk_booking_devices (
  id           INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  rider_id     INTEGER REFERENCES bk_riders(id) ON DELETE CASCADE,
  user_id      INTEGER REFERENCES bk_users(id) ON DELETE CASCADE,
  audience     TEXT NOT NULL DEFAULT 'MANAGER',   -- MANAGER | RIDER
  endpoint     TEXT UNIQUE NOT NULL,
  p256dh       TEXT NOT NULL,
  auth         TEXT NOT NULL,
  user_agent   TEXT,
  created_at   TEXT DEFAULT (now()::text),
  last_used_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_bk_bdev_audience ON bk_booking_devices(audience);

-- Refresh tokens so a 12h JWT does not force a daily re-login on a phone.
CREATE TABLE IF NOT EXISTS bk_booking_sessions (
  id            INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  rider_id      INTEGER REFERENCES bk_riders(id) ON DELETE CASCADE,
  user_id       INTEGER REFERENCES bk_users(id) ON DELETE CASCADE,
  refresh_token TEXT UNIQUE NOT NULL,
  expires_at    TEXT NOT NULL,
  created_at    TEXT DEFAULT (now()::text)
);

-- APK version published to the in-app "Download update" button.
CREATE TABLE IF NOT EXISTS bk_app_releases (
  id         INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  version    TEXT NOT NULL,
  build_no   INTEGER NOT NULL DEFAULT 1,
  apk_url    TEXT NOT NULL,
  notes      TEXT,
  is_current INTEGER NOT NULL DEFAULT 0,
  created_at TEXT DEFAULT (now()::text)
);

-- Archive, never hard-delete: the audit trail and the money ledger must survive
-- a "deleted" booking. See §6.10.1 Problem 2.
ALTER TABLE bk_bookings ADD COLUMN IF NOT EXISTS archived_at   TEXT;
ALTER TABLE bk_bookings ADD COLUMN IF NOT EXISTS archived_by   INTEGER REFERENCES bk_users(id);
ALTER TABLE bk_bookings ADD COLUMN IF NOT EXISTS archive_reason TEXT;

-- ── AUDIT: booking_events becomes the full cross-entity ledger ───────────────
-- See §6.10.2. booking_id is nullable so rider / payout / setting events live in
-- the same table; visible_to_rider hides internal-only rows.
ALTER TABLE bk_booking_events ADD COLUMN IF NOT EXISTS entity          TEXT;
ALTER TABLE bk_booking_events ADD COLUMN IF NOT EXISTS from_status     TEXT;
ALTER TABLE bk_booking_events ADD COLUMN IF NOT EXISTS to_status       TEXT;
ALTER TABLE bk_booking_events ADD COLUMN IF NOT EXISTS amount_delta    INTEGER;
ALTER TABLE bk_booking_events ADD COLUMN IF NOT EXISTS visible_to_rider INTEGER NOT NULL DEFAULT 1;
ALTER TABLE bk_booking_events ALTER COLUMN booking_id DROP NOT NULL;
CREATE INDEX IF NOT EXISTS idx_bk_bevents_type  ON bk_booking_events(type, created_at);
CREATE INDEX IF NOT EXISTS idx_bk_bevents_actor ON bk_booking_events(actor_type, actor_id, created_at);

-- ── MONEY: the booking's own money columns ──────────────────────────────────
-- WHY stored per booking and not computed on the fly: `total` is the amount the
-- CUSTOMER pays. Commission is the MANAGER's 15% of it. The rate is a setting
-- that can change, so if commission were derived live from the current rate, a
-- rate change would silently rewrite the earnings history of every past job.
-- Snapshotting `commission_rate` + `commission_amount` on the booking freezes
-- what was agreed at the moment the job was dispatched.
ALTER TABLE bk_bookings ADD COLUMN IF NOT EXISTS commission_rate   NUMERIC(5,2);   -- % snapshotted, e.g. 15.00
ALTER TABLE bk_bookings ADD COLUMN IF NOT EXISTS food_value       INTEGER NOT NULL DEFAULT 0; -- total − delivery_fee (the commission base)
ALTER TABLE bk_bookings ADD COLUMN IF NOT EXISTS commission_amount INTEGER NOT NULL DEFAULT 0; -- manager's cut, pesos
ALTER TABLE bk_bookings ADD COLUMN IF NOT EXISTS rider_payout     INTEGER NOT NULL DEFAULT 0; -- rider's cut = food_value − commission
ALTER TABLE bk_bookings ADD COLUMN IF NOT EXISTS commission_paid_at TEXT;         -- when the manager settled it
ALTER TABLE bk_bookings ADD COLUMN IF NOT EXISTS commission_paid_by INTEGER REFERENCES bk_users(id);

-- Payout ledger. Commission "earned" (DELIVERED) is not the same as commission
-- "paid" (cash/GCash handed over). A rider can have delivered 5 jobs and been
-- paid for 3 — the profile page must be able to show both, or the manager has
-- no idea what they still owe.
CREATE TABLE IF NOT EXISTS bk_rider_payouts (
  id            INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  rider_id      INTEGER NOT NULL REFERENCES bk_riders(id) ON DELETE CASCADE,
  amount        INTEGER NOT NULL,                 -- pesos paid out
  method        TEXT NOT NULL DEFAULT 'CASH',     -- CASH | GCASH | BANK
  reference     TEXT,                             -- receipt / txn no
  period_from   TEXT,                             -- what range this settles
  period_to     TEXT,
  note          TEXT,
  booking_ids   TEXT,                             -- JSON array of the jobs covered
  created_by    INTEGER REFERENCES bk_users(id),
  created_at    TEXT DEFAULT (now()::text)
);
CREATE INDEX IF NOT EXISTS idx_bk_payouts_rider ON bk_rider_payouts(rider_id, created_at);

-- Manager commission ledger. The manager earns 15% of what riders deliver, so
-- this is a first-class money record, not a derived number — the manager should
-- be able to see "what I earned this week" and reconcile it against payouts.
CREATE TABLE IF NOT EXISTS bk_commission_ledger (
  id          INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  booking_id  INTEGER NOT NULL REFERENCES bk_bookings(id) ON DELETE CASCADE,
  rider_id    INTEGER REFERENCES bk_riders(id) ON DELETE SET NULL,
  amount      INTEGER NOT NULL,                   -- manager's cut on this booking
  basis_food  INTEGER NOT NULL,                   -- the FOOD value it was % of (total − delivery_fee)
  rate        NUMERIC(5,2) NOT NULL,              -- the % used
  day_id    INTEGER REFERENCES bk_dispatch_days(id),  -- the dispatch day it belongs to
  period      TEXT,                               -- YYYY-MM, for monthly reports
  status      TEXT NOT NULL DEFAULT 'ACCRUED',    -- ACCRUED | PAID | VOID
  paid_at     TEXT,
  note        TEXT,
  created_at  TEXT DEFAULT (now()::text)
);
-- One commission row per booking, ever. This makes a double-accrual impossible at the
-- database level rather than relying on application logic to be correct.
CREATE UNIQUE INDEX IF NOT EXISTS uq_bk_comm_ledger_booking ON bk_commission_ledger(booking_id);
CREATE INDEX IF NOT EXISTS idx_bk_comm_ledger_rider ON bk_commission_ledger(rider_id, status);
CREATE INDEX IF NOT EXISTS idx_bk_comm_ledger_period ON bk_commission_ledger(period, status);
```

#### 6.1.1 One branch, one dispatch day — and why that is a feature

The app serves **a single branch and a single operating day at a time.** Every booking on the board
belongs to the same day, and there is nothing to choose between branches. This removes an entire
dimension from the product, and it is worth being explicit about what it buys and what it costs.

**What disappears**

| Removed | Because |
|---|---|
| `bk_bookings.branch` | one store — the pickup point is already in the pasted text |
| Branch pickers, branch filters, branch chips | nothing to pick |
| Per-rider branch matching | every rider serves the one store |
| **All date and time-slot parsing and storage** | there is no per-booking date to hold (§6.5) |
| Multi-day "upcoming bookings" views | the board is today, full stop |
| Date-range filters on the live board | the board *is* the filter |

**What the day model still needs to get right.** A day has to start and end, and the boundary has to
be the shop's, not the server's. Three things make that safe:

1. **`bk_dispatch_days` is a real row per operating day.** It is not a date string on a setting, so
   yesterday's board keeps its own bookings, its own earnings and its own frozen totals. The manager
   can look back at any past day and it is still exactly what happened.
2. **A day rolls over at `day_cutoff_hour`, store-local** (default `4` — i.e. 4 AM, after the last
   late deliveries of the previous day). A booking created at 1:30 AM belongs to the **previous**
   dispatch day, which is the behaviour a late-night food order actually needs.
3. **Closing a day freezes its totals.** `POST /api/manager/day/close` writes a `totals_snapshot`
   (booking count, food value, commission, rider payouts). After that, a late correction to a booking
   is visible in the audit trail but **cannot silently change what the day was reported as**. A day's
   takings are a statement, not a live query.

**Rollover is automatic, with a manual override.** A 30-second server tick checks whether the
current open day has passed its cutoff; if so it closes it (freezing totals) and opens the next one,
broadcasting a `day` event so every phone's board rolls over by itself. The manager can also close
early — for a holiday, a power cut, or simply finishing up — and open the next day manually.

**Exactly one day is OPEN at a time**, enforced by a partial unique index:

```sql
-- at most one open day: a second concurrent open day is impossible, not merely unlikely
CREATE UNIQUE INDEX IF NOT EXISTS uq_bk_days_one_open
  ON bk_dispatch_days ((status)) WHERE status = 'OPEN';
```

So "which board am I looking at?" can never be ambiguous, and no code path can create a second
competing board.

**Rider earnings still span days.** A rider's *board* is today; their *earnings* are cumulative,
because that is their money. So the earnings screens offer **[ Today ]** and **[ All time ]** — two
tabs, not the five a multi-day product would need. The manager's commission summary shows
**today**, **this month**, and **all time**.

**One branch** is just a display string (`store_label`, e.g. "Postre — Naga") shown in the header and
in the push notifications. It is not a field on anything, and there is no code path that could
produce a booking pointing at the wrong store.

### 6.2 Live transport

| Concern | Choice | Rationale |
|---|---|---|
| In-app live updates | **SSE** (`GET /api/booking/events`) | Server→browser push only; survives Render's proxy with a 20s heartbeat (exactly what `admin-events.ts` already does); auto-reconnects natively; zero new deps. |
| Backgrounded / closed app | **Web Push** (`bk_booking_devices`) | The APK is a WebView — when Android kills it, SSE dies. Push is the only thing that still reaches the rider. Reuses the existing VAPID keys. |
| Presence | **HTTP heartbeat + server sweep** | 20s client heartbeat; `online = EXISTS(fresh row within 60s)`. A 30s server sweep recomputes and broadcasts **only on change**. |
| Channel scoping | Audience filter on the SSE hub | `MANAGER` gets everything; `RIDER:<id>` gets only: new open jobs, own assignment, own request updates, own job status. |

New module `src/services/booking-events.ts` mirrors `admin-events.ts` but adds an `audience` key and
a filter callback, so it can never leak another rider's job to a device.

```ts
// planned shape
type BookingScope = 'bookings' | 'requests' | 'presence' | 'riders' | 'chat' | 'session' | 'release';
interface BookingChannel { audience: 'MANAGER' | 'RIDER'; riderId?: number; }
function emitBookingEvent(scope: BookingScope, detail: Record<string, unknown>): void;
```

Every `bookings` event detail **includes `live_group` and `is_ongoing`** (§6.4.1), so a card that
flips to ongoing repaints in place on every connected device without a refetch — and it costs
nothing, because the value is already derived on the write path.

**Extension, not a fork:** `push.ts` currently reads `push_subscriptions` unconditionally. We add
`sendToAudience(audience, payload)` reading `bk_booking_devices`. The whole module is ours —
there is no Messenger-bot push code to preserve, because there is no shared code (§0).

### 6.3 Why NOT reuse the `reservations` table

`reservations` looks superficially similar, but reusing it breaks in four concrete ways:

1. **`UNIQUE(res_date, time_slot, customer_name)`** — two different customers named "Maria" booking
   the same slot collide on a constraint that is meaningless for dispatch. Dropping it is a
   destructive migration on live data.
2. **It is order-coupled** — `order_id REFERENCES orders(id)`, and
   `syncReservationFromOrder()` / `ensureReservationFromOrder()` write to it from the checkout path.
   Dispatch bookings must never be mutated by an order status change.
3. **Its status vocabulary is wrong** — only `PENDING | CONFIRMED | CANCELLED | COMPLETED`, mirroring
   the order lifecycle. Dispatch needs `PENDING/ASSIGNED/ACCEPTED/PICKED_UP/DELIVERED/…`.
4. **No rider dimension at all** — no `assigned_rider_id`, no claims, no timeline, no presence.

**Decision: new tables.** `reservations` stays untouched and keeps doing exactly what it does today.

### 6.4 Booking state machine

```
                  manager assigns
     ┌──────────────────────────────────┐
     │                                  ▼
 ┌────────┐  rider accepts   ┌──────────┐  picks up  ┌───────────┐  delivers  ┌──────────┐
 │PENDING │ ───────────────► │ ACCEPTED │ ─────────► │ PICKED_UP │ ─────────► │ DELIVERED│
 └───┬────┘                  └────┬─────┘            └───────────┘            └──────────┘
     ▲                            │                                            (terminal)
     │ rider declines             │ rider declines
     └────────────────────────────┘
 any non-terminal ──manager cancels──► CANCELLED (terminal)
```

#### 6.4.1 The three live groups — what "ongoing" actually means

The six statuses above are the **authoritative** state and drive every rule, permission and money
calculation. But a manager glancing at a live board does not want to read six words — they want to
know three things: **is it still up for grabs, is somebody on it right now, or is it done?**

So every booking is *also* classified into exactly one **live group**, derived server-side (never
stored — see below):

| Live group | `is_ongoing` | Statuses in this group | Meaning |
|---|---|---|---|
| 🟡 **Open** | `false` | `PENDING` | Nobody has it. Riders can request it. |
| 🔵 **Claimed** | **`true`** | `ASSIGNED` | A rider has it, but has **not accepted yet**. Offers and approvals live here. |
| 🟠 **Ongoing** | **`true`** | `ACCEPTED`, `PICKED_UP` | **A rider has taken it and is actively working it.** This is the "rider already took it" state. |
| ⚪ **Closed** | `false` | `DELIVERED`, `CANCELLED` | Finished or dead. No further action. |

**"Ongoing" = `ACCEPTED` + `PICKED_UP`.** That answers the requirement directly: a booking becomes
ongoing the moment the rider accepts it, and stays ongoing while they hold it, until they deliver it.
`ASSIGNED` is deliberately **not** ongoing — the rider has been *offered* it but has not taken it, so
counting it as ongoing would tell the manager a job is covered when it is not.

```ts
// derived in src/services/bookings.ts — read-only, never persisted
export type LiveGroup = 'OPEN' | 'CLAIMED' | 'ONGOING' | 'CLOSED';

export function liveGroupOf(status: string): LiveGroup {
  switch (status) {
    case 'PENDING':                      return 'OPEN';
    case 'ASSIGNED':                     return 'CLAIMED';
    case 'ACCEPTED': case 'PICKED_UP':   return 'ONGOING';
    case 'DELIVERED': case 'CANCELLED':  return 'CLOSED';
    default:                             return 'OPEN';   // an unknown status must never hide a job
  }
}
export const isOngoing = (status: string): boolean => liveGroupOf(status) === 'ONGOING';
```

Every booking read returns `{ status, live_group, is_ongoing }` so the client never re-derives the
rule — and a future status cannot be silently mislabelled by an out-of-date app.

**Why derived and not a stored column.** A stored `is_ongoing` would have to be updated inside every
transition, which means one more thing that can drift out of sync with `status`. Derived means the
answer is *always* consistent by construction, and adding a status later cannot produce a booking that
is ongoing in the database but not on screen.

**What this changes in the UI**

- **Manager dashboard** — three live counters: `Open · n` / `Ongoing · n` / `Done today · n`, and the
  board grouped by live group. Ongoing cards carry a **pulsing 🔵 dot** and the rider's name, so
  "someone is on it" is visible without opening anything.
- **Open Jobs tab (rider)** — only `is_ongoing === false` bookings, i.e. `PENDING` only. A rider never
  sees a job another rider has already taken, so two riders can never race for the same job.
- **My Jobs (rider)** — ongoing jobs pinned to the top with the next action as the single primary
  button (`Accept` → `Pick up` → `Deliver`), per the one-primary-action rule in §10.6.2.
- **Green/amber dot** — a booking card shows a **🟢 dot when its assigned rider is online** and a
  **⚪ dot when they are not**, so the manager sees at a glance whether an ongoing job has a reachable
  rider. This combines the presence data from §4.5 with the live group from here.
- **SSE scope `bookings`** — the payload includes `live_group`, so a card that flips to ongoing
  repaints in place on every connected device.

**Edge case — a rider goes offline mid-job.** An ongoing booking whose rider turns grey is **not**
auto-returned to Open: the job is real, the food is probably prepared, and silently reopening it would
let a second rider take a delivery already in motion. Instead it is flagged **"⚠ Ongoing · rider
offline"** on the manager's board, and the manager decides — nudge the rider, transfer it (§4.4), or
cancel. Transfer is the escape hatch, and it keeps the audit trail intact.

Legal transitions, enforced in ONE place (`assertTransition()` in `src/services/bookings.ts`):

| From | To | Actor | Side effects |
|---|---|---|---|
| — | `PENDING` | Manager | **`total` and `Df` validated** (§ parser table); `applySplit()` writes `food_value` + `commission_amount` + `rider_payout`; event `CREATED`; broadcast; push open-job alert to online riders |
| `PENDING` | `ASSIGNED` | Manager (assign / approve request) | set `assigned_rider_id` + `assigned_at`; event `ASSIGNED`; auto-`REJECT` other pending requests; push rider. **Money unchanged** — the split was set at creation |
| `PENDING` | `CANCELLED` | Manager | `cancel_reason`; zero the money columns; push open-job alert |
| `ASSIGNED` | `ACCEPTED` | Assigned rider only | `accepted_at`; event; push manager |
| `ASSIGNED` | `PENDING` | Assigned rider only (decline) | clear `assigned_rider_id`; event `DECLINED`; **`repriceOnRedispatch()` at the current rate**; booking reopens |
| `ASSIGNED` | `ASSIGNED` | Manager (transfer/swap) | release old rider, set new rider, `TRANSFERRED` event with `reason` + both names; push BOTH riders. **Money unchanged** — the job's value does not move |
| `ACCEPTED` | `PICKED_UP` | Assigned rider only | `picked_up_at` |
| `ACCEPTED` | `ASSIGNED` | Manager (transfer) | same as above |
| `PICKED_UP` | `DELIVERED` | Assigned rider only | `delivered_at`; terminal; **`accrueOnDelivery()` writes the `commission_ledger` row in the same transaction** |
| any non-terminal | `CANCELLED` | Manager | `cancelled_at`, `cancel_reason`; zero money; `VOID` any ledger row |

**Invariants (asserted in tests):**
- Only the current `assigned_rider_id` may accept / decline / pick up / deliver.
- A rider may hold at most `booking_max_concurrent` jobs (configurable in `bk_settings`, default 1)
  in `ASSIGNED` + `PICKED_UP` — prevents a popular rider hoarding the board.
- Transfer requires a non-empty `reason` (audit trail).
- Every transition writes exactly one `booking_events` row and emits exactly one live event.
- Money rules in §6.6.5 always hold — in particular `commission_amount + rider_payout === food_value`.
- `live_group` is always derived from `status` by `liveGroupOf()` and is **never persisted**, so it can
  never disagree with the authoritative status. `is_ongoing === true` **iff** status is `ACCEPTED`
  or `PICKED_UP`.
- A booking is only `ONGOING` when `assigned_rider_id IS NOT NULL` — an ongoing job always has a rider.
- Status and money are written **in one transaction**; a failure rolls both back. A delivered job
  without a ledger row (or vice versa) is not a reachable state.

### 6.5 The parser — three things, and nothing else

The manager pastes the whole Booking Details block. We extract **only three things** from it:

| # | What | Why it is worth parsing |
|---|---|---|
| 1 | **`Total:`** | the commission base and the rider's payout — a mistyped peso is a real dispute |
| 2 | **`Df`** | subtracted from the total to get the food value |
| 3 | **the Waze link** → coordinates | powers the 🗺️ Navigate button, so the rider is not copy-pasting a URL on a phone |

**Everything else is not parsed.** No name, no phone, no address, no date, no time slot, no item
lines, no payment method, no order type, no branch. The pasted text is stored
verbatim in `details_text` and shown to the rider as-is.

This is a deliberate simplification. A parser that tries to understand a formatted block it does not
control will eventually mis-read something and silently dispatch a rider to the wrong place. A parser
that reads two numbers and a coordinate, and shows everything else untouched, cannot.

#### 6.5.1 Pipeline

```
rawPaste
  -> extractTotal()   -> integer pesos | null     (required)
  -> extractDf()      -> integer pesos | null     (optional, 0 when absent)
  -> extractPin()     -> { lat, lng } | null      (§6.5.3)
  -> everything else stays in details_text, verbatim
```

Three small pure functions. No database, no I/O, no segmentation, no label map, no scoring.

#### 6.5.2 `extractTotal()` and `extractDf()`

Both use one helper: pull the first number out of a line, tolerating `₱` and thousands separators,
then `Math.round` it to integer pesos.

| | Line matched (case-insensitive) | Covers |
|---|---|---|
| **Total** | `/^\s*(💰\s*)?(grand\s+)?total\s*:?\s*/i` | `Total:₱1,000`, `Total: ₱1,234`, `💰 Total: ₱1,234`, `Grand Total:` |
| **Df** | `/^\s*(d\.?f\.?|delivery\s*(fee|charge))\s*:?\s*/i` | `Df ₱50`, `Df:₱50`, `Delivery Fee ₱50` |

- The **last** matching line wins, so the real `Total:` lower down the block beats any earlier mention.
- Numbers are read as `1,000` / `1000` / `1000.50` → integer pesos.
- If no `Total` is found, the manager is asked to type it. A booking is never created with ₱0 (§6.5.4).

#### 6.5.3 `extractPin()` — the Waze coordinates

Scans for, in order of reliability:

| Priority | Source | Example |
|---|---|---|
| 1 | the `;;;WAZE={…}` trailer | decode → `.https` or `.app` → `ll=LAT,LNG` |
| 2 | a Waze URL | `waze://?ll=13.5234,123.4567&navigate=yes` or `https://waze.com/ul?ll=…` |
| 3 | a Google Maps URL | `https://www.google.com/maps/…/@13.5234,123.4567` |
| 4 | a `geo:` URI, or a bare `lat, lng` pair | `geo:13.5234,123.4567` |

Then, **always**:

1. parse `lat` / `lng` as finite numbers, `lat ∈ [-90, 90]`, `lng ∈ [-180, 180]`;
2. **reject `0, 0`** — that is "unset", and it would send a rider to open water;
3. store the two numbers on the booking. **The URL is never stored** — only the coordinates.

**Why the URL is not stored:** a URL frozen into a record goes stale the moment anyone edits the
address, and the rider then navigates to the old pin — the wrong house. The Messenger-bot already hit
that bug and fixed it in migration v13, so this rule is learned rather than guessed: the booking owns
the **coordinates**, and both nav links are re-derived from them at read time (§10.6.7).

#### 6.5.4 What the manager sees, and what is validated

After pasting, the manager gets a compact preview — three rows, not a form full of guesswork:

```
┌──────────────────────────────────────────┐
│  Total   ₱1,000        Df  ₱50           │
│  Food value  ₱950    (15% = ₱143 you)    │
│  📍 Drop-off pin found  ✔                │
├──────────────────────────────────────────┤
│  Customer name  [ ______________ ]  opt. │
│  Customer name  [ ______________ ]  opt. │
├──────────────────────────────────────────┤
│  [ Create booking ]                      │
│  Everything else stays as you pasted it. │
└──────────────────────────────────────────┘
```

| Rule | Response if broken |
|---|---|
| `total` present and `> 0` | `400 "A booking total is required for commission"` |
| `delivery_fee ≥ 0` and `≤ total` | `400 "Df cannot exceed the booking total"` |
| `total − delivery_fee > 0` | `400 "Total and Df leave no food value"` |
| **A Waze link was present but gave no usable coordinates** | `400 "Found a Waze link but no usable coordinates"` — the manager either fixes the pin or confirms text-only |

A ₱0 total would silently produce ₱0 commission and quietly corrupt every earnings figure, so it is
rejected. A `Df` larger than the total is a typo — caught here rather than producing a negative food
value. A link we cannot read is **never** silently ignored, because that is how a rider gets lost.

#### 6.5.5 What the rider sees

The rider is not shown a parsed record — they are shown **the paste itself**, plus the three things
the app is genuinely good at:

```
┌──────────────────────────────────────┐
│  BK-1042            🟠 ONGOING        │
├──────────────────────────────────────┤
│        [  🗺️  NAVIGATE  ]            │   <- opens Waze, turn-by-turn
│        [  Open in Google Maps ]      │   <- always offered as well
├──────────────────────────────────────┤
│  YOU EARN      ₱807                  │
│  Total ₱1,000 · Df ₱50 · 15% comm    │
├──────────────────────────────────────┤
│  DETAILS (as pasted)                 │
│  ┌────────────────────────────────┐  │
│  │ pick up:                       │  │
│  │ POSTRE                         │  │
│  │ Zone 5 San Francisco…          │  │
│  │ Drop off;                      │  │
│  │ Name: Maria Santos             │  │
│  │ Contact#: 09171234567          │  │
│  │ …                              │  │
│  └────────────────────────────────┘  │
│                    [  📞 Call  ]      │
└──────────────────────────────────────┘
```

Keeping the text verbatim means the rider sees the address, name, phone and items **exactly as the
manager saw them** — no parser in between to get it wrong. `details_text` renders as plain text
through `esc()` (§6.11.5): it is customer-supplied content, never HTML.

**Why the base is the food value, not the gross total.** The delivery fee is a pass-through charge
for transport, not a food sale. Commission is taken on what the shop actually earned for the food,
and the rider is compensated for the delivery out of that same food value. If the 15% were taken on
the ₱1,000 gross, the manager would be earning commission on a fee the shop merely collected on the
rider's behalf. This resolves open question **#8** in §18.

**Rounding:** `Math.round(food_value * rate / 100)`, computed **server-side only**, in exactly one
function (`computeSplit()` in `src/services/booking-money.ts`). Never in the client. The client only
*displays* what the server returned, so a phone's rounding can never disagree with the ledger.
Rounding is applied **once**, to the commission; the rider's payout is then the remainder, so the two
always sum back to the food value exactly — the money can never gain or lose a peso to rounding.

**Why snapshot the rate?** If commission were derived live from the current setting, changing the
rate from 15% → 20% would retroactively rewrite what every past job earned. Riders would (rightly)
call that a bug. The snapshot freezes the deal at dispatch.

**Pickup jobs:** a pickup has no delivery. The parser sets `delivery_fee = 0`, so `food_value ===
total` and the rider's payout is the full 85% of the total. No special-casing is needed — the
formula handles it.

#### 6.6.2 When money is accrued

| Event | `commission_amount` | `commission_ledger` | `rider_payout` |
|---|---|---|---|
| Booking **created** (PENDING) | computed & stored | not yet | computed & stored |
| **Assigned** to a rider | unchanged (already set) | not yet | unchanged |
| Rider **declines** → PENDING | **recomputed** at the *current* rate (a re-dispatch is a new deal) | not yet | recomputed |
| **Transferred** to another rider | **unchanged** — the job's value doesn't move | not yet | unchanged |
| Rider **delivers** | unchanged | ✅ **row written** (`ACCRUED`) | unchanged |
| Manager **cancels** | zeroed | `VOID` if one existed | zeroed |

Commission **accrues on delivery, not on assignment** — that is the honest trigger. A rider who
accepts and then never delivers has earned nothing. The ledger row is written inside the same
`assertTransition()` call that flips the status to `DELIVERED`, so it can never drift out of sync.

#### 6.6.3 Earned vs. paid (two different numbers)

```
  EARNED = Σ commission_ledger.amount  where status = ACCRUED  (delivered, not settled)
  PAID   = Σ rider_payouts.amount                          (cash actually handed over)
  OWED   = EARNED − PAID            ← the number the manager most needs to see
```

Showing only "earned" is how a manager pays a rider twice. Showing only "paid" hides what they still
owe. Both are shown, with **OWED** highlighted.

#### 6.6.4 Settings that drive the money

Stored in our own `bk_settings` table (live-editable, no redeploy), read through a 60s-cached
service exactly like `store-info.ts` already does:

| Key | Default | Meaning |
|---|---|---|
| `commission_rate` | `15` | Default % snapshotted onto each new booking |
| `booking_commission_enabled` | `1` | Master switch — `0` ⇒ new bookings get rate 0 |
| `booking_currency_symbol` | `₱` | Display symbol everywhere |
| `booking_show_rider_earnings` | `1` | Whether riders see their own payout figure |
| **`store_label`** | **`Postre`** | **The ONE branch name, shown in the header and push notifications. A display string, not a field on anything** |
| **`day_cutoff_hour`** | **`4`** | **Store-local hour the dispatch day rolls over. A booking at 1:30 AM belongs to the PREVIOUS day** |
| **`auto_rollover`** | **`1`** | **Close + open the day automatically past the cutoff. `0` = the manager closes it by hand** |

**Rate-change safety:** changing the rate affects **only bookings created afterwards**. The Settings
page states this next to the field, and the API **refuses** to retroactively re-price delivered
bookings — a `POST /reprice` endpoint is deliberately not provided.

#### 6.6.5 Invariants (asserted in tests)

- `food_value === total − delivery_fee` for every booking — the only two money inputs, and nothing
  else is ever added or subtracted into the calculation.
- `commission_amount + rider_payout === food_value` for every booking. A violation is a 500, never a
  silent drift.
- `commission_amount === Math.round(food_value × commission_rate / 100)`.
- `0 ≤ delivery_fee ≤ total` and `food_value > 0` at creation (§ parser validation table).
- A `commission_ledger` row exists **iff** the booking reached `DELIVERED` (or was voided) —
  counted from both sides in the test.
- Cancelled bookings contribute **0** to every total.
- A rider can never read another rider's earnings; the ownership filter is in the SQL, not the UI.
- All money is **integer pesos**. The codebase has no decimal currency anywhere (`orders.total`,
  `delivery_fee`, `product_variants.price`); introducing centavos would break the `/pricing/preview`
  model and every existing total.


### 6.7 Rider profile page — where the money is seen

`#/manager/riders/:id` is the screen this whole commission model exists to feed.

```
┌─────────────────────────────────────────────────────────────┐
│  ● Jose Ramos          🟢 ONLINE      Motorcycle · last payout 20 Sep │
│  @jose · active since 12 Mar                                 │
├─────────────────────────────────────────────────────────────┤
│  JOBS      BOOKING VALUE      RIDER EARNS     MANAGER COMM.  │
│   27            ₱24,850            ₱21,122          ₱3,728   │
│  4 active    (all time)         (85%)          (15%)        │
├─────────────────────────────────────────────────────────────┤
│  ⚠ OWED TO RIDER:  ₱1,275   (3 delivered jobs not settled)  │
│     [ Record payout ]                                       │
├─────────────────────────────────────────────────────────────┤
│  [ Today | 7 days | This month | All time ]   ← period tabs  │
├─────────────────────────────────────────────────────────────┤
│  REF    DATE   CUSTOMER   TOTAL   DF   FOOD   COMM%  COMM  YOU │
│  BK-1042 30/09 Maria S.   ₱1,000  ₱50   ₱950   15%  ₱143  ₱807 │
│  BK-1039 29/09 Ana R.       ₱500   ?      —      —     —     —  │
│  BK-1031 28/09 Carlo D.    ₱2,200  ₱50 ₱2,150   15%  ₱323 ₱1,827│
│  …                                                            │
│  [ Export CSV ]                                               │
├─────────────────────────────────────────────────────────────┤
│  PAYOUT HISTORY                                              │
│  ₱2,400 · CASH · 2026-09-20 · ref 1182 · "3 jobs settled"   │
├─────────────────────────────────────────────────────────────┤
│  PERFORMANCE                                                │
│  Delivered 22 · Declined 3 · Cancelled 1 · Avg ₱915/job     │
├─────────────────────────────────────────────────────────────┤
│  RECENT TIMELINE (same booking_events as the job detail)    │
└─────────────────────────────────────────────────────────────┘
```

The **`TOTAL / DF / FOOD / COMM / YOU`** columns are the whole money story on one row: what the
customer paid, how much was delivery, what the commission was actually calculated on, the manager's
cut, and the rider's cut. A row still in progress (BK-1039) shows dashes for the derived columns
because nothing is earned or owed until delivery — which is exactly what §6.6.2 says.

**Every figure is click-through:** a period tab re-queries; a row opens that booking; the OWED
banner opens the payout sheet pre-filled with the exact amount.

**The rider's own profile** (`#/rider/profile`) shows a reduced version — their jobs, their earnings,
their payout history — with **no other rider's data** and **no manager commission column** (gated by
`booking_show_rider_earnings`).

### 6.8 Manager settings & profile (complete)

`#/manager/settings` — everything editable at runtime, applied instantly with no redeploy (the same
pattern `branches` / `store-info` / `delivery-tiers` already use in this repo):

| Group | Controls |
|---|---|
| **Commission** | `commission_enabled` toggle · `commission_rate` (0–100, with a live "on a ₱1,000 booking that's ₱150" preview) · explicit note that changes apply to new bookings only |
| **Money display** | `booking_currency_symbol` · `booking_show_rider_earnings` toggle |
| **Dispatch rules** | `booking_max_concurrent` · `booking_auto_reject_others_on_approve` toggle · transfer-reason requirement (locked on) |
| **Live & presence** | `booking_heartbeat_ms` · `booking_presence_ttl_s` · `booking_sweep_ms`, each with a "test" button showing the resulting green/grey timing |
| **History & locale** | `store_timezone` (default `Asia/Manila`) with a **live preview of what "today" currently means** — this is the setting that prevents the UTC day-boundary bug; `booking_history_page_size` |
| **Display** | dark/light/system (`prefers-color-scheme`) · sound on/off · haptics on/off · reduce motion |
| **Privacy** | `booking_open_jobs_show_address` toggle (address hidden on unassigned jobs) |
| **Notifications** | per-event toggles: new job, request received, request approved/rejected, assigned to you, accepted, declined, picked up, delivered, payout recorded · **chat: `BOOKING` cards, `@mention` of me, and a master "never push chat" switch** (§6.11.4) |
| **Store** | the single branch name shown in the header (one store only, §6.1.1) |
| **App** | current version + build no · "Download update" · `app_releases` management (set current) |
| **Danger zone** | purge test bookings · reset rider earnings · re-register a lost device — each behind a typed confirmation |

`#/manager/profile` — the manager's own account:

| Section | Contents |
|---|---|
| **Identity** | display name, username, role badge, avatar initials, phone |
| **Commission earnings** | **today** / this month / all time — `ACCRUED`, `PAID`, `UNPAID` + per-rider breakdown |
| **Security** | change password (current + new + confirm) · active sessions with device, last-seen, "sign out this device" / "sign out all others" |
| **Activity** | the manager's own recent actions, from `booking_events` where `actor_type = 'MANAGER'` |
| **Preferences** | default landing view, sound on/off, vibration on/off, language |
| **About** | app version, build, server health (the `/health` payload), support contact |

**Why the manager's commission sits on their own profile:** it is *their* money. A manager who cannot
see what they have earned is a manager who has to ask.

### 6.9 New service: `src/services/booking-money.ts`

One module owns every peso in the system. Nothing else computes money.

```ts
// planned surface — takes ONLY the two money inputs
computeSplit(total: number, deliveryFee: number, ratePct: number):
  { total, deliveryFee, foodValue, commission, riderPayout }        // pure
currentRate(): Promise<number>            // reads bk_settings, 60s cache
applySplit(bookingId, total, deliveryFee): Promise<void>  // writes food_value + commission_amount + rider_payout
repriceOnRedispatch(bookingId): Promise<void>        // after a decline, at the CURRENT rate
accrueOnDelivery(booking, riderId): Promise<void>     // insert commission_ledger row (basis_food = food_value)
voidLedgerForBooking(bookingId): Promise<void>        // on cancel
riderEarnings(riderId, {from, to}): Promise<Earnings> // EARNED / PAID / OWED + per-booking rows
riderLedgerRows(riderId, {from, to}): Promise<Row[]>  // the table under the period tabs
recordPayout(riderId, input): Promise<Payout>         // insert payout, mark ledger rows PAID
managerCommission({from, to}): Promise<Summary>        // ACCRUED / PAID / UNPAID + per-rider split
```

`computeSplit()` is the **only** function that turns numbers into money. It accepts exactly two inputs
from the outside world — `total` and `deliveryFee` — and derives everything else. No other module may
multiply, subtract or round a peso.

All aggregation is done in SQL (`pg.ts` `many()` with parameters), never by fetching rows into
Node and summing — the rider list must stay fast as the table grows.

### 6.10 History & audit — for both roles

Both the manager and the rider get a real, filterable history. Not a "recent activity" blurb — a
queryable ledger, because it is the thing that settles disputes.

#### 6.10.1 Two problems this section exists to solve

**Problem 1 — the codebase stores timestamps as `TEXT`, and that is a real bug waiting to happen.**

Every table in this project uses `created_at TEXT DEFAULT (now()::text)`, and the admin API derives
"today" with `new Date().toISOString().slice(0, 10)` (`admin.ts:80`). `now()::text` yields the
**database server's** timezone while `toISOString()` yields **UTC**. The moment the Postgres server
and Node disagree — or Render's region differs from the Philippines — a booking created at 11:30 PM
Manila time sorts into the wrong day, "Today's Reservations" silently loses rows, and a rider's daily
earnings are attributed to the wrong date.

The booking app **must not inherit this.** It therefore:

- uses `created_at` (when the job entered the system) and `delivered_at` (when it was earned) as the day
  basis — never a parsed customer-supplied date, which is free text we do not interpret,
- adds a **`store_timezone`** setting (default `Asia/Manila`) and a `todayInTz()` helper,
- writes history timestamps as **UTC ISO-8601 with a `Z`** (`new Date().toISOString()`) so they sort
  lexicographically and compare correctly, and
- **always** computes day boundaries in `store_timezone`, never in UTC.

Every day/month boundary goes through that one helper. Tracked as risk **R16** and asserted in
`verify-booking-history.ts`.

**Problem 2 — the existing delete paths destroy their own audit trail.**

`admin.ts` `DELETE /orders/:id` explicitly deletes `order_status_history` and `reservations`, and
`scripts/purge-order-data.ts` truncates both outright. That is fine for test data but **unacceptable
for money**: deleting a booking must not delete the evidence that commission was earned, or the
ledger stops reconciling.

So the booking app separates the two concepts:

| Concept | Behaviour |
|---|---|
| **Archive** (soft) | `bookings.archived_at` is set. The booking leaves every board, but the row, its `booking_events` and its `commission_ledger` **remain forever**. This is the only "delete" a manager gets. |
| **Purge** (hard) | Never exposed over the API. Only a CLI script (`npm run purge:bookings -- --before=2026-01-01`) for pre-launch test data, and it refuses to run while any `DELIVERED` booking exists unless `--force` is passed. |

`commission_ledger` and `rider_payouts` are additionally **excluded from every purge script** — the
money record is permanent by design.

#### 6.10.2 `booking_events` — expanded into the full audit ledger

The v15 `booking_events` table becomes the single source of truth for **everything** (bookings,
riders, payouts, settings) and gains the columns history needs:

```sql
-- appended to booking_events in the v15 migration
ALTER TABLE bk_booking_events ADD COLUMN IF NOT EXISTS entity         TEXT;   -- 'BOOKING'|'RIDER'|'PAYOUT'|'SETTING'
ALTER TABLE bk_booking_events ADD COLUMN IF NOT EXISTS from_status    TEXT;
ALTER TABLE bk_booking_events ADD COLUMN IF NOT EXISTS to_status      TEXT;
ALTER TABLE bk_booking_events ADD COLUMN IF NOT EXISTS amount_delta   INTEGER; -- money moved by this event
ALTER TABLE bk_booking_events ADD COLUMN IF NOT EXISTS visible_to_rider INTEGER NOT NULL DEFAULT 1;
-- booking_id becomes NULLABLE so non-booking events use the same table
ALTER TABLE bk_booking_events ALTER COLUMN booking_id DROP NOT NULL;
CREATE INDEX IF NOT EXISTS idx_bk_bevents_type  ON bk_booking_events(type, created_at);
CREATE INDEX IF NOT EXISTS idx_bk_bevents_actor ON bk_booking_events(actor_type, actor_id, created_at);
```

`visible_to_rider = 0` hides internal-only rows — a rider must never see another rider's request, a
commission-rate change, or a payout the manager recorded for someone else.

#### 6.10.3 Event vocabulary

| `type` | Written when | Rider sees it |
|---|---|---|
| `CREATED` | booking created (carries `total`, `commission_amount`) | ✅ |
| `PARSED` | the three values were read out of the paste (total, Df, pin) | ❌ |
| `ASSIGNED` | manager assigns | ✅ |
| `TRANSFERRED` | manager swaps riders (records both names) | ✅ |
| `REQUESTED` | rider requests | ✅ own only |
| `APPROVED` / `REJECTED` | manager resolves a request | ✅ own only |
| `WITHDRAWN` | rider pulls their request | ✅ own |
| `ACCEPTED` / `DECLINED` | rider answers an assignment | ✅ |
| `PICKED_UP` | rider collects | ✅ |
| `DELIVERED` | delivered — with `amount_delta = commission_amount` | ✅ |
| `CANCELLED` | manager cancels, with reason | ✅ |
| `EDITED` | any field edited; before → after in `meta` | ✅ |
| `PIN_CHANGED` | the drop-off pin moved; old → new coords in `meta` (the v13 wrong-house guard) | ✅ |
| `TOTAL_CHANGED` | money edited; old and new split in `meta` | ✅ |
| `NOTE` | free-text note | ✅ |
| `PAYOUT_RECORDED` / `PAYOUT_VOIDED` | manager pays the rider | ✅ own |
| `RIDER_REGISTERED` / `RIDER_UPDATED` / `RIDER_DEACTIVATED` | roster changes | ❌ |
| `SETTING_CHANGED` | any `booking_*` setting, old → new | ❌ |
| `COMMISSION_RATE_CHANGED` | rate moved; old, new, and **how many bookings are already snapshotted at the old rate** | ❌ |
| `ARCHIVED` | soft-deleted | ❌ |
| `DAY_OPENED` | a new dispatch day opened and the board rolled over | ❌ |
| `DAY_CLOSED` | a day closed and froze its `totals_snapshot` | ❌ |

#### 6.10.4 Manager history — `#/manager/history`

A full, filterable ledger. This is the shop's operational record.

```
[ All | Bookings | Assignments | Transfers | Approvals | Cancellations | Riders | Settings | Payouts ]
[ Search… ]  [ Rider ▾ ]  [ Date range 📅 ]  [ Export CSV ]

TIME     ACTOR      ACTION          SUBJECT              DETAIL
09:42    Jose R.   🟢 Requested     BK-1042              "near me, can do by 3"
09:41    You       ✅ Approved      BK-1042              → Jose Ramos   ₱1,000 − ₱50 Df = ₱950 base · 15% = ₱143
09:38    You       🎯 Assigned      BK-1042              → Ana R.        reason: nearest rider
09:12    You       📝 Note          BK-1039              "customer asked to call first"
08:55    You       ⚙️ Commission    rate                 15% → 18%       new bookings only · 41 already at 15%
Yesterday
17:20    You       💵 Payout        Jose Ramos           ₱2,400 CASH ref 1182 · 3 jobs settled
```

- Filters are `type`, `actor_id`, `rider_id`, date range (on `created_at`), free-text `q`, plus `include_internal`.
- Grouped by day with sticky date headers, in **store-local** days (§6.10.7).
- **Export CSV** streams the same filtered set — for the accountant, or for a dispute.
- Live: a new event arrives over SSE and prepends to the current view if it matches the filter.

#### 6.10.5 Rider history — `#/rider/history`

A rider's own record, money included. This is the screen they open when they dispute a payout.

```
MY JOBS                                       [ Today ]  [ All time ]

BK-1042  ✅ Delivered  30 Sep   Total ₱1,000  Df ₱50  →  ₱807 you / ₱143 comm  Maria Santos
BK-1039  🚗 Picked up  29 Sep   Total ₱500     Df ?    →  not yet earned        Ana Reyes
BK-1031  ❌ Declined   29 Sep   —                                       "traffic on the bridge"
BK-1028  ❌ Cancelled  29 Sep   —                                       cancelled by manager
BK-1024  ✅ Delivered  28 Sep   Total ₱2,200  Df ₱50  → ₱1,827 you / ₱323 comm Carlo Diaz

EARNED ₱3,102    PAID ₱1,827    OWED ₱1,275             [ Request payout ]
```

- **Declined and cancelled jobs are shown too**, with the reason. A rider must be able to see why a
  job is *not* in their earnings — hiding those rows is exactly what causes disputes.
- Every row expands to the same timeline the booking detail shows, filtered to their own events.
- The `OWED` figure here must **reconcile exactly** with the manager's view of the same rider.
  `verify-booking-history.ts` asserts the two agree; a mismatch is a bug, not a rounding difference.
- Riders see **no** manager commission column, no other rider, and no internal events.

#### 6.10.6 Money history is immutable

- `commission_ledger` amounts are **never updated in place** except the `ACCRUED → PAID` status flip.
  Correcting an error writes a `VOID` row plus a new `ACCRUED` row — never an `UPDATE` of the amount.
- Every payout stores `booking_ids` (the JSON array it settles), so "what did this ₱2,400 cover?" is
  always answerable.
- `POST /manager/payouts/:id/void` reverses a payout and re-opens `OWED`. It never deletes it.
- Changing a booking's `total` after it is `DELIVERED` is **blocked**; before delivery it writes
  `TOTAL_CHANGED` with the old and new split, and only the manager may do it.

#### 6.10.7 Timezone discipline (`src/services/booking-time.ts`)

```ts
// planned surface
storeTimezone(): string                    // bk_settings 'store_timezone', default 'Asia/Manila'
nowIso(): string                           // UTC ISO-8601 with Z — the ONLY way we write timestamps
todayInTz(tz?): string                     // 'YYYY-MM-DD' in the STORE's day, never UTC's
monthInTz(tz?): string                     // 'YYYY-MM' for commission_ledger.period
dayBounds(date, tz): { fromIso; toIso }    // inclusive start / exclusive end, store-local
toStoreLocal(iso, tz): string              // display only
```

**Every** day/month boundary in the app — history filters, period tabs, the ledger's `period`,
"today's bookings", CSV exports, the dashboard counters — goes through this module. The existing
`new Date().toISOString().slice(0, 10)` pattern at `admin.ts:80` is deliberately **not** copied.

### 6.11 Live community chat — manager + all online riders

One shared room between the **booking manager** and **every online rider**. It is the fastest path from
"a job just appeared" to "I'll take it" without leaving the app, and where the manager announces a
delay, a branch running out, or a road closure.

```
┌──────────────────────────────────────────────────┐
│  💬 Team chat                    🟢 4 online      │
├──────────────────────────────────────────────────┤
│                              ┌─────────────────┐ │
│                       09:41  │ 📋 BK-1042 open │ │
│                              │ Total ₱1,000     │ │
│                              └─────────────────┘ │
│  ┌─────────────────┐                              │
│  │ taking BK-1042  │  09:41  🏍 Jose             │
│  └─────────────────┘                              │
│                              ┌─────────────────┐ │
│                       09:42  │ approved 👍     │ │
│                              └─────────────────┘ │
│  ┌─────────────────┐                              │
│  │ on my way       │  09:42  🏍 Marlon          │
│  └─────────────────┘                              │
├──────────────────────────────────────────────────┤
│  [ Say something…                    ] [ ➤ ]    │
└──────────────────────────────────────────────────┘
```

#### 6.11.1 Data model

```sql
CREATE TABLE IF NOT EXISTS bk_chat_messages (
  id           INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  -- Sender. A rider is a RIDER-row admin; the manager is an ADMIN-row admin. Both
  -- live in `admins`, so ONE sender column covers both roles.
  sender_id    INTEGER NOT NULL REFERENCES bk_users(id) ON DELETE CASCADE,
  sender_role  TEXT NOT NULL,          -- MANAGER | RIDER — snapshotted, so a later
                                       --   role change never rewrites history
  sender_name  TEXT NOT NULL,          -- snapshot, so a rename doesn't rewrite the log
  body         TEXT NOT NULL,          -- ≤ 500 chars, validated server-side
  kind         TEXT NOT NULL DEFAULT 'TEXT',  -- TEXT | SYSTEM | BOOKING
  booking_id   INTEGER REFERENCES bk_bookings(id) ON DELETE SET NULL,  -- BOOKING cards
  mentioned_ids TEXT,                  -- JSON array of admin ids from @mentions
  -- Client-generated id: a retried send on a flaky connection is de-duplicated
  -- instead of posting the same line twice.
  client_msg_id TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),   -- never TEXT; see R16
  edited_at    TEXT,
  deleted_at   TEXT,                   -- soft delete: the row stays for the audit trail
  deleted_by   INTEGER REFERENCES bk_users(id)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_bk_chat_client_msg
  ON bk_chat_messages(sender_id, client_msg_id) WHERE client_msg_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_bk_chat_created ON bk_chat_messages(id DESC);  -- keyset pagination
```

**Why no `recipient_id` and no room table.** This is deliberately a **single fixed room**, not a
multi-conversation system. There is one manager team, so rooms/participants/membership would be
infrastructure nothing uses. Adding DMs later means a new table — it must not be designed in now.

#### 6.11.2 The three message kinds

| `kind` | Who can send | Rendered as | Why it exists |
|---|---|---|---|
| `TEXT` | manager + riders | a chat bubble | normal conversation |
| `BOOKING` | **manager only** | an inline card: ref, branch, slot, total, and **Approve / Assign / Open** buttons | the manager pastes once and the booking is live on every rider's screen; tapping it jumps to the job. A rider can claim from the message itself |
| `SYSTEM` | server only | a centred grey line: *"Jose joined"*, *"BK-1042 delivered"*, *"Rate changed to 18%"* | lifecycle facts join the conversation without anyone typing them, identically on every device |

A `BOOKING` message stores only `booking_id` — it is a **reference, not a copy**. The card renders from
the live booking row, so a status change updates every rider's copy automatically and can never show
stale information.

#### 6.11.3 Ordering, pagination, and unread counts

- **Ordering is by `id`, never by `created_at`.** `id` is a monotonic identity from one sequence, so
  two messages sent in the same millisecond can never swap order — which a `TEXT` timestamp allows.
- **Keyset pagination**: `GET /chat/messages?before_id=<id>&limit=50`. Never `OFFSET`, which skips and
  duplicates rows as new messages arrive. Scrolling up loads older pages; scrolling down fetches
  anything newer than the highest id held in memory.
- **Unread state lives on the client**, not in a table. The app remembers the highest `id` it has
  rendered; anything above that is the unread count. No per-user read-receipt row, because with one
  room and one manager it buys nothing and costs a write on every read.
- **Unread badge** on the Chat tab in the bottom nav, and a **dot on the manager's dashboard**.

#### 6.11.4 Live delivery, and when *not* to push

Delivery uses the same two-tier transport as everything else:

| Situation | Mechanism |
|---|---|
| App in the foreground | **SSE** `chat` scope — instant, no push, no battery cost |
| App backgrounded / closed | **Web Push**, under the rules below |

**The push rule is the important decision here.** With 5–15 riders online, pushing *every* message to
*every* rider means a phone buzzing 40 times an hour for chatter that is not addressed to them. That
trains riders to ignore notifications — which then means a genuine "BK-1042 open" alert gets ignored
too. Notification fatigue would silently break the dispatch system.

So:

- **Manager pushes** for `BOOKING` cards, `@mention`s, and `SYSTEM` lifecycle events.
- **Rider pushes** only for **`BOOKING` cards and `@mention`s naming them**.
- **Plain chatter is never pushed** — it arrives over SSE when they next open the app, and the unread
  badge shows what they missed.
- Every push toggles off per-user in **Settings → Notifications → Chat**.

**`@mention`**: typing `@Jose` inserts a chip; the backend resolves it to an `admins` id and stores
`mentioned_ids`. A rider is notified when mentioned; everyone else just sees the chip highlighted.
An unknown handle is sent as plain text — no error, no dead mention, no way to enumerate accounts.

#### 6.11.5 Safety rules that are NOT optional

A shared staff room that will contain customer names and phone numbers needs hard limits, enforced
**server-side**:

| Rule | Enforcement |
|---|---|
| **Body ≤ 500 characters** | `400` on longer. Long text on a phone is a paste accident, not a message |
| **Rate limit: 10 messages / 30 s per user**, 200 / 15 min per IP | a dedicated `chatLimiter` beside the existing `webviewLimiter` / `loginLimiter` in `server.ts` |
| **Never trust `sender_id` from the body** | taken from the verified JWT — a rider cannot post as the manager |
| **`BOOKING` and `SYSTEM` are manager/server only** | a rider sending `kind: 'BOOKING'` is silently downgraded to `TEXT` — no error dialog, no exploit surface |
| **XSS** | every message renders through the same `esc()` helper already used in `app.js` (`& < > "`). **No `innerHTML` with raw message text anywhere**; the client creates text nodes, never HTML |
| **Links are never rendered clickable** | URLs show as plain text, so a rider must consciously copy one — a `javascript:` or `data:` URL is therefore inert |
| **Customer PII is discouraged, not blocked** | a phone or address in chat is a legitimate dispatch case ("is this Maria at 0917… the one on Zone 5?"). The room is readable only by the manager and riders |
| **Delete is soft** | `deleted_at` set, body replaced with "message deleted", row retained. The manager can remove an abusive or leaky message and the timeline stays honest |
| **Deactivated riders lose access immediately** | `requireRider` re-reads `is_active` per request, so a suspended rider is locked out on their next call — no token revocation needed |
| **Archived bookings are not postable** | a `BOOKING` message for an archived booking renders as "no longer available" |

#### 6.11.6 System messages — what joins the room automatically

Emitted by the service layer, never by a client:

| Event | Text |
|---|---|
| Rider comes online / offline | `🏍 Jose is online` · `went offline` — **only after a genuine state change** (§6.2 already broadcasts presence only on change), so a phone that sleeps cannot spam the room |
| Booking created | `📋 New booking BK-1042` |
| Assigned / accepted / picked up / delivered | `✅ BK-1042 accepted by Jose` · `📦 BK-1042 picked up` · `🎉 BK-1042 delivered` |
| Cancelled | `❌ BK-1042 cancelled — customer rescheduled` |
| Commission rate changed | `⚙️ Commission is now 18% — applies to new bookings` |
| Rider added / deactivated | `👤 Marlon added` · `⛔ Marlon deactivated` |

Presence join/leave lines are **suppressed inside the app** — the roster strip in the chat header
already shows who is online, and writing "Jose is online" into the transcript every time a phone wakes
would bury the actual conversation. Presence is still broadcast on the `presence` SSE scope for the
roster; it is simply not persisted to `chat_messages`.

#### 6.11.7 Presence in the chat header

The header shows **`🟢 4 online`** plus a tappable avatar stack (max 5, then `+n`), built from the same
`rider_presence` data as §6.4.1 — no new presence system.

The manager's view adds a **"message"** action per online rider, which composes the existing
**transfer** flow (§4.4) from inside the chat: type the booking ref, pick the rider, done. That is the
manager's most common action, and having it one tap from the conversation is the point of the chat.

#### 6.11.8 Mobile-first specifics for the chat screen

The chat is the most input-heavy screen in the app, so §10.6 needs three additions:

- **The composer is pinned above the keyboard.** `interactive-widget=resizes-content` plus
  `position: sticky; bottom: env(safe-area-inset-bottom)` — the same sticky-CTA rule as §10.6.2, since
  a rider typing "on my way" must not lose the send button behind the keyboard.
- **The transcript is the scroller, the header is fixed.** Auto-scroll to the newest message only when
  the rider is already at the bottom; if they have scrolled up to read, a **"↓ 3 new" pill** appears
  instead of yanking them down. Yanking the view while someone is reading is the classic chat bug.
- **Optimistic send.** The bubble appears instantly with a faint "sending" state, then solidifies on
  the server's `id`, or shows a red "!" with a retry. The `client_msg_id` makes the retry idempotent.
- **No typing indicators.** With 15 riders they fire constantly and cost a write per keystroke; the
  `presence` scope already shows who is online.
- **Haptics:** `[10]` on send, `[200,100,200]` on an incoming `BOOKING` card (the same pattern as
  §10.6.5), so a rider on a motorcycle notices a new job without watching the screen.

## 7. Authentication & Roles

### 7.1 Model — entirely our own

This app has **its own `bk_users` table, its own bcrypt hashing and its own `BK_JWT_SECRET`**. It
does not authenticate against Messenger-bot's `admins` table, and a Messenger-bot token is
worthless here (§0.2, §0.3).

| Role | Row |
|---|---|
| **Manager** | `bk_users.role = 'MANAGER'` — seeded once at first boot from `BK_ADMIN_USERNAME` / `BK_ADMIN_PASSWORD`, then changeable in-app |
| **Rider** | `bk_users.role = 'RIDER'` **plus** a `bk_riders` profile row |

**Bootstrap:** on first boot, if no `MANAGER` row exists, `migrate.ts` creates one from the env
vars and logs a loud "initial manager created — change this password now" warning. There is no
second way in: the manager cannot be created over HTTP, only by the manager.

`BK_JWT_SECRET` is **required** — the server refuses to boot without a 32+ character value,
exactly as Messenger-bot does for its own secret. A missing or short secret is a hard failure,
never a silent fallback to a guessable default.

### 7.2 Separate logins

Two endpoints and two visually distinct login screens — a rider physically cannot land on a
manager screen:

| Endpoint | Accepts | Rejects |
|---|---|---|
| `POST /api/login/manager` | `role = 'MANAGER'` | `RIDER` → 403 |
| `POST /api/login/rider`  | `role = 'RIDER'` **and** an active `bk_riders` profile | `MANAGER` → 403 |

Both return `{ token, refresh, expires_in, profile }`. The UI routes on `role`:
`#/manager/…` vs `#/rider/…`.

**Token model**

- **Access token** — 12h JWT signed with `BK_JWT_SECRET`, claims `{ sub, username, role, rider_id? }`.
- **Refresh token** — opaque 32-byte random hex in `bk_booking_sessions`, **30-day** expiry,
  **rotated on every use** (old row deleted, new inserted) so a stolen refresh token is single-use.
- Both live in `localStorage`. Acceptable for a managed WebView on the rider's own phone; see
  risk R4 for the hardened alternative.

### 7.3 Server-side guards

Every route sits behind middleware. **The client-side role check is cosmetic — the API is the real
boundary:**

```
/api/*              → requireAuth        (valid JWT, is_active = 1)
/api/manager/*      → requireManager     (role === 'MANAGER')
/api/rider/*        → requireRider       (role === 'RIDER' AND bk_riders.is_active = 1)
/api/chat/*         → requireAuth + the above role check
```

Rider-owned resources are **ownership-checked in the query**: a rider fetching
`GET /api/rider/jobs/:id` gets **404** (not 403 — do not confirm existence) unless
`bk_bookings.assigned_rider_id` is their rider id.

`is_active` is **re-read per request**, not cached in the token, so a rider suspended by the
manager is locked out within one request — no token revocation needed. That is what makes chat
membership (§6.11.5) and suspension safe.

### 7.4 Rider registration (manager-only)

`POST /api/manager/riders`:

1. Validate `{ full_name, username, password, phone?, branch?, vehicle?, plate? }`.
   Username unique, 3–32 chars, `[a-z0-9._-]`. Password min 8 chars.
2. Insert `bk_users(username, bcrypt.hashSync(password, 10), 'RIDER', ..., password_reset_required = 1)`.
3. Insert `bk_riders(user_id, full_name, phone, branch, …)` linked to the new `bk_users` row.
4. Emit a `RIDER_REGISTERED` event so every manager device's roster updates live.
5. Return `{ id, username, full_name, must_change_password: true }`.

The rider's **first login is forced through a password-change screen** until they set their own
password. This keeps the manager from holding riders' long-term passwords.

Also provided: `PUT /riders/:id` (profile/branch), `POST /riders/:id/reset-password` (returns a
temp password once), `POST /riders/:id/toggle-active` (soft disable — blocks login immediately,
preserves booking history), and `GET /riders/:id/stats` (assigned / accepted / delivered / declined).

---

## 8. Android APK (downloadable from the browser)

### 8.1 Strategy: PWA first, Capacitor second

| Stage | What it gives you | Effort |
|---|---|---|
| **Stage 1 — PWA at `/booking`** | Installable from Chrome, offline shell, push notifications, home-screen icon. Works on Android immediately with zero build tooling. | Hours |
| **Stage 2 — Capacitor → APK** | A real `.apk` the manager/rider downloads from a link in the browser, installs via "unknown sources", appears with its own app icon. Same HTML/JS/CSS — no rewrite. | ~1 day |

Correct order because Stage 2's web assets are the *same* files, so nothing is thrown away.

### 8.2 PWA specifics (Stage 1)

- `public/booking/manifest.json` — `display: "standalone"`, `start_url: "/booking/"`,
  `scope: "/booking/"`, `theme_color: "#e0553f"` (matches the existing admin manifest),
  192/512 icons + a maskable 512.
- `public/booking/sw.js` — modelled on `public/admin/sw.js`:
  - `push` → `showNotification` (this is the rider's "new job" alert)
  - `notificationclick` → `clients.openWindow('/booking/#/rider/jobs')`
  - `install` / `activate` → `skipWaiting()` + `clients.claim()`
  - **No aggressive cache-first for API calls.** API GETs are network-first with a short cache
    fallback; only the app shell is cache-first. A stale booking board is worse than an empty one.
- Served with the same `no-cache` headers as the other surfaces, plus `Service-Worker-Allowed: /`.

### 8.3 Capacitor → APK (Stage 2)

```
npx cap init "Postre Booking" com.postre.booking --web-dir=..
npx cap add android
```

- `capacitor.config.json` → `server.url = "https://postre-booking.onrender.com/"` (**our** domain, not
  Messenger-bot's).
  **Pointing the WebView at the live server** (rather than bundling assets) means an app update is a
  server deploy — no APK re-release for UI or logic changes. Trade-off: the app needs network to
  function, which is correct for a dispatch tool.
- Android config: `android:usesCleartextTraffic="false"`, `INTERNET` permission, adaptive icon from
  the same `icons/` set, portrait + landscape.
- Build: `cd android && ./gradlew assembleDebug` → `app/build/outputs/apk/debug/app-debug.apk`
  (debug key — fine for sideloading), or `assembleRelease` with a generated keystore for a stable
  signature (needed if the app will live more than a year, since Android blocks upgrades signed with
  a different key).
- Output copied to `public/booking/apk/postre-booking.apk` and committed, so the server serves it.

### 8.4 Download & install flow

- Landing page `/booking/install` — "Download for Android" button + a QR code so the manager can
  scan it onto a rider's phone from the desktop. Same origin → no CORS or mixed-content issues, and
  it works over the already-whitelisted HTTPS domain.
- Route `GET /booking/download/postre-booking.apk`:
  - `Content-Type: application/vnd.android.package-archive`
  - `Content-Disposition: attachment; filename="postre-booking.apk"`
  - `Content-Length` from `fs.stat` (Render streams a 5–10 MB file cleanly with it)
  - `Cache-Control: public, max-age=300`
- Settings screen shows the current version and polls `GET /api/booking/release` against
  `app_releases`; a higher `build_no` shows "Update available" → the same download URL.
- Riders install once via "Install unknown apps". The install page carries an onboarding sheet with
  the Android 8+ enable path (always required for sideloaded APKs).

> **Messenger whitelist:** the APK is a native WebView, **not** a Messenger webview, so the Meta

## 9. API Surface (`src/routes/*`, all mounted at `/api`)

### 9.1 Auth & session

| Method | Path | Who | Notes |
|---|---|---|---|
| POST | `/login/manager` | public | `{username,password}` → `{token,refresh,profile}`; 401 bad creds, 403 wrong role |
| POST | `/login/rider` | public | same, plus rider profile; 403 if no active `riders` row |
| POST | `/refresh` | auth | `{refresh}` → new access token + rotated refresh |
| POST | `/logout` | auth | deletes the session row |
| GET | `/me` | auth | current identity + role + rider profile |
| POST | `/change-password` | auth | forced on first rider login |

### 9.2 Live + presence

| Method | Path | Who | Notes |
|---|---|---|---|
| GET | `/events` | auth | **SSE**. `?channel=manager` or `?channel=rider`. Emits `hello`, `change` (scoped), `: ping` every 20s |
| POST | `/heartbeat` | rider | `{instance_id, platform, app_version}` upserts `rider_presence`; returns `{online_rider_count}` |
| POST | `/heartbeat/offline` | rider | `navigator.sendBeacon` on `pagehide`; best-effort |
| GET | `/presence` | manager | `[{rider_id, full_name, online, last_seen_at, jobs}]` |
| POST | `/push/subscribe` | auth | `{endpoint, keys}` → `bk_booking_devices` with the caller's audience |
| POST | `/push/unsubscribe` | auth | by endpoint |

### 9.3 Bookings (manager)

| Method | Path | Notes |
|---|---|---|
| POST | `/api/manager/bookings/parse` | `{raw}` → `{ total, delivery_fee, lat, lng, has_pin, link_error, details_text }`. **Read-only, never writes** |
| POST | `/api/manager/bookings` | create from the confirmed preview; validates `total`/`Df` (§6.5.4); stores `details_text` verbatim |
| GET | `/api/manager/bookings` | filters: `group` (`OPEN\|CLAIMED\|ONGOING\|CLOSED`), `status` (comma list), `branch`, `from`, `to`, `q`, `rider_id`, `unassigned=1`, `rider_offline=1`, `sort` |
| GET | `/api/manager/bookings/:id` | booking + `requests[]` + `events[]` + rider summary |
| PUT | `/api/manager/bookings/:id` | edit fields (does **not** change status) → event `EDITED` |
| DELETE | `/api/manager/bookings/:id` | `requireRole('ADMIN')`, same guard style as `/api/admin/reservations/:id` |
| POST | `/api/manager/bookings/:id/assign` | `{rider_id, note?}` → `ASSIGNED` |
| POST | `/api/manager/bookings/:id/transfer` | `{to_rider_id, reason}` (**reason required**) → `TRANSFERRED` |
| POST | `/api/manager/bookings/:id/cancel` | `{reason}` → `CANCELLED` |
| POST | `/api/manager/bookings/:id/note` | appends a `NOTE` event |
| GET | `/api/manager/dashboard` | `{ live: { open, claimed, ongoing, done_today }, ongoing: Booking[], open: Booking[], pendingRequests, onlineRiders, ongoingRiderOffline: Booking[] }` — the `live` counts drive the counters, and each booking carries `{live_group, is_ongoing, rider_online}` so a card never needs a second request to know its state |
| GET | `/api/manager/requests` | pending claims queue, oldest first |
| POST | `/api/manager/requests/:id/approve` | → assign that rider, auto-reject the rest |
| POST | `/api/manager/requests/:id/reject` | `{reason?}` |

### 9.4 Bookings (rider)

| Method | Path | Notes |
|---|---|---|
| GET | `/api/rider/home` | one payload: `{ ongoing[], claimed[], open[], requests[], earnings }`, each booking carrying `{status, live_group, is_ongoing}` (one round-trip on a slow phone network) |
| GET | `/api/rider/jobs` | filter: `scope=ongoing|claimed|open|history` (thin wrappers over `live_group`) |
| GET | `/api/rider/jobs/:id` | **404** unless `assigned_rider_id === me` |
| POST | `/api/rider/jobs/:id/request` | `{note?}` → `booking_requests` PENDING (unique per rider) |
| POST | `/api/rider/requests/:id/withdraw` | |
| POST | `/api/rider/jobs/:id/accept` | `ASSIGNED → ACCEPTED` |
| POST | `/api/rider/jobs/:id/decline` | `{reason?}` → back to `PENDING` |
| POST | `/api/rider/jobs/:id/pickup` | `ACCEPTED → PICKED_UP` |
| POST | `/api/rider/jobs/:id/deliver` | `PICKED_UP → DELIVERED` |

### 9.5 Money, commission & earnings

| Method | Path | Who | Notes |
|---|---|---|---|
| GET | `/api/manager/riders/:id/earnings?from&to` | manager | `{ earned, paid, owed, counts, byStatus, avgPerJob }` |
| GET | `/api/manager/riders/:id/ledger?from&to&page` | manager | the per-booking money rows behind the period tabs |
| GET | `/api/manager/riders/:id/earnings.csv?from&to` | manager | CSV export, `Content-Disposition: attachment` |
| POST | `/api/manager/riders/:id/payouts` | manager | `{amount, method, reference, period_from, period_to, note, booking_ids}` |
| GET | `/api/manager/riders/:id/payouts` | manager | payout history |
| POST | `/api/manager/payouts/:id/void` | manager | `{reason}` — reverses a payout, re-opens OWED |
| GET | `/api/manager/commission?from&to` | manager | manager's own `ACCRUED / PAID / UNPAID` + per-rider breakdown + 30-day trend |
| GET | `/api/rider/earnings?from&to` | rider | **own numbers only**, ownership-filtered in SQL |
| PUT | `/api/manager/settings/commission` | manager | `{rate, enabled}` — applies to **new** bookings only; the response echoes the affected count |
| GET | `/api/manager/settings` | manager | every `booking_*` setting for the Settings screen |
| PUT | `/api/manager/settings/:key` | manager | one key, whitelisted against `BOOKING_SETTING_KEYS` |

**Explicitly absent:** no `POST /reprice`. A delivered booking's money is frozen (§6.6.4).

### 9.6 History & audit

| Method | Path | Who | Notes |
|---|---|---|---|
| GET | `/api/manager/history` | manager | `?type=&actor_id=&rider_id=&from=&to=&q=&page=&include_internal=1` — the full ledger |
| GET | `/api/manager/history.csv` | manager | same filters, streamed as CSV |
| GET | `/api/manager/bookings/:id/timeline` | manager | one booking's full event chain, oldest → newest |
| POST | `/api/manager/bookings/:id/archive` | manager | `{reason}` → sets `archived_at`; **the only "delete"** (§6.10.1) |
| POST | `/api/manager/bookings/:id/unarchive` | manager | restores an archived booking |
| GET | `/api/rider/history` | rider | own jobs incl. **declined & cancelled**, with reasons + `earned/paid/owed` |
| GET | `/api/rider/history.csv` | rider | own history export — the same figures the manager sees |
| GET | `/api/rider/jobs/:id/timeline` | rider | own events only; `visible_to_rider = 0` rows filtered out in SQL |
| POST | `/api/rider/payouts/request` | rider | `{amount, note}` — a payout *request*; does **not** create a payout, the manager still records it |
| GET | `/config` (additions) | auth | `store_timezone`, so the client formats dates in the store's zone |

**Rider timeline privacy is enforced in SQL**, not by filtering in JavaScript: the query is
`.eq('booking_id', id).eq('visible_to_rider', 1)` **and** the booking itself must have
`assigned_rider_id = req.rider.id`, otherwise 404.

### 9.7 Community chat

| Method | Path | Who | Notes |
|---|---|---|---|
| GET | `/api/chat/messages?before_id=&limit=50` | auth | keyset-paginated history, newest last; `kind`, `booking_id` and sender fields resolved; soft-deleted rows returned as `body: null, deleted: true` |
| POST | `/api/chat/messages` | auth | `{body, kind?, booking_id?, client_msg_id, mentioned?}` → the created row with its server `id` |
| POST | `/api/chat/messages/booking` | **manager** | `{booking_id, note?}` → a `BOOKING` card, broadcast to every rider |
| DELETE | `/api/chat/messages/:id` | **manager** | soft delete (`deleted_at`), body replaced; the row is retained |
| GET | `/api/chat/online` | auth | `[{user_id, full_name, online, last_seen_at}]` — the header roster, same source as §4.5 |
| GET | `/api/chat/participants` | auth | mention autocomplete: id + display name only, **never** an email or phone |
| GET | `/api/chat/unread?after_id=` | auth | `{count, last_id}` — lets a cold start compute the badge in one cheap query |
| GET | `/api/chat/export` | **manager** | full transcript as a `.txt`/`.csv` file, for disputes ("he said he'd take it") |

**SSE scope `chat`** carries `{ id, kind, sender_id, sender_name, sender_role, body, booking_id,
mentioned_ids, created_at }`. On connect the server replays anything with `id >` the client's
`last_id` query param, so a reconnect after a dropped connection loses nothing.

A rider hitting any `/api/chat/*` route must be `requireRider` **and** have `riders.is_active = true`;
there is no "lurker" role that can read the room without being an active rider.

### 9.8 Dispatch day

| Method | Path | Who | Notes |
|---|---|---|---|
| GET | `/api/day/current` | auth | the open day (`date_ref`, `status`, `opened_at`) + live counters. The server resolves it once, so every client agrees on "today" |
| GET | `/api/manager/days?limit=30` | manager | past days with their **frozen** `totals_snapshot` — read-only |
| GET | `/api/manager/days/:id` | manager | one day: its bookings, its totals, and the frozen snapshot for comparison |
| POST | `/api/manager/days/open` | manager | `{date_ref?}` — opens today if none is open. **409** if a day is already open (the partial unique index backs this up) |
| POST | `/api/manager/days/:id/close` | manager | `{confirm: 'CLOSE'}` — freezes `totals_snapshot`, broadcasts a `day` event so every phone's board rolls over. **409** if any booking on the day is still `PENDING`/`ASSIGNED`/`ACCEPTED`/`PICKED_UP` — finish or cancel them first |
| POST | `/api/manager/days/:id/reopen` | manager | only if the day closed less than 2 hours ago; logged, because reopening a frozen day changes a reported figure |

**Rollover needs no client involvement.** A 30-second server tick calls the same "close + open" path
the manager button uses, so automatic and manual rollover take **identical** code. One path, one set
of guards, no drift.

### 9.9 Riders (manager) & shared

| Method | Path | Who | Notes |
|---|---|---|---|
| GET | `/api/manager/riders` | manager | roster + live presence + current job count + `owed` per rider |
| POST | `/api/manager/riders` | manager | register rider (§7.4) |
| PUT | `/api/manager/riders/:id` | manager | edit profile/branch |
| POST | `/api/manager/riders/:id/reset-password` | manager | returns a temp password once |
| POST | `/api/manager/riders/:id/toggle-active` | manager | soft enable/disable |
| GET | `/api/manager/riders/:id/stats` | manager | lifetime + today counts |
| GET | `/slots?date=` | auth | wraps existing `slotAvailability()` from `services/reservations.ts` |
| GET | `/branches` | auth | wraps existing `getBranchCatalog()` |
| GET | `/release` | auth | current `app_releases` row → update prompt |
| GET | `/config` | auth | `{ max_concurrent, presence_ttl_s, heartbeat_ms, version, currency, commission_rate, show_rider_earnings }` |
| GET | `/sessions` | auth | own active sessions |
| POST | `/sessions/revoke-all` | auth | signs out every other device |

**Conventions copied from the existing codebase:** route aliases for the mobile client where a
verb is ambiguous (the repo already does `POST|PUT|PATCH|DELETE` on the same path in `webview.ts`);
`?session=`/header identity is **not** reused — this app is JWT-only, never client-claimed ids;
`requireRole('ADMIN')` guards destructive routes, matching `/api/admin/reservations/:id`.

## 10. Frontend — `public/`

Vanilla JS + hash routing, matching the existing house style in `public/admin/app.js` (a `NAV`
array, `views.*` render functions, `api()` helper, `modal()` helper, `toast()` helper). No framework,
no bundler, no build step — the same constraint that already shapes `/admin` and `/webview`.

### 10.1 Files

| File | Purpose |
|---|---|
| `index.html` | Shell: login screen, app frame, bottom nav, modal root, `<div id="splash">` |
| `app.js` | All logic: `api()`, `store` (JWT + cached state), `sse()` client, `views.*`, render helpers |
| `style.css` | Mobile-first, matching the admin panel's visual language (`#e0553f` accent, card layout) |
| `sw.js` | Push + notification click (§8.2) |
| `manifest.json` | PWA manifest |
| `icons/icon-192.png`, `icon-512.png`, `icon-maskable-512.png` | Reuse `scripts/resize-icon.cjs` / `generate-icons.cjs` |
| `install.html` | Download page + QR (§8.4) |
| `apk/postre-booking.apk` | Build artifact served to the browser |

### 10.2 Manager screens

| View | Contents |
|---|---|
| `#/manager/dashboard` (Home) | **Live counters**: `Open · n` 🟡 · `Ongoing · n` 🟠 · `Done today · n` ⚪, plus a `Needs approval` badge. **Pending requests strip** (rider name + job + [Approve][Reject]). **Live board grouped by live group** (§6.4.1) — ongoing cards carry a pulsing 🔵 dot + the rider's name + a 🟢/⚪ online dot; `⚠ Ongoing · rider offline` flagged. **Rider roster strip** with live green/grey dots. |
| `#/manager/bookings` | Full board: filter chips (**live group**: Open / Claimed / Ongoing / Closed — or the raw status), branch, date, search, unassigned only; sorted by live group, then newest first |
| `#/manager/bookings/:id` | Detail sheet: money breakdown (Total / Df / Food / Comm / Rider), the pin, the verbatim `details_text`, timeline, requests, action bar |
| `#/manager/new` | **Paste screen** — big textarea, [Paste], [Read details] → the 3-row preview (Total / Df / pin) + optional name & branch → [Create]. §6.5.4 |
| `#/manager/riders` | Roster with green dots, job counts, **₱ owed per rider**, [Add Rider], per-rider actions |
| `#/manager/riders/new` | Register form (name, username, temp password, phone, branch, vehicle, plate) |
| **`#/manager/riders/:id`** | **Rider profile + earnings** — the money screen from §6.7: 4 stat cards, OWED banner, period tabs, per-booking money table, CSV export, payout history, performance, timeline |
| **`#/manager/settings`** | **Complete settings** — the 9 groups from §6.8 (commission, money display, dispatch rules, live & presence, privacy, notifications, branches, app, danger zone) |
| **`#/manager/profile`** | **Manager profile** — identity, own commission earnings, security/sessions, activity, preferences, about |
| **`#/manager/history`** | **Full audit ledger** — type tabs, actor/rider/date filters, search, CSV export, live-prepending, sticky day headers (§6.10.4) |
| `#/manager/payouts/:id` | Payout sheet — pre-filled with the exact OWED amount, method, reference, period, note |
| **`#/manager/chat`** | **Team chat** — the shared room (§6.11): message bubbles, `BOOKING` cards with Approve/Assign/Open, system lines, `🟢 n online` header with the avatar stack, `@mention` composer, unread badge, export |

### 10.3 Rider screens

| View | Contents |
|---|---|
| `#/rider/home` | Two clear zones. **"My Jobs"** — **ongoing jobs pinned to the top** with a pulsing 🔵 marker and the next action as the single primary button (`Accept` → `Pick up` → `Deliver`), then claimed/awaiting-acceptance below. **"Open Jobs"** — `PENDING` only (`is_ongoing === false`), each with [Request] |
| `#/rider/jobs/:id` | **🗺️ NAVIGATE** as the single largest, full-width sticky primary action (§10.6.7) — one tap opens Waze and starts turn-by-turn navigation. Below it: a secondary *Open in Google Maps*, the rider's own earnings, and the **verbatim pasted details** (§6.5.5). No pin ⇒ an amber "No drop-off pin — read the details below" notice, never a dead button |
| `#/rider/history` | Completed jobs + per-rider stats |
| **`#/rider/chat`** | **Team chat** — the same room as the manager (§6.11): bubbles, incoming `BOOKING` cards with [Request] / [Take it], `🟢 n online` header, `@mention` composer, unread badge. **Nothing here is a per-rider DM** — one shared room, by design |
| **`#/rider/history`** | **Own job + money history** — period tabs, delivered/picked-up/**declined**/cancelled rows with reasons, `EARNED / PAID / OWED`, [Request payout], CSV export, expandable timeline (§6.10.5) |
| **`#/rider/profile`** | **Rider's own earnings** (Today / All time, EARNED / PAID / OWED, payout history) + name, branch, vehicle, change password, notification permission, app version + update, logout. **No other rider's data, no manager commission column.** |

**Money formatting is server-driven.** The client formats with `Intl.NumberFormat('en-PH', {
style: 'currency', currency: 'PHP' })` using the `currency_symbol` from `/config`, and always renders
the exact `commission_amount` / `rider_payout` integers the server returned — it never re-derives a
percentage. A manager reading ₱150 on a ₱1,000 job and a rider reading ₱850 on the same job must
never see a discrepancy caused by client arithmetic.

### 10.4 Live client behaviour

```js
// connect once after login; auto-reconnect with backoff
const es = new EventSource(`/api/booking/events?channel=${role}&token=${jwt}`);
es.addEventListener('change', (e) => {
  const { scope, ...detail } = JSON.parse(e.data);
  store.apply(scope, detail);   // mutates the local cache, then repaints the CURRENT view only
});
es.onerror = () => { /* EventSource auto-retries; show a "reconnecting" chip */ };
```

- `store.apply('presence', …)` repaints every green dot on screen **without** a refetch.
- `store.apply('bookings', …)` patches the cached board and repaints if the booking is visible.
- A **"Live" pulse chip** in the header (green when the SSE is open, amber while reconnecting) — the
  manager can tell at a glance whether what they see is current. This mirrors the honest-failure
  philosophy already in `server.ts` (`/health` reporting `messaging.ok`).
- Sound: reuse the admin panel's existing chime approach — a short WebAudio tone on a new job,
  plus device vibration via the `navigator.vibrate` API the existing admin SW already uses.

### 10.5 Offline / reconnect behaviour

- App shell cached (PWA) so the APK opens instantly and shows the last-known board.
- Any mutation attempted while offline shows a clear **"You're offline — this will not send"**
  toast. **We do not queue booking mutations** — a silently-queued assignment is a dispatch hazard.
  Reads are served from cache and flagged stale.

### 10.6 Mobile-first UI — the primary design constraint

**This is an Android app used one-handed, outdoors, on mobile data, by people riding a motorcycle
between drops.** The phone is the product. Desktop is a courtesy.

Every screen is designed for a **360 × 640 CSS-px viewport first** (the narrowest phone likely in the
fleet), then scales up. There is no separate "desktop layout" — the same DOM and CSS serve every
size, exactly as `public/webview/` already does. We copy that file's proven conventions rather than
invent new ones.

#### 10.6.1 Inherited conventions from `public/webview/style.css`

These are already battle-tested in this codebase and are **reused verbatim**:

| Concern | Existing pattern | Source |
|---|---|---|
| Viewport | `width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover, interactive-widget=resizes-content` | `webview/index.html:5` |
| Height | `100dvh`, not `100vh` (in-app browsers overshoot) | `style.css:18` |
| Notch / home bar | `env(safe-area-inset-top / -bottom)` on header, bottom nav, sheets, FABs | `style.css:35,50,65,1712,1865` |
| Tap highlight | `-webkit-tap-highlight-color: transparent` | `style.css:23` |
| Pull-to-refresh fight | `overscroll-behavior-y: none` on body, `contain` on inner scrollers | `style.css:22,1432,2841` |
| Tap targets | `min-height: 44px` minimum; **48px for primary actions** | `style.css:1392,1624,3224,3390` |
| Bottom nav | `position: fixed` + `padding-bottom: calc(… + env(safe-area-inset-bottom))` | `style.css:1705-1712` |
| Motion | `@media (prefers-reduced-motion: reduce)` honoured | `style.css:83` |
| Small phones | `@media (max-width: 380px)` tightening | `style.css:1123` |
| Wide screens | `@media (min-width: 520px)` enhancement only | `style.css:3512+` |

**No web fonts.** System font stack only — a web font is a multi-hundred-KB download on mobile data
and flashes on every cold start. The existing app already ships no font files.

#### 10.6.2 Touch and layout rules

- **48dp minimum** for every primary action; 44dp for secondary. No target smaller, and no two
  targets within 8px of each other.
- **The bottom third of the screen is the action zone.** A sheet's primary CTA is `position: sticky`
  at the bottom, above the home-bar inset, so it is always thumb-reachable.
- **No hover-dependent affordances.** Every hover style has an `:active` equivalent. Hover does not
  exist on a phone, and an action that only appears on hover is one a rider will never find.
- **Sheets, not modals.** Assign, transfer and payout are **bottom sheets** (swipe-to-dismiss) —
  reachable, and they never cover the content you need while choosing.
- **Sticky bottom nav, always visible.** Manager: `Home · Jobs · Chat · Riders · More` (Chat carries the
  unread badge; More holds Riders/History/Profile/Settings). Rider: `Jobs · Open · Chat · History ·
  Profile`. Max 5 items; the rider's primary action is a raised centre button on Home, mirroring
  `nav-btn-center` (`style.css:1808`). **Chat is a top-level tab, not buried in a menu** — it is the
  fastest path to a job, and burying it is how it goes unused.
- **One primary action per card.** At most one filled button plus ghost buttons. Two filled buttons
  on a small screen is a coin-flip waiting to happen.
- **Long-press for secondary actions**, always with a visible "⋯" — never a hidden gesture.
- **Horizontal scroll only where it earns its place** (the money table in §6.7); everything else is a
  single vertical column, because vertical scroll is the one gesture nobody has to learn.

#### 10.6.3 Data-conscious rendering

Mobile data is the constraint, and the repo already has a performance precedent — `perf-checkout`
(commit `0f720ae`) removed N+1 reads from checkout.

- **`GET /rider/home` returns one payload** for jobs + open jobs + requests + earnings summary. A
  rider's cold start is **one** request, not five.
- **List endpoints paginate** (25 rows) and return counts separately; the UI never fetches all
  history to render the first screen.
- **Cards render from cached state first**, then reconcile — the board paints instantly on open and
  updates when data arrives.
- **Images** are thumbnails only, `loading="lazy"`, explicit `width`/`height` (no layout shift),
  `decoding="async"`. The booking app shows **no product photos on list screens at all** — a photo
  grid is the single biggest data cost in a food app, and a rider collecting a job needs the address
  and the items, not a picture. Photos appear only on the detail screen, and only if present.
- **No interval polling anywhere.** SSE pushes; there is no background refetch timer.

#### 10.6.4 Legibility in daylight

Riders read this outdoors, in a moving vehicle, in direct sun.

- **Base font 16px**; body never below 14px. Money uses `font-variant-numeric: tabular-nums` so
  columns of pesos **align vertically** and a rider can scan a column without reading every row.
- **WCAG AA contrast** (4.5:1) minimum, including status colours — a red that fails contrast in
  sunlight is just an orange smudge.
- **Status is never colour-only.** Every status carries a glyph (`✅ 🚗 ❌ ⏳ 📦`) *and* a colour *and*
  a word. That is an accessibility requirement, and it also survives a sun-faded screen.
- **Support `prefers-color-scheme: dark`** — riders work nights, and a white screen at 2 AM is
  hostile. The existing admin panel is light-only, so this is genuinely new work.

#### 10.6.5 Feedback and haptics

Every state change is confirmed by **three** channels, because a phone in a jacket pocket may only
deliver one:

| Channel | When |
|---|---|
| **Visual** | card highlight, badge count, toast, skeleton → content |
| **Haptic** | `navigator.vibrate` — `[200,100,200]` on a new job (matching `admin/sw.js:23`), `[10]` on a tap ack, `[400,200,400]` on a rejected action |
| **Audible** | a short WebAudio chime on a new job or status change, toggleable for night shifts |

Plus a persistent **"Live" chip** (green = SSE open, amber = reconnecting) so the user always knows
whether what they see is current — the same honest-failure pattern `/health` already uses in
`server.ts` for `messaging.ok`.

#### 10.6.6 Forms on a phone

- **`inputmode` / `type` are set correctly**: `tel` for phone, `decimal` for money, `numeric` for
  quantity, `date` for dates. The paste screen's total field opens the **number pad**, not the full
  keyboard.
- **No thousands separator is typed in** — the manager types `1000`, the app displays `₱1,000`.
  Commas are stripped server-side (parser gotcha G6).
- **No zoom-on-focus.** Every input is ≥16px, so Android/iOS never auto-zoom the viewport.
- **Errors appear inline, under the field**, and the first error is scrolled into view — never a
  toast that disappears before it is read.
- **The paste box is the largest element on the screen**, accepting both a hardware keyboard and a
  long-press paste, because that is exactly how the manager will use it.

#### 10.6.7 🗺️ Auto-navigate — one tap starts turn-by-turn navigation

**The rider taps 🗺️ NAVIGATE once and is in Waze, already routing.** This is the single most
valuable thing the app does, and it is the reason we parse the Waze link at all (§6.5.3).

It is **not** a plain `<a href>`. The Messenger-bot already solved this exact WebView problem at
`admin/app.js:2062-2074`, and explains it in a comment worth quoting:

> *"try the waze:// custom scheme first (hands off to the Waze APP directly, even from inside
> Messenger's webview); if the page is still visible ~1.2s later the app didn't open (not installed /
> desktop) so fall back to the https link in a new tab."*

We port that algorithm unchanged — same problem, different host:

```js
// ported from the proven openWaze(); do not "simplify" this away
function openWaze(appUrl, httpsUrl) {
  if (!appUrl && !httpsUrl) return;
  if (!appUrl) { window.open(httpsUrl, '_blank'); return; }
  const startedAt = Date.now();
  window.location.href = appUrl;                        // hand off to the Waze app
  setTimeout(() => {
    if (Date.now() - startedAt < 2200 && httpsUrl) {     // app never opened
      window.open(httpsUrl, '_blank');                   // fall back to the universal link
    }
  }, 1200);
}
```

**The rules that make it actually work:**

| Rule | Why |
|---|---|
| **`waze://` first, `https://waze.com/ul?...` as the fallback** | A `waze://` URL as plain text is **not clickable anywhere** — the Messenger-bot learned this and puts the *https universal link* in copy text instead. We never ask the rider to tap a link in a paragraph |
| **The `https` link is built server-side from `delivery_lat/lng` on every read** | Never stored. A stale link is the wrong-house bug (§6.5.3) |
| **APK: prefer the Capacitor `AppLauncher` plugin** (`openUrl({url})`) over `window.location.href` | It can report *whether* the app actually opened, instead of guessing from a timer. The timer fallback stays for the browser PWA |
| **Google Maps is always offered as a second button** | Waze is not on every cheap Android phone. A rider on a street at 11 PM with no Waze and no fallback is a failed delivery |
| **Both links are re-derived per request** | A `PIN_CHANGED` edit reaches the rider's screen immediately over SSE — no stale navigation |

**Rider UI — the button is the interface:**

```
┌──────────────────────────────────────┐
│  BK-1042            🟠 ONGOING        │
├──────────────────────────────────────┤
│                                      │
│                                      │
│         [   🗺️   NAVIGATE   ]       │  ← full width, ≥64dp tall,
│                                      │    sticky above the home bar
│         [  Open in Google Maps  ]    │  ← secondary, always present
│                                      │
├──────────────────────────────────────┤
│  YOU EARN      ₱807                  │
│  Total ₱1,000 · Df ₱50 · 15% comm    │
├──────────────────────────────────────┤
│  DETAILS (as pasted)                 │
│  ┌────────────────────────────────┐  │
│  │ pick up: … Drop off; …         │  │
│  └────────────────────────────────┘  │
└──────────────────────────────────────┘
```

- It is the **largest** target on the screen — bigger than Accept or Deliver — because between
  Accept and Pick-up, navigation is what the rider does most.
- Tapping it fires a **haptic pulse** (`[200,100,200]`, §10.6.5) so the rider knows it launched even
  without looking.
- **No pin ⇒ never a dead button.** The button is replaced by an amber notice:
  *"No drop-off pin — read the details below"*, with the verbatim paste still on screen. The rider
  still has the address, because we kept the text.
- The button only appears on a **delivery** booking with a pin. A pickup has nothing to navigate to.

#### 10.6.8 Android WebView specifics (the APK)

The APK runs in a Capacitor WebView, which is **not** a browser. These differ and each is handled:

| Issue | Handling |
|---|---|
| The soft keyboard covers the focused input | `interactive-widget=resizes-content` (already in the webview viewport meta) plus `scrollIntoView` on focus |
| `waze://` blocked or silent inside the WebView | handled by the `openWaze()` algorithm in §10.6.7 — never a bare anchor |
| Back exits the app from any sub-screen | `history.pushState` per view + `popstate`; **exit only from the root**, and from a dirty form ask "Discard changes?" first |
| The status bar overlaps the header | the Capacitor `StatusBar` plugin sets overlay mode + `env(safe-area-inset-top)` padding |
| Long-press triggers the text-selection menu | `user-select: none` on chrome, re-enabled on data cells so numbers stay copyable |
| No pull-to-refresh by default | provided explicitly on lists, disabled inside horizontal scrollers |
| Backgrounding kills the SSE | Web Push takes over (§6.2); on resume the client reconnects and refetches |
| Old WebView on cheap Android phones | target Android 8+ (API 26); no CSS newer than ~2021; test on a low-end device before release |

#### 10.6.9 Accessibility

- Every control is keyboard/switch reachable, with visible focus rings.
- Icons always carry an accessible name; icon-only buttons get `aria-label`.
- The money table is a real `<table>` with `<th scope>`, so a screen reader announces
  "Commission, ₱150" rather than two disconnected numbers.
- `aria-live="polite"` on the board, so a new job is announced without stealing focus.
- Colour-blind-safe status palette — glyph + word carry the meaning (§10.6.4).

#### 10.6.10 Performance budget

| Metric | Target | Why |
|---|---|---|
| Cold start to interactive | < 1.5 s on 4G | cached shell + one API call |
| Largest Contentful Paint | < 2.0 s | no web fonts, no hero image, system font |
| Cumulative Layout Shift | < 0.05 | explicit image dimensions, fixed nav heights |
| Time to Interactive | < 3.0 s | no framework, no hydration |
| Rider home payload | < 40 KB gzipped | one request, paginated |
| Tap response | < 100 ms | `:active` states are CSS-only, never JS-gated |

Verified with Lighthouse mobile emulation **and** a real mid-range Android device before release.
---

## 11. Change List — the entire repository is new

This project **starts from an empty directory**. There are **no "modified files"**, because there is
no existing file to modify. Every path below is created once, in this repo, and nothing outside it
is opened for writing.

### Backend

| Path | Purpose |
|---|---|
| `src/server.ts` | bootstrap, rate limiters, static hosting, `/api` mount, presence sweeper, `/health` |
| `src/db/supabase.ts` | query-builder client from `SUPABASE_SERVICE_KEY` |
| `src/db/pg.ts` | `pg` Pool (max **5**, §5.2) for aggregations |
| `src/db/migrate.ts` | additive idempotent `bk_*` DDL; non-fatal on failure; boundary guard (§5.2) |
| `src/lib/datetime.ts` | `parseDateInput`, `parseTimeInput`, store-timezone day/month helpers (§6.10.7) |
| `src/lib/nav.ts` | `buildWazeAppUrl`, `buildWazeUrl`, `buildGoogleMapsUrl`, `stripNavLines` (§6.5.1) |
| `src/lib/money.ts` | `computeSplit()` — the **only** function that turns numbers into money |
| `src/services/auth.ts` | `bk_users`, bcrypt, JWT, refresh rotation, role guards (§7) |
| `src/services/bookings.ts` | `assertTransition()`, `liveGroupOf()`, queries (§6.4) |
| `src/services/money.ts` | `applySplit`, `accrueOnDelivery`, `riderEarnings`, `recordPayout` (§6.9) |
| `src/services/parse.ts` | the paste parser — pure, no DB, no I/O |
| `src/services/events.ts` | audience-aware SSE hub |
| `src/services/presence.ts` | heartbeat upsert, online computation, 30s sweep |
| `src/services/history.ts` | audit ledger, CSV streaming, archive/unarchive (§6.10) |
| `src/services/chat.ts` | messages, kinds, mentions, system events (§6.11) |
| `src/services/push.ts` | Web Push with **our own** `BK_VAPID_*` |
| `src/services/settings.ts` | `bk_settings` key/value + 60s cache |
| `src/routes/*.ts` | Express routers: auth, bookings, riders, money, history, chat, config (§9) |

### Frontend & packaging

| Path | Purpose |
|---|---|
| `public/index.html` | app shell (login, frames, bottom nav, modal root) |
| `public/app.js` | SPA: `api()`, `store`, `sse()`, `views.*`, `esc()`, `openWaze()` |
| `public/style.css` | mobile-first, following the conventions in §10.6.1 |
| `public/sw.js` | service worker + push handlers |
| `public/manifest.json` | PWA manifest |
| `public/icons/*` | app icons |
| `public/install.html` | APK download page + QR |
| `public/apk/postre-booking.apk` | the build artefact, served to the browser |
| `public/android/` | Capacitor project (Stage 2, §8.3) |

### Schema, tests, infra

| Path | Purpose |
|---|---|
| `migrations/001_bk_init.sql` | **the** schema — pasted into the Supabase SQL Editor once (§5.4) |
| `scripts/verify-parse.ts` | parser unit tests (no DB) |
| `scripts/verify-auth.ts` | role separation, ownership-404, refresh rotation |
| `scripts/verify-flow.ts` | dispatch lifecycle + live groups against the live DB |
| `scripts/verify-money.ts` | commission split, accrual, earned-vs-paid, OWED maths |
| `scripts/verify-presence.ts` | heartbeat / online-set / sweep |
| `scripts/verify-history.ts` | audit ledger, timezone boundaries, manager↔rider reconciliation |
| `scripts/verify-nav.ts` | Waze/Maps links derived server-side, never stored |
| `scripts/verify-chat.ts` | ordering, pagination, kind/role enforcement, XSS, limits, de-dup |
| `scripts/verify-boundary.ts` | **asserts no `bk_*` migration touches a non-`bk_` table** (§0.4) |
| `scripts/purge-bookings.ts` | CLI-only pre-launch test-data purge; refuses while any `DELIVERED` exists |
| `Dockerfile` | **our own** — `node:22-bookworm-slim`, multi-stage, non-root `node` |
| `render.yaml` | **our own** Render service definition |
| `package.json` `tsconfig.json` `.env.example` `.gitignore` `README.md` | standard |

### Explicitly not created, not imported, not touched

- **No file in `C:\Users\Mizeri Jiwu\Desktop\MEssenger-bot` is opened for writing.** Ever.
- No `import`, `require`, relative path, symlink or workspace link into that repo.
- No runtime HTTP call to the Messenger-bot.
- No column, row or index in any of its 28 tables, including `admins`, `app_settings`,
  `reservations`, `orders`, `customers`, `push_subscriptions`.
- `scripts/verify-boundary.ts` fails the build if a migration statement references a non-`bk_`
  object — the rule is machine-checked, not just documented.

> The stray `}` typo at Messenger-bot `src/messenger/send.ts:690` is a real customer-visible bug, but
> **fixing it is out of scope and forbidden here** (§0). Our parser strips the character so pasted
> text still parses. If you want it fixed, it is a one-character change in *that* repo, made
> independently and on its own commit.

---

## 12. Security

| Concern | Control |
|---|---|
| Rider escalation to manager | `requireManager` on every `/api/manager/*` route; the client check is cosmetic only |
| Rider reading another rider's job | Ownership filter in the query → **404**, not 403 (no existence leak) |
| **Rider reading another rider's earnings** | `GET /rider/earnings` is hard-scoped to `req.rider.id` in SQL; a manager-only route owns every other query. No client-supplied `rider_id` is trusted on a rider route |
| **Rider tampering with money** | No rider route accepts `commission_amount`, `rider_payout`, `commission_rate` or `total`. The create/edit field whitelists exclude them; only the manager's own `PUT` can change a total, and that re-runs `applySplit()` server-side |
| **Commission rate abuse** | The rate is a whitelisted `bk_settings` key, not a per-request body field. A client sending `{commission_rate: 90}` is ignored — the server reads the stored setting |
| Rider claiming an already-assigned job | `assertTransition` rejects; `UNIQUE(booking_id, rider_id)` blocks duplicate claims |
| Rider acting on a job that is no longer theirs | Every rider mutation re-reads `assigned_rider_id` inside the guarded write; a transfer invalidates the old rider's buttons immediately via SSE |
| Refresh-token theft | 30-day expiry + **rotation on every use** (single-use) + logout deletes the row |
| Deactivated rider with a live JWT | `requireRider` re-reads `riders.is_active` per request (not cached in the token) → blocked within one request |
| **Payout recorded twice** | `rider_payouts` insert and the ledger `PAID` flip share one transaction; a `booking_id` can only appear in one non-voided payout |
| Brute force | `loginLimiter` equivalent: 10 attempts / 15 min / IP, mirroring `server.ts` |
| Mass assignment | Explicit field whitelists in the create/update handlers; the client cannot set `status`, `assigned_rider_id`, `created_by` or any money column |
| Secrets in logs | Never log `PAGE_ACCESS_TOKEN`, `SUPABASE_SERVICE_KEY`, `VAPID_PRIVATE_KEY`, `JWT_SECRET`, `APP_SECRET`, or refresh tokens. Booking logs carry ids, refs and actor names only |
| SQL injection | Supabase query builder / parameterised `$1` helpers only — same rule as the rest of the repo. Every aggregation query in `booking-money.ts` takes `$1` params, never string-interpolated dates |
| APK tampering | Sideloaded APKs cannot be auto-updated across a changed signing key → document keeping the keystore safe (§17 R7) |
| **Open-job address leak** | The full address and the Waze link are **hidden until the job is assigned** (`booking_open_jobs_show_address = 0`). A rider browsing open jobs has no legitimate need for a specific house |
| **`waze://` link injection** | The booking API **never** stores a URL from pasted text. Coordinates are extracted, validated (finite, in range, not `0,0`) and stored as `DOUBLE PRECISION`; the nav links are **re-derived server-side at read time** from those numbers. A pasted `javascript:` or arbitrary scheme is discarded by the parser, not rendered. `app.js`'s existing `esc()` discipline is applied to every rendered field |
| **Chat XSS** | Message bodies are user-generated and rendered by every rider. They go through the existing `esc()` (`& < > "`) and the client builds **text nodes, never HTML** — no `innerHTML` on any message path. Asserted against the source in `verify-booking-chat.ts`, not just by inspection |
| **Chat impersonation** | `sender_id` comes from the verified JWT, never the body. A rider cannot post as the manager, and cannot set `sender_role` — it is snapshotted server-side |
| **Chat message tampering** | A rider can only ever **create** their own messages. Edit and delete are manager-only; delete is soft (`deleted_at`) so the transcript stays honest. A message is immutable once written |
| **Chat spam** | `chatLimiter` — 10 msgs / 30 s per user, 200 / 15 min per IP — plus a 500-char cap. A rider cannot flood the room and bury a `BOOKING` card |
| **Chat enumeration** | `/api/chat/participants` returns **id + display name only** — never an email or phone the UI does not need. An unknown `@handle` is stored as plain text, so mentions cannot be used to probe for valid accounts |
| **Chat data exposure** | The room is readable only by an authenticated, **active** manager or rider (`requireRider` re-reads `is_active` per request). A suspended rider is locked out on their next call. `/api/chat/export` is manager-only |

## 13. Implementation Phases

Each phase ends with a working, demoable increment. **Do not start Phase N+1 until Phase N is
verified.**

### Phase 0 — Foundations (½ day)
1. `migrations/001_bk_init.sql` → paste into the Supabase SQL Editor, run once (§5.4).
2. The same DDL lives in `src/db/migrate.ts` and runs at boot (idempotent, non-fatal).
3. `src/services/auth.ts` + `src/routes/auth.ts` (auth routes only).
4. `scripts/verify-booking-auth.ts` — proves a `RIDER` is refused by `/api/manager/*` and vice versa.
5. ✅ **Exit:** two logins work against the real DB; cross-role access is 403.

### Phase 2 — Riders + live SSE (1 day)
1. Rider registration routes + manager roster UI with dots (initially all grey).
2. `src/services/booking-events.ts` — SSE hub with audience scoping.
3. `src/services/presence.ts` — heartbeat + online computation + 30s sweep.
4. Client `sse()` + `store.apply()` + the "Live" chip; dots repaint without a refetch.
5. `scripts/verify-booking-presence.ts`.
6. ✅ **Exit:** two browsers (manager + rider); the manager sees the dot turn green when the rider
   opens the app and grey ~90s after it closes.

### Phase 3 — Request → approve → lifecycle (1–1½ days)
1. `booking_requests` routes (request / withdraw / approve / reject) + assignment + transfer.
2. Rider screens: Open Jobs, Request, Accept, Decline, Pick up, Deliver, History.
3. Manager: request strip on the dashboard, assign sheet with green dots, transfer sheet with a
   required reason, full timeline in the detail view.
4. `scripts/verify-booking-flow.ts` — the whole lifecycle + every guard in §6.4.
5. ✅ **Exit:** the complete §4.2 / §4.3 / §4.4 journeys work on two real phones.

### Phase 3.5 — Money, commission, rider earnings & manager settings (1 day)
1. `src/services/booking-money.ts` — `computeSplit()`, `accrueOnDelivery()`, `riderEarnings()`,
   `recordPayout()`, `managerCommission()`.
2. Wire `assertTransition()` so `DELIVERED` writes the `commission_ledger` row and `CANCELLED`
   voids it — one transaction, so money can never drift from status.
3. `PUT /manager/settings/commission` with the "new bookings only" guarantee; seed
   `commission_rate = 15` into `bk_settings`.
4. `#/manager/riders/:id` — the earnings screen (§6.7) with period tabs, OWED banner, money table,
   CSV export and the payout sheet.
5. `#/manager/settings` (all 9 groups) and `#/manager/profile` (own commission + security + activity).
6. `#/rider/profile` — own earnings only, gated by `booking_show_rider_earnings`.
7. `scripts/verify-booking-money.ts` — every invariant in §6.6.5.
8. ✅ **Exit:** deliver a ₱1,000 job at 15% → the rider profile shows ₱850 rider / ₱150 commission,
   OWED drops by ₱850, and the manager's profile shows ₱150 accrued. Changing the rate to 20% does
   **not** alter that job.

### Phase 4 — History, audit & timezone (1 day)
1. `src/services/booking-time.ts` — `todayInTz()`, `monthInTz()`, `dayBounds()`; seed
   `store_timezone = 'Asia/Manila'`.
2. `src/services/booking-history.ts` — manager ledger, rider history, timelines, CSV streaming.
3. Expand `booking_events` (nullable `booking_id`, `entity`, `from_status`, `to_status`,
   `amount_delta`, `visible_to_rider`); write an event for **every** state change and for rider,
   payout and setting changes.
4. `#/manager/history` (filters + CSV + live) and the rewritten `#/rider/history`.
5. Archive/unarchive replaces the hard `DELETE` route; `scripts/purge-bookings.ts` CLI.
6. `scripts/verify-booking-history.ts` — including the 11:30 PM Manila regression guard.
7. ✅ **Exit:** a booking at 11:30 PM Manila time appears under the correct local day; the rider's
   `OWED` matches the manager's view exactly; archiving a booking keeps its ledger.

### Phase 5 — Push + PWA hardening (½ day)
1. `src/services/push.ts` with our own VAPID pair; rider + manager subscribe on first login.
2. `sw.js` push handlers; `manifest.json` + icons; offline shell.
3. Notification routing: tap → the right booking.
4. ✅ **Exit:** with the app backgrounded on a rider's phone, a new job still buzzes.

### Phase 6 — APK (1 day)
1. Capacitor init, point at the live server, adaptive icon, `usesCleartextTraffic=false`.
2. Gradle build → `public/booking/apk/postre-booking.apk`; install page + QR.
3. `app_releases` + the in-app update check.
4. ✅ **Exit:** a rider downloads the APK from Chrome, installs it, logs in, and receives a push.

### Phase 7 — Mobile-first polish & device QA (1 day)
1. Audit every screen against §10.6 on a **360 × 640** viewport: tap targets, safe-area insets,
   thumb reach, no hover-only affordances, one primary action per card.
2. Bottom sheets for assign / transfer / payout; sticky CTAs; the 5-item bottom nav per role.
3. `prefers-color-scheme: dark`; daylight legibility pass; `tabular-nums` on all money.
4. Haptics + chime + the "Live" chip; `prefers-reduced-motion` respected.
5. Android WebView specifics (§10.6.7): back-button routing, status-bar overlay, keyboard resize.
6. Lighthouse mobile run + a real low-end Android device; verify the §10.6.10 budget.
7. ✅ **Exit:** usable one-handed with a rider on a moving motorcycle, on mobile data, in sunlight.

### Phase 7.5 — Live community chat (1 day)
1. `chat_messages` table + the `chat` SSE scope.
2. `src/services/chat.ts` — insert, keyset pagination, `client_msg_id` de-dup, kind/role enforcement,
   @mention resolution, system-message emitter.
3. `src/api/chat.ts` + `chatLimiter` in `server.ts`.
4. `#/manager/chat` and `#/rider/chat` — bubbles, `BOOKING` cards, system lines, `🟢 n online` header,
   `@mention` composer, optimistic send, "↓ n new" pill, unread badge on the nav tab.
5. Push wiring for `BOOKING` cards and mentions only (§6.11.4) + the Settings toggles.
6. `scripts/verify-booking-chat.ts`.
7. ✅ **Exit:** manager posts a booking to chat → it appears on three riders' phones within a second,
   a rider claims from the card, and the manager approves — all without leaving the chat. Chatter does
   **not** push.

### Phase 6 — Polish (optional, ½ day)
1. Paste-free path: a "Send to Dispatch" button in `/admin` that opens `/booking` pre-filled.
2. Rider performance/stats card; manager "today at a glance".
3. Re-open `MENU_RESERVE` in the Messenger bot so customers can also book (currently dead code, §3.3)
   — only if you want customer-facing booking; the dispatch app does not depend on it.

## 14. Testing Strategy

Follows the repo's existing convention: `scripts/verify-*.ts` run with `tsx -r dotenv/config`,
booting the real Express app on a random port, asserting against the **live** database and then
**deleting everything it created**. The repo already does exactly this in
`scripts/verify-reschedule.ts` and `scripts/verify-order-received.ts`.

| Script | Covers |
|---|---|
| `verify-parse.ts` | The real `generateBookingDetails()` paste yields `total=1000`, `delivery_fee=50`; `Total:` / `Total: ₱1,234` / `💰 Total:` / `Grand Total:` all read; `Df ₱50` / `Df:₱50` / `Delivery Fee ₱50` all read; **the last matching line wins**; `₱1,234.50` → `1235` (integer pesos); **no `Total` line → `null`** (never guessed); **no `Df` line → `0`**, not an error; a `Df` with no number is ignored, not `NaN`; `Total: 0` is returned as `0` and then **rejected by the API**; and the whole paste round-trips into `details_text` **byte-for-byte unchanged** |
| `verify-parse.ts` (pin cases) | The `;;;WAZE={…}` trailer decodes and yields the same coordinates as the visible link; `waze://?ll=`, `https://waze.com/ul?ll=`, `google.com/maps/@lat,lng`, `geo:lat,lng` and a bare `lat, lng` **all extract the same pin**; **`0,0` is rejected** (open water); lat > 90 / lng > 180 rejected; NaN/Infinity rejected; a link with no coordinates sets `link_error` and **blocks Create**; `javascript:` and unknown schemes are discarded, never stored; the URL itself is **never** written to any column; **no `Total`/`Df`/pin is ever read out of the item lines or the address text** (proves we are not parsing more than we claim) |
| `verify-nav.ts` | Nav links are re-derived server-side on every read and **never stored**; editing the pin changes the link immediately; a booking with no pin returns `nav: null` and the UI shows the amber "No drop-off pin — read the details" notice instead of a dead button; `details_text` still contains the original link text, but `delivery_lat/lng` is the only machine-readable source |
| `verify-booking-chat.ts` | **Ordering**: messages sent in the same millisecond keep insertion order (asserted by `id`, not `created_at`); keyset pagination returns no duplicates and no gaps while new messages arrive mid-scroll; `?before_id` never uses OFFSET. **Roles**: a rider sending `kind:'BOOKING'` is downgraded to `TEXT`; a rider cannot set `sender_id`/`sender_role`; a rider hitting `POST /api/chat/messages/booking` or `DELETE` gets 403; a deactivated rider gets 403 on every `/api/chat/*` route. **XSS**: `<script>`, `<img onerror>`, `javascript:` and `data:` bodies are stored verbatim and **render escaped** — asserted against `app.js` source, not just the response. **Limits**: 501-char body rejected; the 11th message in 30s is 429. **De-dup**: the same `client_msg_id` retried 3× creates exactly one row. **Unread**: `?after_id` counts correctly; a `BOOKING` card references a live booking and reflects a status change without a new message; a soft-deleted message returns `deleted:true` and no body |
| `verify-booking-auth.ts` | Manager login; rider login; rider→`/api/manager/*` = 403; manager→`/api/rider/*` = 403; wrong-role login endpoint = 403; deactivated rider blocked; cross-rider job read = 404; refresh rotation; old refresh rejected |
| `verify-booking-presence.ts` | Heartbeat writes; dot turns green; stale row goes offline after the TTL; two instances, one closes → still online; sweep fires |
| `verify-booking-flow.ts` | create → request → approve (others auto-rejected) → accept → pickup → deliver; decline reopens; transfer requires a reason and notifies both; cancel; illegal transitions rejected; every transition wrote exactly one event; the assigned rider alone can act |
| `verify-booking-flow.ts` (live groups) | `liveGroupOf()` maps all six statuses correctly and **no other value returns a live group**; `is_ongoing` is true for `ACCEPTED`/`PICKED_UP` and false for the other four; `ASSIGNED` is `CLAIMED`, **not** `ONGOING`; every booking read returns `{live_group, is_ongoing}`; **the client never sets or stores `is_ongoing`** (asserted against the source); `?group=ONGOING` returns exactly the accepted+picked-up set; `GET /rider/home` puts ongoing first; **Open Jobs contains only `PENDING`** — a job another rider has taken never appears in another rider's open list; an ongoing booking always has a non-null `assigned_rider_id`; the SSE `bookings` payload carries `live_group` so a card flips to ongoing without a refetch |
| `verify-booking-history.ts` | Every state change wrote exactly one event with the right `from_status`/`to_status`; manager ledger filters by type/actor/rider/date; CSV matches the on-screen set; **a booking at 11:30 PM Manila time lands in the correct store-local day** (the `admin.ts:80` UTC bug, regression-guarded); month boundaries across a DST-free zone and a leap day; archive hides the booking from boards but keeps events + ledger; unarchive restores it; `visible_to_rider = 0` events are absent from every rider response; **rider `OWED` === manager `OWED` for the same rider, exactly**; a rider cannot read another rider's timeline (404); declined/cancelled jobs appear in rider history with reasons; payout void re-opens `OWED` without deleting the payout |
| `verify-booking-money.ts` | **`computeSplit(1000, 50, 15)` → food 950 / comm 143 / rider 807** (the §3.5 real paste); a **pickup** `computeSplit(1000, 0, 15)` → food 1000 / comm 150 / rider 850; @0%, @20%, @100%; odd amounts (333 total, Df 83 @15% → food 250 → comm 38 / rider 212); **`food_value === total − delivery_fee` and `commission + rider === food_value` on 100 random (total, Df, rate) triples**; `Df > total` rejected; `Df === total` rejected (food value 0); `total = 0` rejected; `Df` required for a delivery booking; **a delivery booking whose paste had no Df blocks Create**; ledger row exists **iff** `DELIVERED`; cancel voids the ledger; decline re-prices at the current rate; **changing the rate does not alter past bookings**; `OWED = EARNED − PAID` after 1, 2 and 3 payouts; period filters sum correctly; cancelled bookings contribute 0; a rider cannot read another rider's earnings (404) |

**Manual QA before release:** two real Android phones on mobile data (not WiFi), one manager +
one rider; airplane-mode test; app-backgrounded push test; APK install on a clean device.

---

| Concern | Control |
|---|---|
| Rider escalation to manager | `requireManager` on every `/api/manager/*` route; the client check is cosmetic only |
| Rider reading another rider's job | Ownership filter in the query → **404**, not 403 (no existence leak) |
| Rider claiming an already-assigned job | `assertTransition` rejects; `UNIQUE(booking_id, rider_id)` blocks duplicate claims |
| Rider acting on a job that is no longer theirs | Every rider mutation re-reads `assigned_rider_id` inside the guarded write; a transfer invalidates the old rider's buttons immediately via SSE |
| Refresh-token theft | 30-day expiry + **rotation on every use** (single-use) + logout deletes the row |
| Deactivated rider with a live JWT | `requireRider` re-reads `riders.is_active` per request (not cached in the token) → blocked within one request |
| Brute force | `loginLimiter` equivalent: 10 attempts / 15 min / IP, mirroring `server.ts` |
| Mass assignment | Explicit field whitelists in the create/update handlers; the client cannot set `status`, `assigned_rider_id` or `created_by` |
| Secrets in logs | Never log `PAGE_ACCESS_TOKEN`, `SUPABASE_SERVICE_KEY`, `VAPID_PRIVATE_KEY`, `JWT_SECRET`, `APP_SECRET`, or refresh tokens. Booking logs carry ids, refs and actor names only |
| SQL injection | Supabase query builder / parameterised `$1` helpers only — same rule as the rest of the repo |
| APK tampering | Sideloaded APKs cannot be auto-updated across a changed signing key → document keeping the keystore safe (§17 R7) |
| Customer PII | Bookings contain names/phones/addresses. Riders see only jobs assigned or open for claiming; the open-job list deliberately **hides the customer's full address until the job is assigned** (a rider has no reason to see an address they may not get) |

---

- App shell cached (PWA) so the APK opens instantly and shows the last-known board.
- Any mutation attempted while offline shows a clear **"You're offline — this will not send"**
  toast. **We do not queue booking mutations** — a silently-queued assignment is a dispatch hazard.
  Reads are served from cache and flagged stale.

---

---

> whitelisted-domain requirement does **not** apply. Nothing in the Meta developer console changes.

---

The manager's **first login is forced through a password-change screen** until they set their own
password (tracked by `bk_users.password_reset_required`). This keeps the manager from holding riders'
long-term passwords.

Also provided: `PUT /riders/:id` (profile/branch), `POST /riders/:id/reset-password` (returns a temp
password once), `POST /riders/:id/toggle-active` (soft disable — blocks login immediately, preserves
booking history), and `GET /riders/:id/stats` (assigned / accepted / delivered / declined).

---
launch; the paste path is the primary flow as specified.

---

## 15. Deployment

A **new Render service**, built from **our own Dockerfile**. The Messenger-bot service is not touched,
not redeployed, and not even queried.

### 15.1 First deploy (one time)

1. `git init` in `C:\Users\Mizeri Jiwu\Desktop\sofiapostrebooking`; commit.
2. **Review `migrations/001_bk_init.sql` line by line, then paste it into the Supabase SQL Editor**
   and run it once. It creates only `bk_*` objects (§5.4).
3. `npm run gen:vapid` → generates **our own** `BK_VAPID_PUBLIC_KEY` / `BK_VAPID_PRIVATE_KEY`.
   (Do **not** reuse Messenger-bot's keys — a shared VAPID pair means both apps' subscriptions are
   visible to each other's server.)
4. Create the Render service from this repo (Docker runtime, health check `/health`).
5. Set env vars (Appendix A). `BK_JWT_SECRET` must be 32+ random characters — generate, do not invent.
6. Deploy. First boot seeds the manager from `BK_ADMIN_USERNAME` / `BK_ADMIN_PASSWORD` and logs a
   loud warning — **change that password immediately in the app.**
7. Smoke test: `/health` → `ok: true`; `/api/config` → `401` without a token (correct); log in as the
   manager, register a rider, log in as the rider on a second device.
8. Commit the built APK to `public/apk/` so the download route serves it (Phase 6).

### 15.2 Routine deploys

Push to `main` → Render rebuilds. Because the schema is additive and idempotent, a redeploy never
needs a migration. `migrate.ts` self-heals a fresh database and logs a warning (never a crash-loop)
if it cannot connect.

### 15.3 Verifying the boundary held

After **every** deploy, confirm the Messenger-bot is untouched:

```
# 1. our migration must reference bk_* objects only
npm run verify:boundary

# 2. no non-bk_ table gained rows we wrote (should be unchanged counts)
#    run the Messenger-bot /admin dashboard: it must look exactly as before
```

**Rollback:** revert the commit, or roll the Render deploy back. Our `bk_*` tables can be left in
place harmlessly — nothing in Messenger-bot references them. Rolling back this app has **zero**
effect on the Messenger-bot, which is the entire point of the boundary.

---

---

## 16. Success Criteria

- [ ] Manager and rider log in through **separate screens**; neither can reach the other's surface.
- [ ] Manager pastes a real copied Messenger message → a parsed, editable booking appears on the
      dashboard **without retyping** name/phone/address/date/time/total/items.
- [ ] The new booking appears on **every** connected manager device and pings online riders — live.
- [ ] A rider can request a booking; the manager sees the request instantly and can approve/reject.
- [ ] On approval **only** the approved rider is assigned; other claimants are auto-rejected and told.
- [ ] The manager can assign any booking to any **online** rider (green dot) in one tap.
- [ ] The manager can transfer/swap with a required reason; both riders are notified; the history
      shows both assignments.
- [ ] The green dot is accurate: green within ~20s of opening, grey within ~90s of closing, correct
      across two devices.
- [ ] **A booking shows a clear live state on every screen**: 🟡 Open (nobody has it) · 🔵 Claimed
      (offered, not yet accepted) · 🟠 **Ongoing (a rider has taken it and is working it)** · ⚪ Closed.
- [ ] **Ongoing begins the moment the rider accepts**, and ends on delivery or cancellation — never
      before, never after.
- [ ] **The manager dashboard shows live counters** `Open · n` / `Ongoing · n` / `Done today · n`, and
      ongoing cards carry a pulsing dot + the rider's name.
- [ ] **A rider's Open Jobs tab only ever shows `PENDING` jobs** — a job another rider has taken is
      never visible, so two riders can never race for the same delivery.
- [ ] **A card flips to Ongoing live** on every connected device via SSE, without a manual refresh.
- [ ] **An ongoing job whose rider goes offline is flagged `⚠ Ongoing · rider offline`** and is *not*
      silently reopened — the manager nudges, transfers, or cancels.
- [ ] A rider can accept → pick up → deliver; the manager's board updates live at each step.
- [ ] A rider cannot read or act on a job that is not theirs.
- [ ] **Only two numbers feed the money** — the booking `total` and the delivery fee (`Df`), both
      parsed from the paste or typed by the manager. Everything else on the booking is context and
      never enters a calculation.
- [ ] **`food_value === total − delivery_fee`**, and the 15% is charged on that base. A real paste of
      `Total:₱1,000` / `Df ₱50` yields **₱143 manager / ₱807 rider**; a pickup (`Df 0`) yields
      **₱150 / ₱850**.
- [ ] **A delivery booking with no `Df` in the paste blocks Create** rather than silently
      commissioning the delivery fee as food. `Df > total` and `Df === total` are rejected too.
- [ ] **Commission is computed once, server-side**, and `commission + rider payout === food_value`
      always holds — the split can never lose or gain a peso to rounding.
- [ ] **Changing the commission rate affects only new bookings** — past earnings never change.
- [ ] **The rider profile shows** jobs, booking value, rider earnings, manager commission, the OWED
      banner, a period-filtered per-booking money table, payout history and performance stats.
- [ ] **EARNED, PAID and OWED are three distinct, correct numbers** after any sequence of deliveries
      and payouts.
- [ ] **The manager profile shows their own commission** (week / month / all-time, per-rider breakdown).
- [ ] The **manager settings page** controls commission, money display, dispatch rules, presence,
      privacy, notifications, branches, app updates and the danger zone — all applied without a redeploy.
- [ ] **Every state change is written to the audit ledger** with actor, from/to status and a timestamp.
- [ ] **The manager history** is filterable by type / actor / rider / date, searchable, exportable to CSV,
      and updates live.
- [ ] **The rider history** shows delivered, picked-up, **declined and cancelled** jobs with reasons,
      plus `EARNED / PAID / OWED` — and reconciles **exactly** with the manager's view.
- [ ] **A booking at 11:30 PM Manila time appears under the correct local day** — the UTC bug is not
      inherited.
- [ ] **Archiving a booking removes it from the boards but keeps its events and commission ledger**;
      there is no API route that hard-deletes a booking.
- [ ] **A Waze/Google-Maps link in the pasted text is parsed into a pin**, the navigation lines are
      stripped from the address, and both nav links are re-derived server-side on every read — a stale
      link can never be stored.
- [ ] **A link with no usable coordinates blocks Create** with a visible warning, rather than silently
      creating a delivery nobody can navigate to.
- [ ] **Tapping 🗺️ Navigate hands off to Waze**, falls back to the browser universal link if Waze does
      not open, and always offers Google Maps as a second option. A booking with no pin shows
      "No drop-off pin — call the customer" instead of a button that does nothing.
- [ ] **Editing the pin changes the rider's navigation link immediately** (SSE), with `PIN_CHANGED` in
      the audit trail.
- [ ] **The app is usable one-handed at 360 × 640**, outdoors in sunlight, on mobile data: 48dp
      targets, no hover-only affordances, bottom-sheet actions, `tabular-nums` money, and status
      readable by glyph + word (never colour alone).
- [ ] Every state change gives **visual + haptic + audible** feedback, and a "Live" chip shows whether
      the connection is current.
- [ ] **The manager and every online rider share one live chat**, and a message posted on one phone
      appears on all the others within a second over SSE.
- [ ] **A `BOOKING` card posted in chat is claimable from the card itself** — request → approve without
      leaving the conversation — and it always reflects the **live** booking status, never a stale copy.
- [ ] **Plain chatter is never pushed**; only booking cards and `@mention`s are. A rider's phone does
      not buzz for conversation.
- [ ] **Message bodies are escaped and rendered as text**, never as HTML — asserted against the source,
      so a `<script>` or `javascript:` URL from a rider cannot execute on another rider's phone.
- [ ] **A rider cannot post as the manager**, cannot send a `BOOKING` card, cannot edit or delete another
      message, and is locked out of the room the moment they are deactivated.
- [ ] **Chat order is stable** and pagination never duplicates or drops a message while new ones arrive.
- [ ] The app installs from a browser as an APK and behaves identically to the browser PWA.
- [ ] The Messenger bot, `/admin` and `/webview` are **provably unaffected** (all existing verify
      scripts still pass; `/health` unchanged).

---

## 17. Risks & Mitigations

| # | Risk | Severity | Mitigation |
|---|---|---|---|
| R1 | **Paste format drift** — the manager copies a different shape than expected | Low | We parse only two numbers and a coordinate, each with a tolerant line matcher. Everything else is stored verbatim in `details_text` and read by the rider as-is, so **there is nothing left to mis-parse**. A missing `Total` asks the manager to type it; nothing is guessed |
| R2 | **Double-assignment** under concurrent approvals | High | Every transition goes through `assertTransition()`, which re-reads the row and compares the expected current status; a stale write returns **409**, never a silent overwrite |
| R3 | **SSE through Render's proxy** dropping connections | Medium | 20s heartbeat (the pattern `admin-events.ts` already proves in production), client auto-reconnect with backoff, visible "Live" chip, Web Push as fallback |
| R4 | Refresh token in `localStorage` | Medium | Acceptable for a managed WebView on the rider's own device; can be hardened later via a Capacitor plugin or HttpOnly cookies |
| R5 | Presence shows stale green dots | Medium | Server-authoritative TTL (60s) + a 30s sweep that broadcasts **only on change**; never trust a client-sent "I'm offline" |
| R6 | Phone loses signal mid-dispatch | Medium | Mutations are never queued (a silent queued assignment is a dispatch hazard); the UI says "You're offline — this will not send" and the cached board is flagged stale |
| R7 | APK signing key lost | Medium | Generate and back up the keystore on day one of Phase 5; Android refuses updates signed with a different key |
| R8 | Riders share one login | Low | First-login forced password change; per-rider `booking_sessions`; instant deactivation |
| R9 | Migration applied only in `postgres.ts` and not in Supabase (the v13/v14 trap the repo documents) | Medium | v15 ships as a standalone `.sql` for the SQL Editor **and** mirrored in code, with the same explanatory header |
| R10 | Booking surface bloats the single server | Low | The surface is small; if it ever matters, the router + SSE hub separate cleanly with no data-model change |
| R11 | **Floating-point money.** 15% of ₱950 is ₱142.50; naive float maths yields 142.499999 and a ledger that never reconciles | High | `commission_rate` is `NUMERIC(5,2)`, all amounts are **integer pesos**, and every calculation goes through the single `Math.round()` in `computeSplit()`. The invariants `food_value === total − delivery_fee` and `commission + rider === food_value` are asserted across 100 random `(total, Df, rate)` triples in `verify-booking-money.ts` |
| R11b | **`Df` missing or wrong in the paste.** A booking pasted without a `Df` line would treat the whole total as food value, and a `Df` larger than the total produces a negative food value | High | A missing `Df` is a legitimate **pickup** and defaults to `0` — it is never guessed. The API rejects `Df < 0`, `Df > total` and `Df === total` (zero food value), and the preview shows the food value before Create so a wrong `Df` is visible immediately |
| R12 | **Commission rate changed later silently rewriting past earnings** | High | The rate is **snapshotted per booking** at creation; no `POST /reprice` endpoint exists; the Settings page states "applies to new bookings only" |
| R13 | **Ledger drift** — a booking shows `DELIVERED` but no commission row, or a payout is recorded twice | High | Status + ledger + payout writes share one transaction; a unique index on `commission_ledger.booking_id` makes a duplicate impossible; `OWED = EARNED − PAID` is recomputed from the ledgers on every read, never stored |
| R14 | A booking is created with **no total** (the paste had no `Total:` line) | Medium | `extractTotal()` returns `null` rather than guessing; the preview shows an empty Total field and the manager types it. The API independently rejects `total ≤ 0`, so even a bug in the matcher cannot create a ₱0 booking that would produce ₱0 commission and corrupt every downstream total |
| R15 | Riders dispute their earnings | Medium | Every peso traces to a booking row with a snapshotted rate, a `booking_events` timeline, and a payout record; CSV export gives them the same figures the manager sees |
| R16 | **Timezone.** We share a Supabase project whose existing tables store `TEXT` timestamps from `now()::text` (DB server TZ) and derive "today" with `toISOString()` (UTC) at `admin.ts:80`. We must not inherit that | High | Our own `bk_*` tables store **`TIMESTAMPTZ`** (not `TEXT`) with a `store_timezone` setting (default `Asia/Manila`); one `src/lib/datetime.ts` owns every day/month boundary; day bucketing uses `AT TIME ZONE 'Asia/Manila'` in SQL, never UTC arithmetic. A regression test pins an 11:30 PM booking to the correct local day. The Messenger-bot bug is **not** fixed here (forbidden, §0) and is unaffected by our change |
| R17 | **History destroyed by a delete.** `admin.ts` `DELETE /orders/:id` deletes `order_status_history`, and `purge-order-data.ts` truncates it — fine for test data, fatal for a money ledger | High | Bookings are **archived, never hard-deleted**; the manager's "delete" sets `archived_at`. Hard purge is CLI-only, refuses to run while any `DELIVERED` booking exists without `--force`, and **excludes `commission_ledger` and `rider_payouts` entirely** |
| R18 | **Mobile data / battery.** Riders are on 4G, often outdoors, with the app open all day | Medium | One `GET /rider/home` payload, 25-row pagination, no photos on list screens, lazy images with explicit dimensions, SSE instead of polling, and the §10.6.9 performance budget verified on a real low-end device |
| R19 | **Unusable one-handed / in sunlight** — the real failure mode of a dispatch tool | Medium | 48dp targets, bottom-third action zone, bottom sheets, no hover-only affordances, WCAG AA contrast, `tabular-nums` money, glyph+word status (never colour alone), dark mode, and three-channel feedback (visual + haptic + audible) |
| R20 | **Stale or unparseable Waze link → rider drives to the wrong house.** This already happened once: v13 exists because the nav link used to be frozen in `orders.address`, so an admin address edit left the rider navigating to the old pin (`admin/app.js:646-656`) | High | The link is treated as a **coordinate carrier only**. Coordinates are validated (finite, in range, `0,0` rejected) and stored on the booking; both nav links are **re-derived at read time** with `buildWazeAppUrl()`/`buildWazeUrl()`; navigation lines are stripped from the address; a link with no usable coordinates **blocks Create** rather than silently producing a text-only delivery |
| R21 | **`waze://` silently fails inside a WebView** — the custom scheme is blocked in many in-app browsers, and as pasted plain text it is not clickable anywhere | Medium | Reuse the proven `openWaze()` algorithm (`admin/app.js:2062-2074`): try `waze://`, detect non-handoff after 1.2s, fall back to the `https://waze.com/ul?...` universal link. The APK additionally uses Capacitor's `AppLauncher` for a real open/close signal, and **Google Maps is always offered as a second button** so a rider without Waze is never stranded |
| R22 | **Chat notification fatigue.** Pushing every message to 15 riders = 40 buzzes/hour, which trains riders to ignore notifications — and then a genuine "BK-1042 open" push is ignored too, silently breaking dispatch | High | **Plain chatter is never pushed.** Riders are pushed only for `BOOKING` cards and `@mention`s naming them; the manager is pushed for cards, mentions and `SYSTEM` events. Everything else arrives over SSE with an unread badge. A per-user "never push chat" switch is the final escape hatch |
| R23 | **Chat XSS.** Message bodies are user-generated and rendered on every rider's device — one `<img onerror=…>` from a rider compromises every phone in the fleet | High | Bodies render through the existing `esc()` and the client builds **text nodes, never HTML**; links are never auto-linked, so `javascript:`/`data:` URLs are inert. Asserted against the **source file** in `verify-booking-chat.ts`, so a future refactor that reintroduces `innerHTML` fails the build |
| R24 | **Chat spam / one rider flooding the room**, burying the `BOOKING` cards that matter | Medium | `chatLimiter` (10 / 30 s per user, 200 / 15 min per IP) + a 500-char cap; `BOOKING` cards render pinned above the chatter, and a rider can only create — never edit or delete — messages |
| R25 | **Chat grows unbounded** on a long-lived database, slowing first paint | Low | Keyset pagination (never OFFSET) + 50-message pages; the manager-only export covers the rare need for the full transcript. Archiving rides on the same `booking_events` policy |

---

## 18. Open Questions for You

1. **Is a booking always bound to a date/time slot, or "as soon as possible"?** The parser handles
   both; the plan reuses `time_slots` when a date is present. Confirm.
2. **Can one rider hold more than one job at once?** Default is 1 (`ASSIGNED` + `PICKED_UP`),
   configurable in Settings.
3. **Should Approve auto-assign, or should the manager still confirm the assignment separately?**
   The plan auto-assigns on Approve (fewer taps).
4. **Should the customer be notified in Messenger on assign / pick up / deliver?** Not included
   (riders are internal staff). Easy to add later via `sendText(psid, …)`, but it would need a PSID
   on the booking, which a pasted booking does not have.
5. **Branch handling** — pin each booking to `naga` / `calbayog`? Restrict riders to their own
   branch? The plan records both but does not yet enforce a match.
6. **Rider earnings / COD collection** — out of scope for the app. Confirm riders do not collect
   payment from customers (the plan assumes the shop handles all payment; `rider_payout` is an
   internal figure, not cash handed to the rider at the door).
7. **APK signing** — debug key (fast, fine for sideloading) or a proper release keystore (needed for
   painless long-term updates)?
8. **✅ RESOLVED — the commission base is the FOOD value (`total − Df`), not the gross total.**
   The delivery fee is a pass-through transport charge, not a food sale, so 15% is taken on what the
   shop actually earned for the food. Worked example and rationale in §6.6.1. If you later decide the
   gross is correct, it is a one-line change in `computeSplit()` (pass `total` instead of
   `foodValue`) plus a new migration for the `basis_food` column name.
9. **Should commission accrue on delivery only, or on assignment?** The plan accrues on **delivery**
   (§6.6.2) so a rider who never delivers earns nothing. Confirm — accruing on assignment is simpler
   but pays for jobs that fall through.
10. **Are payouts tracked per-rider as cash/GCash, or does the rider settle up with the shop at
    payday?** The plan has a `rider_payouts` ledger with a method and reference, which covers both.

---

---

