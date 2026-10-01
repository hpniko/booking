/**
 * src/services/bookings.ts — the state machine and live groups (§6.4).
 *
 * ALL status transitions go through assertTransition() — one place, one set of
 * guards, one transaction that writes status + money + exactly one event, then
 * emits exactly one live event (§6.4 invariants).
 *
 * live_group / is_ongoing are DERIVED from status, never stored (§6.4.1).
 */
import { q, q1, tx } from '../db/pg';
import { buildNav } from '../lib/nav';
import { computeSplit } from '../lib/money';
import { currentRate, getNumber, getBool } from './settings';
import { applySplit, accrueOnDelivery, voidLedgerForBooking, repriceOnRedispatch } from './money';
import { ensureOpenDay } from './day';
import { emit } from './events';
import { logSystemEvent, postBookingCard } from './chat';
import { onlineRiderSet } from './presence';

export type LiveGroup = 'OPEN' | 'CLAIMED' | 'ONGOING' | 'CLOSED';

/** Derived, never persisted. is_ongoing === true IFF ACCEPTED or PICKED_UP. */
export function liveGroupOf(status: string): LiveGroup {
  switch (status) {
    case 'PENDING': return 'OPEN';
    case 'ASSIGNED': return 'CLAIMED';
    case 'ACCEPTED':
    case 'PICKED_UP': return 'ONGOING';
    case 'DELIVERED':
    case 'CANCELLED': return 'CLOSED';
    default: return 'OPEN'; // an unknown status must never hide a job
  }
}

export const isOngoing = (status: string): boolean => liveGroupOf(status) === 'ONGOING';

/** Decorate a booking row with derived live state + nav + rider dot. */
export function decorate(b: any, online?: Set<number>): any {
  if (!b) return b;
  const live_group = liveGroupOf(b.status);
  const nav = buildNav(b.delivery_lat, b.delivery_lng);
  return {
    ...b,
    live_group,
    is_ongoing: live_group === 'ONGOING',
    nav,
    waze_app: nav?.waze_app ?? null,
    waze_https: nav?.waze_https ?? null,
    google_maps: nav?.google ?? null,
    rider_online: b.assigned_rider_id != null && online ? online.has(b.assigned_rider_id) : (b.rider_online ?? null),
  };
}

export class TransitionError extends Error {
  status: number;
  constructor(message: string, status = 409) { super(message); this.status = status; }
}

/** Legal transitions + who may perform them (§6.4 table). */
const ALLOWED: Record<string, { to: string[]; actor: 'MANAGER' | 'RIDER' | 'BOTH' }> = {
  PENDING: { to: ['ASSIGNED', 'CANCELLED'], actor: 'MANAGER' },
  ASSIGNED: { to: ['ACCEPTED', 'PENDING', 'ASSIGNED', 'CANCELLED'], actor: 'BOTH' },
  ACCEPTED: { to: ['PICKED_UP', 'ASSIGNED', 'PENDING', 'CANCELLED'], actor: 'BOTH' },
  PICKED_UP: { to: ['DELIVERED', 'CANCELLED'], actor: 'BOTH' },
  DELIVERED: { to: [], actor: 'MANAGER' },
  CANCELLED: { to: [], actor: 'MANAGER' },
};

export function assertTransition(from: string, to: string, actorRole: 'MANAGER' | 'RIDER'): void {
  const rule = ALLOWED[from];
  if (!rule) throw new TransitionError(`Unknown status: ${from}`, 500);
  if (!rule.to.includes(to)) {
    throw new TransitionError(`Cannot go ${from} → ${to}`, 409);
  }
  if (rule.actor !== 'BOTH' && rule.actor !== actorRole) {
    throw new TransitionError(`${actorRole.toLowerCase()}s cannot perform ${from} → ${to}`, 403);
  }
  // rider-specific directions
  if (actorRole === 'RIDER') {
    const riderOk = ['ACCEPTED', 'PENDING', 'PICKED_UP', 'DELIVERED'].includes(to);
    if (!riderOk) throw new TransitionError('Only the manager can do that', 403);
  }
}

export interface Actor {
  id: number;
  role: 'MANAGER' | 'RIDER';
  name: string;
  riderId?: number | null;
}

interface EventInput {
  bookingId?: number | null;
  entity?: string;
  type: string;
  message?: string;
  from?: string | null;
  to?: string | null;
  amountDelta?: number | null;
  meta?: any;
  visibleToRider?: boolean;
}

async function writeEvent(client: any, actor: Actor, e: EventInput): Promise<void> {
  await client.query(
    `INSERT INTO bk_booking_events
       (booking_id, entity, type, message, actor_type, actor_id, actor_name, from_status, to_status, amount_delta, meta, visible_to_rider)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
    [
      e.bookingId ?? null, e.entity ?? 'BOOKING', e.type, e.message ?? null,
      actor.role, actor.id, actor.name, e.from ?? null, e.to ?? null,
      e.amountDelta ?? null, e.meta ? JSON.stringify(e.meta) : null,
      e.visibleToRider === false ? 0 : 1,
    ],
  );
}

/** Load + decorate one booking (single read used by detail/transition replies). */
export async function getBooking(id: number): Promise<any | null> {
  const row = await q1<any>(
    `SELECT b.*, r.full_name AS rider_name, r.phone AS rider_phone, d.date_ref
     FROM bk_bookings b
     LEFT JOIN bk_riders r ON r.id = b.assigned_rider_id
     LEFT JOIN bk_dispatch_days d ON d.id = b.day_id
     WHERE b.id = $1`,
    [id],
  );
  return decorate(row, await onlineRiderSet());
}

/** Ref generator: BK-1000+id, monotonic, unique via the id itself. */
function refFor(id: number): string {
  return `BK-${1000 + id}`;
}

export interface CreateInput {
  raw_text?: string;
  details_text?: string;
  total: number;
  delivery_fee?: number;
  delivery_lat?: number | null;
  delivery_lng?: number | null;
  customer_name?: string | null;
  customer_phone?: string | null;
  notes?: string | null;
  priority?: 'NORMAL' | 'HIGH';
  source?: 'PASTE' | 'MANUAL';
}

/**
 * Create a PENDING booking (§4.1). Validates money (§6.5.4), snapshots the
 * split at the CURRENT rate, writes CREATED + PARSED events, broadcasts.
 * The booking joins today's open day (creating it if the tick hasn't run).
 */
export async function createBooking(actor: Actor, input: CreateInput): Promise<any> {
  const total = Math.round(Number(input.total));
  const df = Math.round(Number(input.delivery_fee ?? 0));
  const details = String(input.details_text ?? input.raw_text ?? '');

  if (!Number.isFinite(total) || total <= 0) {
    throw Object.assign(new Error('A booking total is required for commission'), { status: 400 });
  }
  if (!Number.isFinite(df) || df < 0) {
    throw Object.assign(new Error('Df cannot be negative'), { status: 400 });
  }
  if (df > total) throw Object.assign(new Error('Df cannot exceed the booking total'), { status: 400 });
  if (total - df <= 0) throw Object.assign(new Error('Total and Df leave no food value'), { status: 400 });
  if (input.delivery_lat != null && (Math.abs(input.delivery_lat) > 90 || Math.abs(input.delivery_lng ?? 0) > 180)) {
    throw Object.assign(new Error('Drop-off pin is out of range'), { status: 400 });
  }

  const day = await ensureOpenDay();
  const rate = await currentRate();

  const booking = await tx(async (client) => {
    const inserted = (await client.query(
      `INSERT INTO bk_bookings (ref, day_id, status, priority, source, total, delivery_fee,
                                delivery_lat, delivery_lng, pin_source, customer_name, customer_phone,
                                notes, details_text, created_by)
       VALUES ('TMP', $1, 'PENDING', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       RETURNING *`,
      [
        day.id, input.priority ?? 'NORMAL', input.source ?? 'PASTE', total, df,
        input.delivery_lat ?? null, input.delivery_lng ?? null,
        input.delivery_lat != null ? 'PASTE_LINK' : null,
        input.customer_name || null, input.customer_phone || null,
        input.notes || null, details || null, actor.id,
      ],
    )).rows[0];
    const ref = refFor(inserted.id);
    (await client.query('UPDATE bk_bookings SET ref = $2 WHERE id = $1', [inserted.id, ref]));
    inserted.ref = ref;

    await applySplit(client, inserted.id, total, df, rate);
    const split = { ...computeSplit(total, df, rate) };

    await writeEvent(client, actor, {
      bookingId: inserted.id, type: 'CREATED', to: 'PENDING',
      message: `created — total ₱${total} · Df ₱${df}`,
      amountDelta: split.commission,
      meta: { ...split, delivery_fee: df },
    });
    await writeEvent(client, actor, {
      bookingId: inserted.id, type: 'PARSED', visibleToRider: false,
      message: input.delivery_lat != null ? 'parsed: total, Df, pin' : 'parsed: total, Df',
      meta: { total, delivery_fee: df, lat: input.delivery_lat, lng: input.delivery_lng },
    });
    return { ...inserted, ...split };
  });

  await logSystemEvent(`📋 New booking ${booking.ref} — ₱${total}`);
  const full = await getBooking(booking.id);
  emit('bookings', { id: booking.id, action: 'created', booking: full, status: 'PENDING' });
  return full;
}

export interface TransitionOpts {
  to: string;
  /** Required for transfer — audit trail (§6.4). */
  reason?: string;
  /** New rider for assign/transfer. */
  riderId?: number | null;
  note?: string | null;
  /** Expected current status — optimistic guard (R2). */
  expectStatus?: string;
}

/**
 * THE transition function. One transaction writes: status → money → one event.
 * Then exactly one live event is emitted (§6.4 invariants).
 */
export async function transition(actor: Actor, bookingId: number, opts: TransitionOpts): Promise<any> {
  const result = await tx(async (client) => {
    // re-read inside the transaction — a stale write returns 409 (R2)
    const cur = (await client.query(
      'SELECT * FROM bk_bookings WHERE id = $1 FOR UPDATE', [bookingId],
    )).rows[0];
    if (!cur) throw new TransitionError('Booking not found', 404);
    if (cur.archived_at) throw new TransitionError('Booking is archived', 409);
    if (opts.expectStatus && cur.status !== opts.expectStatus) {
      throw new TransitionError(`Booking is ${cur.status}, not ${opts.expectStatus}`, 409);
    }

    const from = cur.status;
    const to = opts.to;
    assertTransition(from, to, actor.role);

    // ownership: only the assigned rider may act on their own job (§7.3)
    if (actor.role === 'RIDER' && cur.assigned_rider_id !== actor.riderId) {
      throw new TransitionError('This job is not assigned to you', 404);
    }

    const patch: string[] = ['updated_at = now()'];
    const params: any[] = [bookingId];
    // NOTE: a fragment with no '?' (e.g. `assigned_at = now()`) must NOT consume a
    // bind parameter, or the statement is sent with more params than placeholders and
    // Postgres rejects it (08P01). Only '?' fragments bind a value.
    const push = (frag: string, val?: any) => {
      if (frag.includes('?')) {
        params.push(val);
        patch.push(frag.replace(/\?/g, () => `$${params.length}`));
      } else {
        patch.push(frag);
      }
    };

    // The status itself is the whole point of the transition — write it first so it
    // is always in the SET list, whatever branch below runs.
    push('status = ?', to);

    if (to === 'ASSIGNED') {
      if (!opts.riderId) throw new TransitionError('rider_id is required', 400);
      // concurrency limit (§6.4 invariants): only checked when re-assigning
      const max = await getNumber('booking_max_concurrent', 1);
      const held = (await client.query(
        `SELECT count(*)::int AS n FROM bk_bookings
         WHERE assigned_rider_id = $1 AND status IN ('ASSIGNED','ACCEPTED','PICKED_UP') AND id <> $2`,
        [opts.riderId, bookingId],
      )).rows[0];
      if (from === 'PENDING' && held.n >= max) {
        throw new TransitionError(`Rider already holds ${held.n} job(s) (max ${max})`, 409);
      }
      push('assigned_rider_id = ?', opts.riderId);
      push('assigned_at = now()');
      // auto-reject competing pending requests (§4.2)
      await client.query(
        `UPDATE bk_booking_requests SET status = 'REJECTED', resolved_at = now(), resolved_by = $2
         WHERE booking_id = $1 AND status = 'PENDING' AND rider_id <> $3`,
        [bookingId, actor.id, opts.riderId],
      );
    }

    if (to === 'PENDING') {
      push('assigned_rider_id = ?', null);
      push('assigned_at = ?', null);
      push('accepted_at = ?', null);
    }
    if (to === 'ACCEPTED') push('accepted_at = now()');
    if (to === 'PICKED_UP') push('picked_up_at = now()');
    if (to === 'DELIVERED') push('delivered_at = now()');
    if (to === 'CANCELLED') {
      push('cancelled_at = now()');
      push('cancel_reason = ?', opts.reason ?? null);
      // zero the money — a cancelled booking contributes 0 (§6.6.5)
      push('food_value = ?', 0);
      push('commission_amount = ?', 0);
      push('rider_payout = ?', 0);
    }

    const updated = (await client.query(
      `UPDATE bk_bookings SET ${patch.join(', ')} WHERE id = $1 RETURNING *`, params,
    )).rows[0];

    // ── money side effects, SAME transaction (§6.4) ──
    if (to === 'PENDING') {
      const rate = await currentRate();
      await applySplit(client, bookingId, updated.total, updated.delivery_fee, rate);
      await voidLedgerForBooking(client, bookingId);
    }
    if (to === 'CANCELLED') await voidLedgerForBooking(client, bookingId);
    if (to === 'DELIVERED') await accrueOnDelivery(client, updated);

    // ── exactly one event ──
    const riderName = opts.riderId
      ? (await client.query('SELECT full_name FROM bk_riders WHERE id = $1', [opts.riderId])).rows[0]?.full_name
      : null;
    const eventType =
      to === 'ASSIGNED' ? (from === 'ASSIGNED' ? 'TRANSFERRED' : 'ASSIGNED') :
      to === 'ACCEPTED' ? 'ACCEPTED' :
      to === 'PENDING' ? (from === 'ASSIGNED' || from === 'ACCEPTED' ? 'DECLINED' : 'REASSIGNED') :
      to === 'PICKED_UP' ? 'PICKED_UP' :
      to === 'DELIVERED' ? 'DELIVERED' :
      to === 'CANCELLED' ? 'CANCELLED' : 'EDITED';

    let message: string | undefined = opts.note ?? undefined;
    if (eventType === 'ASSIGNED' && riderName) message = `assigned to ${riderName}`;
    if (eventType === 'TRANSFERRED') {
      const prev = cur.assigned_rider_id
        ? (await client.query('SELECT full_name FROM bk_riders WHERE id = $1', [cur.assigned_rider_id])).rows[0]?.full_name
        : '—';
      message = `transferred: ${prev} → ${riderName}${opts.reason ? ` · reason: ${opts.reason}` : ''}`;
    }
    if (eventType === 'DECLINED') message = opts.reason ? `declined — ${opts.reason}` : 'declined';
    if (eventType === 'CANCELLED') message = `cancelled${opts.reason ? ` — ${opts.reason}` : ''}`;

    await writeEvent(client, actor, {
      bookingId, type: eventType, from, to, message,
      amountDelta: to === 'DELIVERED' ? updated.commission_amount
        : (to === 'CANCELLED' ? -(cur.commission_amount ?? 0) : null),
      meta: opts.reason ? { reason: opts.reason } : undefined,
    });
    if (eventType === 'TRANSFERRED' && opts.reason) {
      await writeEvent(client, actor, {
        bookingId, type: 'EDITED', from, to,
        message: `transfer reason: ${opts.reason}`, visibleToRider: false,
      });
    }
    return updated;
  });

  // ── side effects OUTSIDE the transaction: chat line + broadcast ──
  const full = await getBooking(result.id);
  await afterTransition(opts.to, full);
  emit('bookings', { id: result.id, action: 'transition', booking: full, status: full.status });
  emit('requests', { booking_id: result.id });
  return full;
}

async function afterTransition(to: string, booking: any): Promise<void> {
  const ref = booking.ref;
  const rider = booking.rider_name ?? '';
  switch (to) {
    case 'ASSIGNED': await logSystemEvent(`🎯 ${ref} assigned to ${rider}`); break;
    case 'ACCEPTED': await logSystemEvent(`✅ ${ref} accepted by ${rider}`); break;
    case 'PICKED_UP': await logSystemEvent(`📦 ${ref} picked up`); break;
    case 'DELIVERED': await logSystemEvent(`🎉 ${ref} delivered`); break;
    case 'CANCELLED': await logSystemEvent(`❌ ${ref} cancelled`); break;
    case 'PENDING': await logSystemEvent(`↩️ ${ref} back on the board`); break;
    default: break;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Queries (§9.3, §9.4)
// ─────────────────────────────────────────────────────────────────────────────

const BASE_SELECT = `
  SELECT b.*, r.full_name AS rider_name, d.date_ref
  FROM bk_bookings b
  LEFT JOIN bk_riders r ON r.id = b.assigned_rider_id
  LEFT JOIN bk_dispatch_days d ON d.id = b.day_id`;

export interface ListFilters {
  group?: string; status?: string; from?: string; to?: string; q?: string;
  rider_id?: number; unassigned?: boolean; day_id?: number;
  include_archived?: boolean; limit?: number; offset?: number;
}

function buildWhere(f: ListFilters, params: any[]): string {
  const where: string[] = ['1=1'];
  if (!f.include_archived) where.push('b.archived_at IS NULL');
  if (f.day_id) { params.push(f.day_id); where.push(`b.day_id = $${params.length}`); }
  if (f.group) {
    const map: Record<string, string[]> = {
      OPEN: ['PENDING'], CLAIMED: ['ASSIGNED'], ONGOING: ['ACCEPTED', 'PICKED_UP'],
      CLOSED: ['DELIVERED', 'CANCELLED'],
    };
    const list = map[f.group.toUpperCase()];
    if (list) { params.push(list); where.push(`b.status = ANY($${params.length})`); }
  }
  if (f.status) {
    const list = f.status.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
    if (list.length) { params.push(list); where.push(`b.status = ANY($${params.length})`); }
  }
  if (f.from) { params.push(new Date(f.from).toISOString()); where.push(`b.created_at >= $${params.length}`); }
  if (f.to) { params.push(new Date(f.to).toISOString()); where.push(`b.created_at < $${params.length}`); }
  if (f.rider_id) { params.push(f.rider_id); where.push(`b.assigned_rider_id = $${params.length}`); }
  if (f.unassigned) where.push('b.assigned_rider_id IS NULL');
  if (f.q) {
    params.push(`%${f.q}%`);
    where.push(`(b.ref ILIKE $${params.length} OR coalesce(b.customer_name,'') ILIKE $${params.length}
                 OR coalesce(b.details_text,'') ILIKE $${params.length})`);
  }
  return where.join(' AND ');
}

export async function listBookings(f: ListFilters = {}): Promise<any[]> {
  const params: any[] = [];
  const where = buildWhere(f, params);
  const limit = Math.min(Number(f.limit) || 200, 500);
  const rows = await q(
    `${BASE_SELECT} WHERE ${where} ORDER BY b.created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, limit, Number(f.offset) || 0],
  );
  const online = await onlineRiderSet();
  return rows.map((r) => decorate(r, online));
}

/** Manager dashboard — one payload for the whole board (§9.3). */
export async function managerDashboard(): Promise<any> {
  const { currentDay } = await import('./day');
  const day = await currentDay();
  const rows = day
    ? await q(`${BASE_SELECT} WHERE b.archived_at IS NULL AND b.day_id = $1 ORDER BY b.created_at DESC`, [day.id])
    : await q(`${BASE_SELECT} WHERE b.archived_at IS NULL ORDER BY b.created_at DESC`);
  const online = await onlineRiderSet();
  const bookings = rows.map((r) => decorate(r, online));

  const counts = { open: 0, claimed: 0, ongoing: 0, done: 0, cancelled: 0 };
  for (const b of bookings) {
    const g = b.live_group;
    if (g === 'OPEN') counts.open++;
    else if (g === 'CLAIMED') counts.claimed++;
    else if (g === 'ONGOING') counts.ongoing++;
    else if (b.status === 'DELIVERED') counts.done++;
    else if (b.status === 'CANCELLED') counts.cancelled++;
  }

  const pendingRequests = await q(
    `SELECT req.*, b.ref, b.total, b.delivery_fee, b.customer_name, r.full_name AS rider_name
     FROM bk_booking_requests req
     JOIN bk_bookings b ON b.id = req.booking_id
     JOIN bk_riders r ON r.id = req.rider_id
     WHERE req.status = 'PENDING' AND b.status = 'PENDING' AND b.archived_at IS NULL
     ORDER BY req.created_at`,
  );

  const { riderRoster } = await import('./presence');
  const roster = await riderRoster();

  return {
    day,
    live: {
      open: counts.open, claimed: counts.claimed, ongoing: counts.ongoing,
      done_today: counts.done, cancelled: counts.cancelled,
    },
    ongoing: bookings.filter((b) => b.live_group === 'ONGOING'),
    claimed: bookings.filter((b) => b.live_group === 'CLAIMED'),
    open: bookings.filter((b) => b.live_group === 'OPEN'),
    done: bookings.filter((b) => b.status === 'DELIVERED'),
    pendingRequests,
    riders: roster,
    onlineRiders: roster.filter((r) => r.online).map((r: any) => r.id),
    ongoingRiderOffline: bookings.filter((b) => b.live_group === 'ONGOING' && b.rider_online === false),
  };
}

/** Rider home — one round-trip payload (§10.6.3). */
export async function riderHome(riderId: number): Promise<any> {
  const rows = await q(
    `${BASE_SELECT} WHERE b.archived_at IS NULL AND b.assigned_rider_id = $1
     ORDER BY CASE b.status WHEN 'PICKED_UP' THEN 0 WHEN 'ACCEPTED' THEN 1 WHEN 'ASSIGNED' THEN 2 ELSE 3 END,
              b.created_at DESC`,
    [riderId],
  );
  const openRows = await q(
    `${BASE_SELECT} WHERE b.archived_at IS NULL AND b.status = 'PENDING' ORDER BY b.created_at DESC LIMIT 50`,
  );
  const online = await onlineRiderSet();
  const mine = rows.map((r) => decorate(r, online));
  const open = openRows.map((r) => decorate(r, online));

  // hide address + details on unassigned jobs (§12 open-job address leak)
  const showAddress = await getBool('booking_open_jobs_show_address', false);
  const visibleOpen = showAddress ? open : open.map((b: any) => ({
    ...b,
    details_text: null,
    address_hidden: true,
    customer_name: null,
    customer_phone: null,
  }));

  const myRequests = await q(
    `SELECT * FROM bk_booking_requests WHERE rider_id = $1 AND status = 'PENDING' ORDER BY created_at DESC`,
    [riderId],
  );

  const { riderEarnings } = await import('./money');
  const showEarnings = await getBool('booking_show_rider_earnings', true);
  const earnings = showEarnings ? await riderEarnings(riderId) : null;

  return {
    ongoing: mine.filter((b) => b.live_group === 'ONGOING'),
    claimed: mine.filter((b) => b.live_group === 'CLAIMED'),
    closed: mine.filter((b) => b.live_group === 'CLOSED'),
    open: visibleOpen,
    requests: myRequests,
    earnings,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Booking requests (§4.2)
// ─────────────────────────────────────────────────────────────────────────────

/** Rider requests an unassigned booking — one live claim per rider (UNIQUE). */
export async function requestBooking(actor: Actor, bookingId: number, note?: string): Promise<any> {
  if (actor.role !== 'RIDER' || !actor.riderId) throw new TransitionError('Rider only', 403);
  const booking = await q1<any>('SELECT * FROM bk_bookings WHERE id = $1 AND archived_at IS NULL', [bookingId]);
  if (!booking) throw new TransitionError('Booking not found', 404);
  if (booking.status !== 'PENDING') throw new TransitionError('This job is no longer open', 409);

  // concurrency limit applies to requests too — a rider can't hoard the board
  const max = await getNumber('booking_max_concurrent', 1);
  const held = await q1<{ n: number }>(
    `SELECT count(*)::int AS n FROM bk_bookings
     WHERE assigned_rider_id = $1 AND status IN ('ASSIGNED','ACCEPTED','PICKED_UP')`,
    [actor.riderId],
  );
  if ((held?.n ?? 0) >= max) throw new TransitionError(`You already hold ${held?.n} job(s) (max ${max})`, 409);

  const existing = await q1<any>(
    'SELECT * FROM bk_booking_requests WHERE booking_id = $1 AND rider_id = $2',
    [bookingId, actor.riderId],
  );
  if (existing && existing.status === 'PENDING') return existing;
  if (existing && existing.status === 'WITHDRAWN') {
    const revived = await q1<any>(
      `UPDATE bk_booking_requests SET status = 'PENDING', note = $3, created_at = now(), resolved_at = NULL
       WHERE id = $1 RETURNING *`,
      [existing.id, note ?? null],
    );
    await recordRequestEvent(actor, booking, revived, 'REQUESTED', note);
    emit('requests', { booking_id: bookingId, rider_id: actor.riderId });
    return revived;
  }

  let row: any;
  try {
    row = await q1<any>(
      `INSERT INTO bk_booking_requests (booking_id, rider_id, status, note)
       VALUES ($1, $2, 'PENDING', $3) RETURNING *`,
      [bookingId, actor.riderId, note ?? null],
    );
  } catch (err: any) {
    if (String(err.message).includes('unique')) {
      throw new TransitionError('You already requested this job', 409);
    }
    throw err;
  }
  await recordRequestEvent(actor, booking, row, 'REQUESTED', note);
  emit('requests', { booking_id: bookingId, rider_id: actor.riderId });
  return row;
}

async function recordRequestEvent(actor: Actor, booking: any, req: any, type: string, note?: string): Promise<void> {
  await q(
    `INSERT INTO bk_booking_events (booking_id, entity, type, message, actor_type, actor_id, actor_name, meta, visible_to_rider)
     VALUES ($1, 'BOOKING', $2, $3, $4, $5, $6, $7, 1)`,
    [
      booking.id, type,
      type === 'REQUESTED' ? `requested${note ? ` — ${note}` : ''}` : type.toLowerCase(),
      actor.role, actor.id, actor.name, JSON.stringify({ rider_id: actor.riderId, request_id: req?.id }),
    ],
  );
}

export async function withdrawRequest(actor: Actor, requestId: number): Promise<any> {
  if (actor.role !== 'RIDER' || !actor.riderId) throw new TransitionError('Rider only', 403);
  const req = await q1<any>('SELECT * FROM bk_booking_requests WHERE id = $1', [requestId]);
  if (!req || req.rider_id !== actor.riderId) throw new TransitionError('Request not found', 404);
  if (req.status !== 'PENDING') throw new TransitionError('Request is already resolved', 409);
  const updated = await q1<any>(
    `UPDATE bk_booking_requests SET status = 'WITHDRAWN', resolved_at = now() WHERE id = $1 RETURNING *`,
    [requestId],
  );
  const booking = await q1<any>('SELECT * FROM bk_bookings WHERE id = $1', [req.booking_id]);
  await recordRequestEvent(actor, booking, updated, 'WITHDRAWN');
  emit('requests', { booking_id: req.booking_id, rider_id: actor.riderId });
  return updated;
}

/**
 * Manager approves a request → assign that rider, auto-reject the rest (§4.2).
 * Uses the SAME transition path as a direct assign — one set of guards.
 */
export async function approveRequest(actor: Actor, requestId: number): Promise<any> {
  if (actor.role !== 'MANAGER') throw new TransitionError('Manager only', 403);
  const req = await q1<any>('SELECT * FROM bk_booking_requests WHERE id = $1', [requestId]);
  if (!req) throw new TransitionError('Request not found', 404);
  if (req.status !== 'PENDING') throw new TransitionError('Request is already resolved', 409);

  await q(
    `UPDATE bk_booking_requests SET status = 'APPROVED', resolved_at = now(), resolved_by = $2 WHERE id = $1`,
    [requestId, actor.id],
  );
  const booking = await transition(actor, req.booking_id, { to: 'ASSIGNED', riderId: req.rider_id });
  await q(
    `INSERT INTO bk_booking_events (booking_id, entity, type, message, actor_type, actor_id, actor_name, visible_to_rider)
     VALUES ($1, 'BOOKING', 'APPROVED', $2, 'MANAGER', $3, $4, 1)`,
    [req.booking_id, `request approved → ${booking.rider_name}`, actor.id, actor.name],
  );
  emit('requests', { booking_id: req.booking_id, approved: true });
  return booking;
}

export async function rejectRequest(actor: Actor, requestId: number, reason?: string): Promise<any> {
  if (actor.role !== 'MANAGER') throw new TransitionError('Manager only', 403);
  const req = await q1<any>('SELECT * FROM bk_booking_requests WHERE id = $1', [requestId]);
  if (!req) throw new TransitionError('Request not found', 404);
  if (req.status !== 'PENDING') throw new TransitionError('Request is already resolved', 409);
  await q(
    `UPDATE bk_booking_requests SET status = 'REJECTED', resolved_at = now(), resolved_by = $2 WHERE id = $1`,
    [requestId, actor.id],
  );
  const booking = await q1<any>('SELECT ref FROM bk_bookings WHERE id = $1', [req.booking_id]);
  await q(
    `INSERT INTO bk_booking_events (booking_id, entity, type, message, actor_type, actor_id, actor_name, meta, visible_to_rider)
     VALUES ($1, 'BOOKING', 'REJECTED', $2, 'MANAGER', $3, $4, $5, 1)`,
    [req.booking_id, `request rejected${reason ? ` — ${reason}` : ''}`, actor.id, actor.name,
     JSON.stringify({ rider_id: req.rider_id, reason: reason ?? null })],
  );
  emit('requests', { booking_id: req.booking_id });
  return { ok: true, ref: booking?.ref };
}

/** Pending claims queue, oldest first (§9.3). */
export async function pendingRequests(): Promise<any[]> {
  return q(
    `SELECT req.*, b.ref, b.total, b.delivery_fee, b.customer_name, b.details_text,
            r.full_name AS rider_name, r.vehicle
     FROM bk_booking_requests req
     JOIN bk_bookings b ON b.id = req.booking_id
     JOIN bk_riders r ON r.id = req.rider_id
     WHERE req.status = 'PENDING' AND b.status = 'PENDING' AND b.archived_at IS NULL
     ORDER BY req.created_at`,
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Edit / note / archive (§6.10)
// ─────────────────────────────────────────────────────────────────────────────

export interface EditInput {
  total?: number; delivery_fee?: number;
  delivery_lat?: number | null; delivery_lng?: number | null;
  customer_name?: string | null; customer_phone?: string | null;
  notes?: string | null; priority?: 'NORMAL' | 'HIGH';
}

/**
 * Edit fields — does NOT change status (§9.3). Money edits re-run applySplit
 * at the booking's OWN snapshot rate (never the current one). Editing a
 * DELIVERED booking's total is BLOCKED (§6.10.6).
 */
export async function editBooking(actor: Actor, id: number, input: EditInput): Promise<any> {
  if (actor.role !== 'MANAGER') throw new TransitionError('Manager only', 403);
  const cur = await q1<any>('SELECT * FROM bk_bookings WHERE id = $1', [id]);
  if (!cur) throw new TransitionError('Booking not found', 404);
  if (cur.status === 'DELIVERED' && (input.total != null || input.delivery_fee != null)) {
    throw new TransitionError('A delivered booking\'s money is frozen (no /reprice)', 409);
  }

  const patch: string[] = ['updated_at = now()'];
  const params: any[] = [id];
  // Only '?' fragments bind a value (see the same helper in transition()).
  const push = (frag: string, val: any) => {
    if (!frag.includes('?')) { patch.push(frag); return; }
    params.push(val);
    patch.push(frag.replace(/\?/g, () => `$${params.length}`));
  };

  const changed: Record<string, [any, any]> = {};
  const track = (key: string, oldV: any, newV: any) => {
    if (newV !== undefined && newV !== oldV) changed[key] = [oldV, newV];
  };

  let moneyChanged = false;
  if (input.total !== undefined && input.total !== cur.total) {
    const total = Math.round(Number(input.total));
    if (!Number.isFinite(total) || total <= 0) throw new TransitionError('A booking total is required for commission', 400);
    if (total < cur.delivery_fee) throw new TransitionError('Df cannot exceed the booking total', 400);
    push('total = ?', total); track('total', cur.total, total); moneyChanged = true;
  }
  if (input.delivery_fee !== undefined && input.delivery_fee !== cur.delivery_fee) {
    const df = Math.round(Number(input.delivery_fee));
    const total = input.total !== undefined ? Math.round(Number(input.total)) : cur.total;
    if (df < 0) throw new TransitionError('Df cannot be negative', 400);
    if (df >= total) throw new TransitionError('Total and Df leave no food value', 400);
    push('delivery_fee = ?', df); track('delivery_fee', cur.delivery_fee, df); moneyChanged = true;
  }
  if (input.customer_name !== undefined) { push('customer_name = ?', input.customer_name || null); track('customer_name', cur.customer_name, input.customer_name); }
  if (input.customer_phone !== undefined) { push('customer_phone = ?', input.customer_phone || null); track('customer_phone', cur.customer_phone, input.customer_phone); }
  if (input.notes !== undefined) { push('notes = ?', input.notes || null); track('notes', cur.notes, input.notes); }
  if (input.priority !== undefined && input.priority !== cur.priority) { push('priority = ?', input.priority); track('priority', cur.priority, input.priority); }

  const pinChanged = (input.delivery_lat !== undefined && input.delivery_lat !== cur.delivery_lat)
    || (input.delivery_lng !== undefined && input.delivery_lng !== cur.delivery_lng);
  if (pinChanged) {
    const lat = input.delivery_lat ?? null;
    const lng = input.delivery_lng ?? null;
    if (lat != null && (Math.abs(lat) > 90 || Math.abs(lng ?? 0) > 180)) {
      throw new TransitionError('Drop-off pin is out of range', 400);
    }
    push('delivery_lat = ?', lat);
    push('delivery_lng = ?', lng);
    push('pin_source = ?', lat != null ? 'MAP_PICK' : null);
  }

  if (patch.length === 1) return getBooking(id); // nothing changed

  const updated = await tx(async (client) => {
    const row = (await client.query(
      `UPDATE bk_bookings SET ${patch.join(', ')} WHERE id = $1 RETURNING *`, params,
    )).rows[0];

    if (moneyChanged) {
      const rate = Number(row.commission_rate ?? 0);
      await applySplit(client, id, row.total, row.delivery_fee, rate);
    }
    if (Object.keys(changed).length) {
      await writeEvent(client, actor, {
        bookingId: id, type: 'EDITED',
        message: Object.keys(changed).map((k) => `${k} edited`).join(', '),
        meta: { changed },
      });
    }
    if (pinChanged) {
      await writeEvent(client, actor, {
        bookingId: id, type: 'PIN_CHANGED',
        message: 'drop-off pin moved',
        meta: {
          from: { lat: cur.delivery_lat, lng: cur.delivery_lng },
          to: { lat: input.delivery_lat ?? null, lng: input.delivery_lng ?? null },
        },
      });
    }
    if (moneyChanged) {
      const before = computeSplit(cur.total, cur.delivery_fee, Number(cur.commission_rate ?? 0));
      const after = computeSplit(row.total, row.delivery_fee, Number(row.commission_rate ?? 0));
      await writeEvent(client, actor, {
        bookingId: id, type: 'TOTAL_CHANGED', amountDelta: after.commission - before.commission,
        message: `money edited: ₱${before.total} → ₱${after.total}`,
        meta: { before, after },
      });
    }
    return row;
  });

  const full = await getBooking(updated.id);
  emit('bookings', { id, action: 'edited', booking: full, status: full.status });
  return full;
}

/** Free-text NOTE event (§6.10.3). */
export async function addNote(actor: Actor, id: number, message: string): Promise<void> {
  if (!message?.trim()) throw new TransitionError('Note text is required', 400);
  await q(
    `INSERT INTO bk_booking_events (booking_id, entity, type, message, actor_type, actor_id, actor_name)
     VALUES ($1, 'BOOKING', 'NOTE', $2, $3, $4, $5)`,
    [id, message.trim(), actor.role, actor.id, actor.name],
  );
}

/** Archive — the ONLY "delete" (§6.10.1). Row, events and ledger all survive. */
export async function archiveBooking(actor: Actor, id: number, reason?: string): Promise<any> {
  if (actor.role !== 'MANAGER') throw new TransitionError('Manager only', 403);
  const row = await q1<any>(
    `UPDATE bk_bookings SET archived_at = now(), archived_by = $2, archive_reason = $3
     WHERE id = $1 AND archived_at IS NULL RETURNING *`,
    [id, actor.id, reason ?? null],
  );
  if (!row) throw new TransitionError('Booking not found or already archived', 404);
  await q(
    `INSERT INTO bk_booking_events (booking_id, entity, type, message, actor_type, actor_id, actor_name, meta, visible_to_rider)
     VALUES ($1, 'BOOKING', 'ARCHIVED', $2, 'MANAGER', $3, 'Manager', $4, 0)`,
    [id, `archived${reason ? ` — ${reason}` : ''}`, actor.id, JSON.stringify({ reason: reason ?? null })],
  );
  emit('bookings', { id, action: 'archived', status: row.status });
  return row;
}

export async function unarchiveBooking(actor: Actor, id: number): Promise<any> {
  if (actor.role !== 'MANAGER') throw new TransitionError('Manager only', 403);
  const row = await q1<any>(
    `UPDATE bk_bookings SET archived_at = NULL, archived_by = NULL, archive_reason = NULL
     WHERE id = $1 RETURNING *`,
    [id],
  );
  if (!row) throw new TransitionError('Booking not found', 404);
  await q(
    `INSERT INTO bk_booking_events (booking_id, entity, type, message, actor_type, actor_id, actor_name, visible_to_rider)
     VALUES ($1, 'BOOKING', 'EDITED', 'unarchived', 'MANAGER', $2, 'Manager', 0)`,
    [id, actor.id],
  );
  emit('bookings', { id, action: 'unarchived', status: row.status });
  return row;
}










