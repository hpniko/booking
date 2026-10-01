/**
 * src/routes/bookings.ts — manager + rider booking endpoints (§9.3, §9.4).
 * The client-side role check is cosmetic — these guards are the boundary (§7.3).
 */
import { Router, Request, Response } from 'express';
import { requireAuth, requireManager, requireRider } from '../services/auth';
import { parsePaste } from '../services/parse';
import { validateMoney, computeSplit } from '../lib/money';
import { currentRate, getBool, getNumber } from '../services/settings';
import {
  createBooking, transition, getBooking, listBookings, managerDashboard, riderHome,
  requestBooking, withdrawRequest, approveRequest, rejectRequest, pendingRequests,
  editBooking, addNote, archiveBooking, unarchiveBooking, TransitionError, Actor,
} from '../services/bookings';
import { timeline } from '../services/history';
import { q, q1 } from '../db/pg';
import { pushNewJob, pushManager, pushRiders } from '../services/push';

export const managerBookingsRouter = Router();
export const riderBookingsRouter = Router();

managerBookingsRouter.use(requireAuth, requireManager);
riderBookingsRouter.use(requireAuth, requireRider);

/** Express error bridge — services throw { status } or plain Errors. */
export function handle(err: any, res: Response): void {
  const status = err.status || (err instanceof TransitionError ? err.status : 500);
  if (status >= 500) console.error('[api]', err);
  res.status(status).json({ error: err.message || 'Server error' });
}

function actorOf(req: Request): Actor {
  const u = req.user!;
  return { id: u.id, role: u.role, name: u.full_name, riderId: u.rider_id ?? null };
}

// ── parse preview — READ-ONLY, never writes (§9.3) ────────────────────────────
managerBookingsRouter.post('/bookings/parse', async (req, res) => {
  try {
    const raw = String(req.body?.raw ?? '');
    if (!raw.trim()) { res.status(400).json({ error: 'Paste some booking text first' }); return; }
    const parsed = parsePaste(raw);
    const rate = await currentRate();
    const split = parsed.total != null ? computeSplit(parsed.total, parsed.delivery_fee, rate) : null;
    res.json({
      ...parsed,
      rate,
      split,
      // Create is blocked when a nav link existed but gave no coordinates (§6.5.4)
      can_create: !parsed.link_error && validateMoney(parsed.total, parsed.has_df_line ? parsed.delivery_fee : null) === null,
      money_error: validateMoney(parsed.total, parsed.has_df_line ? parsed.delivery_fee : null),
    });
  } catch (err: any) { handle(err, res); }
});

managerBookingsRouter.post('/bookings', async (req, res) => {
  try {
    const b = req.body ?? {};
    const raw = String(b.raw_text ?? b.details_text ?? '');
    const parsed = raw ? parsePaste(raw) : null;

    const total = b.total != null ? Math.round(Number(b.total)) : parsed?.total ?? null;
    const df = b.delivery_fee != null ? Math.round(Number(b.delivery_fee))
      : parsed?.has_df_line ? parsed!.delivery_fee : 0;

    // link present but unreadable → block Create (§6.5.4)
    if (parsed?.link_error && b.allow_text_only !== true) {
      res.status(400).json({ error: 'Found a Waze link but no usable coordinates — fix the pin or confirm text-only' });
      return;
    }
    const moneyErr = validateMoney(total, df);
    if (moneyErr) { res.status(400).json({ error: moneyErr }); return; }
    // a delivery booking whose paste had no Df blocks Create (success criteria)
    if (parsed && !parsed.has_df_line && !b.is_pickup && b.require_df !== false && /delivery\s*to\s*;?/i.test(raw)) {
      res.status(400).json({ error: 'Df is required for a delivery booking — the paste had no Df line' });
      return;
    }

    const booking = await createBooking(actorOf(req), {
      details_text: raw,
      total: total!,
      delivery_fee: df,
      delivery_lat: b.delivery_lat != null ? Number(b.delivery_lat) : parsed?.lat ?? null,
      delivery_lng: b.delivery_lng != null ? Number(b.delivery_lng) : parsed?.lng ?? null,
      customer_name: b.customer_name ?? null,
      customer_phone: b.customer_phone ?? null,
      notes: b.notes ?? null,
      priority: b.priority === 'HIGH' ? 'HIGH' : 'NORMAL',
      source: raw ? 'PASTE' : 'MANUAL',
    });
    void pushNewJob(booking);
    res.status(201).json(booking);
  } catch (err: any) { handle(err, res); }
});

managerBookingsRouter.get('/dashboard', async (_req, res) => {
  try { res.json(await managerDashboard()); } catch (err: any) { handle(err, res); }
});

managerBookingsRouter.get('/bookings', async (req, res) => {
  try {
    const g = req.query as any;
    const rows = await listBookings({
      group: g.group, status: g.status, from: g.from, to: g.to, q: g.q,
      rider_id: g.rider_id ? Number(g.rider_id) : undefined,
      unassigned: g.unassigned === '1' || g.unassigned === 'true',
      day_id: g.day_id ? Number(g.day_id) : undefined,
      include_archived: g.include_archived === '1',
      limit: g.limit ? Number(g.limit) : undefined,
      offset: g.offset ? Number(g.offset) : undefined,
    });
    res.json(rows);
  } catch (err: any) { handle(err, res); }
});

managerBookingsRouter.get('/bookings/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const booking = await getBooking(id);
    if (!booking) { res.status(404).json({ error: 'Booking not found' }); return; }
    const [requests, events] = await Promise.all([
      q(`SELECT req.*, r.full_name AS rider_name FROM bk_booking_requests req
          JOIN bk_riders r ON r.id = req.rider_id
          WHERE req.booking_id = $1 ORDER BY req.created_at`, [id]),
      timeline(id),
    ]);
    res.json({ ...booking, requests, events });
  } catch (err: any) { handle(err, res); }
});

managerBookingsRouter.put('/bookings/:id', async (req, res) => {
  try {
    const booking = await editBooking(actorOf(req), Number(req.params.id), req.body ?? {});
    res.json(booking);
  } catch (err: any) { handle(err, res); }
});

/** Archive is the only "delete" — there is NO hard-delete route (§6.10.1). */
managerBookingsRouter.post('/bookings/:id/archive', async (req, res) => {
  try {
    const row = await archiveBooking(actorOf(req), Number(req.params.id), req.body?.reason);
    res.json(row);
  } catch (err: any) { handle(err, res); }
});

managerBookingsRouter.post('/bookings/:id/unarchive', async (req, res) => {
  try { res.json(await unarchiveBooking(actorOf(req), Number(req.params.id))); }
  catch (err: any) { handle(err, res); }
});

managerBookingsRouter.post('/bookings/:id/note', async (req, res) => {
  try {
    await addNote(actorOf(req), Number(req.params.id), String(req.body?.message ?? ''));
    res.json({ ok: true });
  } catch (err: any) { handle(err, res); }
});

managerBookingsRouter.get('/bookings/:id/timeline', async (req, res) => {
  try { res.json(await timeline(Number(req.params.id))); } catch (err: any) { handle(err, res); }
});

// ── dispatch actions ──────────────────────────────────────────────────────────
async function action(req: Request, res: Response, to: string, extra: any = {}): Promise<void> {
  try {
    const booking = await transition(actorOf(req), Number(req.params.id), { to, ...extra });
    res.json(booking);
  } catch (err: any) { handle(err, res); }
}

managerBookingsRouter.post('/bookings/:id/assign', (req, res) =>
  void action(req, res, 'ASSIGNED', { riderId: Number(req.body?.rider_id), note: req.body?.note }));

managerBookingsRouter.post('/bookings/:id/transfer', (req, res) => {
  const reason = String(req.body?.reason ?? '').trim();
  if (!reason) { res.status(400).json({ error: 'A reason is required for every transfer' }); return; }
  void action(req, res, 'ASSIGNED', { riderId: Number(req.body?.to_rider_id), reason });
});

managerBookingsRouter.post('/bookings/:id/cancel', (req, res) => {
  const reason = String(req.body?.reason ?? '').trim();
  if (!reason) { res.status(400).json({ error: 'A reason is required to cancel' }); return; }
  void action(req, res, 'CANCELLED', { reason });
});

// ── requests queue ────────────────────────────────────────────────────────────
managerBookingsRouter.get('/requests', async (_req, res) => {
  try { res.json(await pendingRequests()); } catch (err: any) { handle(err, res); }
});

/**
 * COUNT ONLY — the manager's nav badge must be able to show "3 waiting" from any
 * screen without pulling the whole queue. Same predicate as pendingRequests(),
 * so the badge can never disagree with the Requests page.
 */
managerBookingsRouter.get('/requests/count', async (_req, res) => {
  try {
    const row = await q1<{ n: number }>(
      `SELECT count(*)::int AS n FROM bk_booking_requests req
       JOIN bk_bookings b ON b.id = req.booking_id
       WHERE req.status = 'PENDING' AND b.status = 'PENDING' AND b.archived_at IS NULL`,
    );
    res.json({ count: Number(row?.n ?? 0) });
  } catch (err: any) { handle(err, res); }
});

managerBookingsRouter.post('/requests/:id/approve', async (req, res) => {
  try {
    const booking = await approveRequest(actorOf(req), Number(req.params.id));
    void pushRiders(
      [booking.assigned_rider_id],
      `✅ You got ${booking.ref}`,
      'Accept or decline the job',
      `#/rider/jobs/${booking.id}`,
      'notify_request_approved',
    );
    void pushManager(`${booking.ref} → ${booking.rider_name}`, 'Request approved', '#/manager/dashboard', 'notify_request_approved');
    res.json(booking);
  } catch (err: any) { handle(err, res); }
});

managerBookingsRouter.post('/requests/:id/reject', async (req, res) => {
  try { res.json(await rejectRequest(actorOf(req), Number(req.params.id), req.body?.reason)); }
  catch (err: any) { handle(err, res); }
});

// ═══════════════════════════════════════════════════════════════════════════════
// RIDER (§9.4) — ownership checked in SQL; a foreign job is 404, not 403 (§7.3)
// ═══════════════════════════════════════════════════════════════════════════════

riderBookingsRouter.get('/home', async (req, res) => {
  try { res.json(await riderHome(req.user!.rider_id!)); } catch (err: any) { handle(err, res); }
});

riderBookingsRouter.get('/jobs', async (req, res) => {
  try {
    const home = await riderHome(req.user!.rider_id!);
    const scope = String(req.query.scope || 'all');
    const map: Record<string, string> = {
      ongoing: 'ongoing', claimed: 'claimed', open: 'open', history: 'closed',
    };
    if (scope === 'all') { res.json(home); return; }
    const key = map[scope];
    res.json(key ? home[key] ?? [] : []);
  } catch (err: any) { handle(err, res); }
});

/** 404 unless assigned_rider_id === me — never confirm existence (§7.3). */
async function loadOwnJob(req: Request, res: Response): Promise<any | null> {
  const id = Number(req.params.id);
  const booking = await getBooking(id);
  if (!booking || booking.assigned_rider_id !== req.user!.rider_id) {
    res.status(404).json({ error: 'Job not found' });
    return null;
  }
  return booking;
}

riderBookingsRouter.get('/jobs/:id', async (req, res) => {
  try {
    const booking = await loadOwnJob(req, res);
    if (!booking) return;
    const events = await timeline(booking.id, { riderId: req.user!.rider_id! });
    res.json({ ...booking, events });
  } catch (err: any) { handle(err, res); }
});

riderBookingsRouter.post('/jobs/:id/request', async (req, res) => {
  try {
    const row = await requestBooking(actorOf(req), Number(req.params.id), req.body?.note);
    void pushManager(
      `🔔 ${req.user!.full_name} requests ${req.body?.ref ?? 'a job'}`,
      req.body?.note || 'Tap to review',
      '#/manager/dashboard',
      'notify_request_received',
    );
    res.status(201).json(row);
  } catch (err: any) { handle(err, res); }
});

riderBookingsRouter.post('/requests/:id/withdraw', async (req, res) => {
  try { res.json(await withdrawRequest(actorOf(req), Number(req.params.id))); }
  catch (err: any) { handle(err, res); }
});

async function riderAction(req: Request, res: Response, to: string): Promise<void> {
  try {
    const booking = await transition(actorOf(req), Number(req.params.id), { to });
    if (to === 'ACCEPTED') {
      void pushManager(`✅ ${booking.ref} accepted by ${booking.rider_name}`, 'Job is now ongoing', '#/manager/dashboard', 'notify_job_status');
    }
    if (to === 'DELIVERED') {
      void pushManager(`🎉 ${booking.ref} delivered`, `₱${booking.commission_amount} commission accrued`, '#/manager/history', 'notify_job_status');
    }
    res.json(booking);
  } catch (err: any) { handle(err, res); }
}

riderBookingsRouter.post('/jobs/:id/accept', (req, res) => void riderAction(req, res, 'ACCEPTED'));
riderBookingsRouter.post('/jobs/:id/pickup', (req, res) => void riderAction(req, res, 'PICKED_UP'));
riderBookingsRouter.post('/jobs/:id/deliver', (req, res) => void riderAction(req, res, 'DELIVERED'));
riderBookingsRouter.post('/jobs/:id/decline', async (req, res) => {
  try {
    const booking = await transition(actorOf(req), Number(req.params.id), {
      to: 'PENDING', reason: req.body?.reason,
    });
    void pushManager(
      `${req.user!.full_name} declined ${booking.ref}`,
      req.body?.reason || 'Back on the board',
      '#/manager/dashboard',
      'notify_job_status',
    );
    res.json(booking);
  } catch (err: any) { handle(err, res); }
});

riderBookingsRouter.get('/jobs/:id/timeline', async (req, res) => {
  try {
    const booking = await loadOwnJob(req, res);
    if (!booking) return;
    res.json(await timeline(booking.id, { riderId: req.user!.rider_id! }));
  } catch (err: any) { handle(err, res); }
});


