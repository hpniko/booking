# Deploying to Render

The app is a single Node service: Express + TypeScript compiled to `dist/`, with
the SPA copied to `dist/public`. The only moving parts are the Postgres
connection and a handful of secrets.

`render.yaml` is a [Render Blueprint](https://render.com/docs/blueprint-spec), so
the whole service is defined in version control.

---

## One-time setup

**1. Push the repo to GitHub** (Render builds from git):

```powershell
git remote add origin https://github.com/<you>/sofiapostrebooking.git
git push -u origin main
```

**2. Create the Blueprint** — Render Dashboard → **New → Blueprint** → select the
repo. Render reads `render.yaml` and pre-fills everything.

**3. Fill in the six secrets.** They are `sync: false`, so Render prompts and
never stores them in git:

| Variable | Value |
|---|---|
| `DATABASE_URL` | your existing Postgres connection string (Supabase pooler) |
| `BK_JWT_SECRET` | `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"` |
| `BK_ADMIN_USERNAME` | e.g. `manager` |
| `BK_ADMIN_PASSWORD` | a strong first password |
| `BK_VAPID_PUBLIC_KEY` / `BK_VAPID_PRIVATE_KEY` | from `npm run gen:vapid` |
| `BK_VAPID_SUBJECT` | `mailto:you@yourdomain.com` |

Push notifications are off by default on public repos — enable them in
**Settings → Notify → Deploys**, or use **Manual Deploy**.

**4. First boot** runs the migration automatically. It is idempotent and
`bk_*`-only, and it seeds the first manager from the env vars **once**. Verify:

```powershell
Invoke-RestMethod https://<your-app>.onrender.com/health
```

Look for `[migrate] bk_* schema up to date` and `"ok":true` in the logs.

**5. Sign in and change the admin password**, then add riders under
**More → Riders**.

---

## Why `starter` and not the free tier

The free tier **spins down after 15 minutes of inactivity**. This app holds
long-lived SSE connections open all day — one per phone. Spin-down severs all of
them, riders stop receiving new jobs, and every phone then reconnects at once and
re-reads state, which hammers Postgres.

The client recovers correctly (on reconnect it re-reads the board rather than
trusting the gap), but "recovers correctly" is not good enough for a live
dispatch tool. `starter` is a small paid instance that stays awake.

---

## Things worth knowing

- **First deploy is slow** (npm install + tsc). Subsequent deploys are quicker.
- **Every deploy restarts the process**, dropping all SSE clients. Riders
  reconnect automatically and re-read state — brief, no lost updates.
- **The service sleeps between deploys**; the first request after an idle period
  can take ~30s. Do first-deploy checks against `/health`, not the UI.
- **Region**: the blueprint pins `singapore` to stay near Manila. Change it in
  `render.yaml` if you deploy elsewhere.
- **`PORT` is injected by Render** — never set it as an env var.
- **Settings are not env vars.** Commission rate, timezone, cutoff hour and
  concurrency live in `bk_settings` and are edited in-app under **Settings**.
- **Push** needs a real VAPID subject and HTTPS. Without the keys the app runs
  fine, it just logs push as unconfigured.
- **Custom domain**: add it under Settings, then update the PWA `start_url` if
  you move off the `onrender.com` host.

---

## Rolling back

Render keeps the previous build — **Deploys → pick a build → Rollback**. Because
the migration is additive and idempotent, rolling back the code is safe; the
schema simply keeps any columns a newer build added.

---

## Deploying a change

```powershell
npm run typecheck
npm run verify:boundary
git add -A && git commit -m "..." && git push
```

Push triggers a build. Watch it under Deploys.