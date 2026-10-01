/**
 * src/routes/config.ts — shared config, day endpoints, presence, push, release (§9.2, §9.8, §9.9).
 */
import { Router } from 'express';
import { requireAuth, requireManager, requireRider } from '../services/auth';
import { q, q1 } from '../db/pg';
import { allSettings, currentRate } from '../services/settings';
import { dayTotals, openDay, closeDay, reopenDay, ensureOpenDay, todayRef } from '../services/day';
import { heartbeat, goOffline, riderRoster } from '../services/presence';
import { subscribe, unsubscribe, vapidKeys, pushConfigured } from '../services/push';
import { emit } from '../services/events';
import { handle } from './bookings';

export const sharedRouter = Router();   // /api/* (auth)
export const managerMiscRouter = Router(); // /api/manager/*
export const riderMiscRouter = Router();   // /api/rider/*

sharedRouter.use(requireAuth);

// ── config (§9.9) ─────────────────────────────────────────────────────────────
sharedRouter.get('/config', async (_req, res) => {
  try {
    const all = await allSettings();
    const cutoff = Number(all.day_cutoff_hour ?? 4);
    const tz = all.store_timezone ?? 'Asia/Manila';
    res.json({
      store_label: all.store_label ?? 'Postre',
      store_timezone: tz,
      currency: all.booking_currency_symbol ?? '₱',
      commission_rate: await currentRate(),
      show_rider_earnings: (all.booking_show_rider_earnings ?? '1') === '1',
      max_concurrent: Number(all.booking_max_concurrent ?? 1),
      presence_ttl_s: Number(all.booking_presence_ttl_s ?? 60),
      heartbeat_ms: Number(all.booking_heartbeat_ms ?? 20000),
      version: '1.0.0',
      vapid_public_key: vapidKeys().publicKey,
      push_enabled: pushConfigured(),
      settings: all,
      // "Right now, today means X" — the live guard against the UTC day-boundary
      // bug. Computed by the SERVER in the store's timezone (§R16); the client
      // never derives it from its own clock.
      today_ref: await todayRef(),
      cutoff_hour: Number.isFinite(cutoff) ? cutoff : 4,
      day_preview: `${tz} · before ${cutoff}:00 a booking belongs to yesterday's dispatch day`,
    });
  } catch (err: any) { handle(err, res); }
});

sharedRouter.get('/release', async (_req, res) => {
  try {
    const row = await q1(`SELECT * FROM bk_app_releases WHERE is_current = 1 ORDER BY build_no DESC LIMIT 1`);
    res.json(row ?? null);
  } catch (err: any) { handle(err, res); }
});

sharedRouter.get('/day/current', async (_req, res) => {
  try {
    const day = await ensureOpenDay();
    const totals = await dayTotals(day.id);
    res.json({ ...day, totals });
  } catch (err: any) { handle(err, res); }
});

// ── SSE (§9.2) — token via query because EventSource cannot set headers ───────
sharedRouter.get('/events', async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();
  const u = req.user!;
  res.write(`event: hello\ndata: ${JSON.stringify({ role: u.role, user_id: u.id, rider_id: u.rider_id ?? null })}\n\n`);

  const { addListener } = await import('../services/events');
  const drop = addListener({
    res,
    audience: u.role === 'MANAGER' ? 'MANAGER' : 'RIDER',
    riderId: u.rider_id ?? undefined,
    userId: u.id,
  });
  const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch { /* closed */ } }, 20_000);
  const cleanup = () => { clearInterval(ping); drop(); };
  req.on('close', cleanup);
  res.on('close', cleanup);
  res.on('error', cleanup);
});

// ── presence heartbeat (§9.2) ─────────────────────────────────────────────────
sharedRouter.post('/heartbeat', requireRider, async (req, res) => {
  try {
    const riderId = req.user!.rider_id!;
    const instanceId = String(req.body?.instance_id || 'default');
    await heartbeat(riderId, instanceId, req.body?.platform, req.body?.app_version);
    emit('presence', { rider_id: riderId, online: true });
    res.json({ ok: true });
  } catch (err: any) { handle(err, res); }
});

sharedRouter.post('/heartbeat/offline', requireRider, async (req, res) => {
  try {
    const riderId = req.user!.rider_id!;
    const instanceId = String(req.body?.instance_id || 'default');
    await goOffline(riderId, instanceId);
    emit('presence', { rider_id: riderId, online: false });
    res.json({ ok: true });
  } catch (err: any) { handle(err, res); }
});

sharedRouter.post('/push/subscribe', async (req, res) => {
  try {
    const { endpoint, keys } = req.body ?? {};
    if (!endpoint || !keys?.p256dh || !keys?.auth) {
      res.status(400).json({ error: 'endpoint and keys required' }); return;
    }
    const u = req.user!;
    await subscribe(
      u.role === 'MANAGER' ? 'MANAGER' : 'RIDER',
      String(endpoint),
      { p256dh: String(keys.p256dh), auth: String(keys.auth) },
      { userId: u.id, riderId: u.rider_id ?? undefined, userAgent: String(req.headers['user-agent'] ?? '') },
    );
    res.json({ ok: true });
  } catch (err: any) { handle(err, res); }
});

sharedRouter.post('/push/unsubscribe', async (req, res) => {
  try {
    await unsubscribe(String(req.body?.endpoint ?? ''));
    res.json({ ok: true });
  } catch (err: any) { handle(err, res); }
});

sharedRouter.get('/sessions', async (req, res) => {
  try {
    const rows = await q(
      `SELECT id, expires_at, created_at FROM bk_booking_sessions
       WHERE user_id = $1 ORDER BY created_at DESC`,
      [req.user!.id],
    );
    res.json(rows);
  } catch (err: any) { handle(err, res); }
});

sharedRouter.post('/sessions/revoke-all', async (req, res) => {
  try {
    await q('DELETE FROM bk_booking_sessions WHERE user_id = $1 AND refresh_token IS DISTINCT FROM $2',
      [req.user!.id, String(req.body?.keep_refresh ?? '')]);
    res.json({ ok: true });
  } catch (err: any) { handle(err, res); }
});

// ── manager: dispatch days (§9.8) + presence roster ───────────────────────────
managerMiscRouter.use(requireAuth, requireManager);

managerMiscRouter.get('/days', async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 30, 365);
    const rows = await q(
      `SELECT * FROM bk_dispatch_days ORDER BY date_ref DESC LIMIT $1`, [limit],
    );
    res.json(rows); // past days carry their FROZEN totals_snapshot
  } catch (err: any) { handle(err, res); }
});

managerMiscRouter.get('/days/:id', async (req, res) => {
  try {
    const day = await q1('SELECT * FROM bk_dispatch_days WHERE id = $1', [Number(req.params.id)]);
    if (!day) { res.status(404).json({ error: 'Day not found' }); return; }
    const totals = await dayTotals(day.id);
    const bookings = await q(
      `SELECT b.*, r.full_name AS rider_name FROM bk_bookings b
       LEFT JOIN bk_riders r ON r.id = b.assigned_rider_id
       WHERE b.day_id = $1 ORDER BY b.created_at DESC LIMIT 500`,
      [day.id],
    );
    res.json({ ...day, totals, bookings });
  } catch (err: any) { handle(err, res); }
});

managerMiscRouter.post('/days/open', async (req, res) => {
  try { res.status(201).json(await openDay(req.body?.date_ref, req.user!.id)); }
  catch (err: any) { handle(err, res); }
});

managerMiscRouter.post('/days/:id/close', async (req, res) => {
  try {
    const day = await closeDay(Number(req.params.id), req.user!.id, { confirm: req.body?.confirm });
    res.json(day);
  } catch (err: any) { handle(err, res); }
});

managerMiscRouter.post('/days/:id/reopen', async (req, res) => {
  try { res.json(await reopenDay(Number(req.params.id), req.user!.id)); }
  catch (err: any) { handle(err, res); }
});

managerMiscRouter.get('/presence', async (_req, res) => {
  try {
    const roster = await riderRoster();
    res.json(roster.map((r: any) => ({
      rider_id: r.id, full_name: r.full_name, online: r.online,
      last_seen_at: r.online ? new Date().toISOString() : null, jobs: Number(r.active_jobs),
    })));
  } catch (err: any) { handle(err, res); }
});

// ── rider misc ────────────────────────────────────────────────────────────────
riderMiscRouter.use(requireAuth, requireRider);

riderMiscRouter.get('/presence', async (_req, res) => {
  try { res.json(await riderRoster()); } catch (err: any) { handle(err, res); }
});

