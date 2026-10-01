# Deploying to Render

The app is a single Node service: Express + TypeScript compiled to `dist/`, with
the SPA copied to `dist/public`. The only moving parts are the Postgres
connection and a handful of secrets.

`render.yaml` is a [Render Blueprint](https://render.com/docs/blueprint-spec), so
the whole service is defined in version control.

There are **two ways** to get the image onto Render:

| | Path A — Render builds it | Path B — Docker Hub |
|---|---|---|
| Setup | Blueprint from the repo | Push image, then **New → Image** |
| Builds on | Render's machines | your machine |
| Version bumps | automatic on every push | manual: rebuild, retag, push |
| Needs | `render.yaml` only | Docker Desktop + a Docker Hub repo |

Pick **A** for `git push → deployed`. Pick **B** to deploy the exact image you
tested locally.

---

## Path A — Render builds from the repo

### Setup

**1. Push the repo to GitHub** (the repo is already connected as `origin`):

```powershell
git push
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

## Path B — Docker Hub

The image is safe to publish **publicly**: `.dockerignore` excludes `.env`, and
every secret is supplied at runtime as an env var, so nothing sensitive is baked
into a layer. (Verified: no runtime secret value appears anywhere in `dist/`.)

**1. Create a public repository** on <https://hub.docker.com> — e.g. `booking`,
under your Docker Hub namespace.

**2. Start Docker Desktop.** `docker` commands fail with a named-pipe error
until the daemon is running; the CLI being on PATH is not enough. Check with:

```powershell
docker info
```

**3. Build and test locally first** — worth doing before Render, so any failure
shows up on your machine instead of in Render's build log:

```powershell
npm run docker:build
npm run docker:run     # → http://localhost:3100
```

**4. Tag and push. Always use an immutable tag — see the warning below:**

```powershell
docker tag postre-booking:latest <DOCKERHUB_USERNAME>/booking:v1.0.0
docker push <DOCKERHUB_USERNAME>/booking:v1.0.0
```

Use a Docker Hub **access token** as the password, not your account password.

> ⚠️ **Do not deploy `latest`.** Render caches public images, and pulling a
> mutable tag can hand you a *stale* build — you deploy, change nothing, and get
> an older image. Render's docs are explicit: use an immutable tag like
> `v1.0.0`, or attach a registry credential. Version your tags and redeploy by
> changing the tag in the service's settings.

**5. Deploy on Render** — these are the exact Dashboard fields:

1. Dashboard → **+ New** → **Web Service**
2. Under **Source Code**, click **Existing Image**
3. **Image URL**: `<DOCKERHUB_USERNAME>/booking:v1.0.0`
   (a public image needs **no credentials**)
4. Click **Connect** once Render verifies it can read the image
5. Set **Name**, **Region** (pick Singapore — nearest to Manila) and
   **Instance Type** → **Starter**, *not* Free
6. Add the six env vars from Path A step 3 **before** deploying — the first boot
   seeds the manager from them, so a deploy without them starts with no admin
7. **Deploy**

Leave **Docker Command** empty — the image's `CMD` is correct.

**6. When you push a new version**, edit the tag in the service's
**Settings → Deploy**, then hit **Manual Deploy**.

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