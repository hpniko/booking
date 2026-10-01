/**
 * src/services/day.ts — ONE branch, ONE dispatch day (§6.1.1).
 *
 * The board is today. A day rolls over at `day_cutoff_hour` store-local
 * (default 4 AM), closes itself (freezing totals_snapshot), and opens the next.
 * Manual close/open uses the SAME close+open path as the 30s tick — one path,
 * one set of guards. Exactly one OPEN day exists (partial unique index).
 */
import { q, q1 } from '../db/pg';
import { getNumber, getBool, getSetting } from './settings';
import { dispatchDateInTz, nowIso, dayBounds, monthBounds, monthInTz, addDays } from '../lib/datetime';
import { emit } from './events';
import { logSystemEvent } from './chat';

export async function storeTz(): Promise<string> {
  return getSetting('store_timezone', 'Asia/Manila');
}

export async function currentDay(): Promise<any | null> {
  return q1(`SELECT * FROM bk_dispatch_days WHERE status = 'OPEN' ORDER BY id DESC LIMIT 1`);
}

/** Today's dispatch date given the cutoff — a 1:30 AM booking belongs to yesterday. */
export async function todayRef(at: Date = new Date()): Promise<string> {
  const tz = await storeTz();
  const cutoff = await getNumber('day_cutoff_hour', 4);
  return dispatchDateInTz(cutoff, tz, at);
}

export interface DayTotals {
  bookings: number; open: number; ongoing: number; done: number; cancelled: number;
  gross: number; food_value: number; commission: number; rider_payout: number;
}

/**
 * Resolve a UI period TAB ('today' | '7d' | 'month' | 'all') into store-local
 * UTC bounds (§10.6). The client sends the INTENT, never a Date it built from
 * its own clock — that is how the Messenger-bot's UTC day-boundary bug (§R16)
 * gets re-introduced. Every boundary is computed here, in the store's timezone.
 */
export type PeriodKey = 'today' | '7d' | 'month' | 'all';

export async function resolvePeriod(key: string | undefined | null): Promise<{ from?: string; to?: string }> {
  const tz = await storeTz();
  const ref = await todayRef();                     // honours day_cutoff_hour
  let bounds: { fromIso: string; toIso: string } | null = null;
  if (key === 'today') {
    bounds = dayBounds(ref, tz);                    // the dispatch day, store-local
  } else if (key === '7d') {
    // 7 days INCLUDING today: start of (ref-6) → end of today. dayBounds()
    // returns one day's start/end, so the two ends are stitched explicitly —
    // using dayBounds(ref-6) alone would silently span a single day.
    bounds = { fromIso: dayBounds(addDays(ref, -6), tz).fromIso, toIso: dayBounds(ref, tz).toIso };
  } else if (key === 'month') {
    bounds = monthBounds(monthInTz(tz), tz);
  }
  return bounds ? { from: bounds.fromIso, to: bounds.toIso } : {};
}

export async function dayTotals(dayId: number): Promise<DayTotals> {
  const row = await q1<any>(
    `SELECT count(*) FILTER (WHERE status <> 'CANCELLED') AS bookings,
            count(*) FILTER (WHERE status = 'PENDING') AS open,
            count(*) FILTER (WHERE status IN ('ASSIGNED','ACCEPTED','PICKED_UP')) AS ongoing,
            count(*) FILTER (WHERE status = 'DELIVERED') AS done,
            count(*) FILTER (WHERE status = 'CANCELLED') AS cancelled,
            coalesce(sum(total) FILTER (WHERE status <> 'CANCELLED'), 0) AS gross,
            coalesce(sum(food_value) FILTER (WHERE status <> 'CANCELLED'), 0) AS food_value,
            coalesce(sum(commission_amount) FILTER (WHERE status <> 'CANCELLED'), 0) AS commission,
            coalesce(sum(rider_payout) FILTER (WHERE status <> 'CANCELLED'), 0) AS rider_payout
     FROM bk_bookings WHERE day_id = $1 AND archived_at IS NULL`,
    [dayId],
  );
  return {
    bookings: Number(row.bookings), open: Number(row.open), ongoing: Number(row.ongoing),
    done: Number(row.done), cancelled: Number(row.cancelled), gross: Number(row.gross),
    food_value: Number(row.food_value), commission: Number(row.commission),
    rider_payout: Number(row.rider_payout),
  };
}


/** Ensure exactly one OPEN day exists — called at boot and on every rollover. */
export async function ensureOpenDay(): Promise<any> {
  const open = await currentDay();
  if (open) return open;
  const ref = await todayRef();
  try {
    const day = await q1(
      `INSERT INTO bk_dispatch_days (date_ref, status) VALUES ($1, 'OPEN')
       ON CONFLICT (date_ref) DO UPDATE SET status = 'OPEN', closed_at = NULL, closed_by = NULL
       RETURNING *`,
      [ref],
    );
    emit('day', { day });
    await logSystemEvent(`📅 Dispatch day ${ref} opened`);
    return day;
  } catch (err: any) {
    if (String(err.message).includes('one_open')) {
      const existing = await currentDay();
      if (existing) return existing;
    }
    throw err;
  }
}

export class DayError extends Error {
  status: number;
  constructor(message: string, status = 409) { super(message); this.status = status; }
}

/** Close a day and FREEZE its totals (§6.1.1). Guards: active bookings → 409. */
export async function closeDay(dayId: number, actorId: number, opts: { confirm?: string; forceByTick?: boolean } = {}): Promise<any> {
  const day = await q1<any>('SELECT * FROM bk_dispatch_days WHERE id = $1', [dayId]);
  if (!day) throw new DayError('Day not found', 404);
  if (day.status === 'CLOSED') throw new DayError('Day is already closed');
  if (!opts.forceByTick && opts.confirm !== 'CLOSE') {
    throw new DayError("Send { confirm: 'CLOSE' } to freeze this day's totals", 400);
  }
  const active = await q1<{ n: number }>(
    `SELECT count(*)::int AS n FROM bk_bookings
     WHERE day_id = $1 AND status IN ('PENDING','ASSIGNED','ACCEPTED','PICKED_UP') AND archived_at IS NULL`,
    [dayId],
  );
  if (active && active.n > 0) {
    throw new DayError(`${active.n} booking(s) still in progress — finish or cancel them first`);
  }
  const totals = await dayTotals(dayId);
  const closed = await q1<any>(
    `UPDATE bk_dispatch_days SET status = 'CLOSED', closed_at = now(), closed_by = $2, totals_snapshot = $3
     WHERE id = $1 RETURNING *`,
    [dayId, actorId, JSON.stringify(totals)],
  );
  await q(
    `INSERT INTO bk_booking_events (entity, type, message, actor_type, actor_id, actor_name, meta, visible_to_rider)
     VALUES ('DAY', 'DAY_CLOSED', $1, 'MANAGER', $2, 'Manager', $3, 0)`,
    [`Day ${day.date_ref} closed — frozen totals`, actorId, JSON.stringify(totals)],
  );
  await logSystemEvent(`🔒 Dispatch day ${day.date_ref} closed — totals frozen`);
  emit('day', { day: closed, action: 'closed' });
  return closed;
}

/** Manual close of today's open day — the SAME path the ticker uses. */
export async function closeCurrentDay(actorId: number, confirm: string): Promise<any> {
  const open = await currentDay();
  if (!open) throw new DayError('No open day', 404);
  return closeDay(open.id, actorId, { confirm });
}

export async function openDay(dateRef: string | undefined, actorId: number): Promise<any> {
  const existingOpen = await currentDay();
  if (existingOpen) throw new DayError('A day is already open — close it first');
  const ref = dateRef ?? await todayRef();
  const day = await q1<any>(
    `INSERT INTO bk_dispatch_days (date_ref, status) VALUES ($1, 'OPEN')
     ON CONFLICT (date_ref) DO UPDATE SET status = 'OPEN', closed_at = NULL, closed_by = NULL
     RETURNING *`,
    [ref],
  );
  await q(
    `INSERT INTO bk_booking_events (entity, type, message, actor_type, actor_id, actor_name, visible_to_rider)
     VALUES ('DAY', 'DAY_OPENED', $1, 'MANAGER', $2, 'Manager', 0)`,
    [`Day ${ref} opened manually`, actorId],
  );
  emit('day', { day, action: 'opened' });
  return day;
}

/** Reopen a day closed < 2h ago — logged, because it changes a reported figure (§9.8). */
export async function reopenDay(dayId: number, actorId: number): Promise<any> {
  const day = await q1<any>('SELECT * FROM bk_dispatch_days WHERE id = $1', [dayId]);
  if (!day) throw new DayError('Day not found', 404);
  if (day.status !== 'CLOSED') throw new DayError('Day is not closed');
  if (!day.closed_at || Date.now() - new Date(day.closed_at).getTime() > 2 * 60 * 60 * 1000) {
    throw new DayError('Only a day closed within the last 2 hours can be reopened');
  }
  const open = await currentDay();
  if (open) throw new DayError('Another day is open — close it first');
  const reopened = await q1<any>(
    `UPDATE bk_dispatch_days SET status = 'OPEN', closed_at = NULL, closed_by = NULL, totals_snapshot = NULL
     WHERE id = $1 RETURNING *`,
    [dayId],
  );
  await q(
    `INSERT INTO bk_booking_events (entity, type, message, actor_type, actor_id, actor_name, visible_to_rider)
     VALUES ('DAY', 'DAY_OPENED', $1, 'MANAGER', $2, 'Manager', 0)`,
    [`Day ${day.date_ref} REOPENED — a frozen figure changed`, actorId],
  );
  emit('day', { day: reopened, action: 'reopened' });
  return reopened;
}

/**
 * 30s tick: if the open day has passed its cutoff (and auto_rollover is on),
 * close it (freezing totals) and open the next — the SAME close+open code the
 * manual button uses (§6.1.1).
 */
export function startDayTicker(intervalMs = 30_000): NodeJS.Timeout {
  const tick = async () => {
    try {
      if (!(await getBool('auto_rollover', true))) return;
      const open = await currentDay();
      if (!open) { await ensureOpenDay(); return; }
      const ref = await todayRef();
      if (open.date_ref >= ref) return; // still today
      const totals = await dayTotals(open.id);
      await q(
        `UPDATE bk_dispatch_days SET status = 'CLOSED', closed_at = now(), totals_snapshot = $2 WHERE id = $1`,
        [open.id, JSON.stringify(totals)],
      );
      await q(
        `INSERT INTO bk_booking_events (entity, type, message, actor_type, actor_name, meta, visible_to_rider)
         VALUES ('DAY', 'DAY_CLOSED', $1, 'SYSTEM', 'System', $2, 0)`,
        [`Day ${open.date_ref} auto-closed at cutoff`, JSON.stringify(totals)],
      );
      emit('day', { action: 'closed', date_ref: open.date_ref });
      await logSystemEvent(`🌙 Day ${open.date_ref} closed — totals frozen`);
      const next = await ensureOpenDay();
      await logSystemEvent(`🌅 New dispatch day ${next.date_ref}`);
      console.log(`[day] rollover ${open.date_ref} → ${next.date_ref}`);
    } catch (err: any) {
      console.error('[day] ticker error:', err.message);
    }
  };
  const t = setInterval(tick, intervalMs);
  t.unref?.();
  return t;
}

export { nowIso };


