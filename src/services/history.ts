/**
 * src/services/history.ts — the audit ledger for both roles (§6.10).
 *
 * Day grouping always goes through src/lib/datetime.ts (store timezone),
 * never UTC slice — the R16 regression guard.
 */
import { q, q1 } from '../db/pg';
import { storeTz } from './day';
import { dateInTz, toStoreLocal, dayBounds, timeInTz } from '../lib/datetime';

export interface HistoryFilters {
  type?: string; actor_id?: number; rider_id?: number;
  from?: string; to?: string; q?: string;
  include_internal?: boolean; page?: number; page_size?: number;
}

function buildHistoryWhere(f: HistoryFilters, params: any[], riderScope?: number): string {
  const where: string[] = ['1=1'];
  // rider scope is enforced in SQL, never by filtering in JS (§9.6)
  if (riderScope != null) {
    params.push(riderScope);
    where.push(`(e.visible_to_rider = 1 AND (
       (e.booking_id IS NOT NULL AND e.booking_id IN (
          SELECT id FROM bk_bookings WHERE assigned_rider_id = $${params.length}))
       OR (e.actor_type = 'RIDER' AND e.actor_id IN (SELECT user_id FROM bk_riders WHERE id = $${params.length}))))`);
  } else {
    if (!f.include_internal) where.push('e.visible_to_rider = 1');
  }
  if (f.type) {
    const list = f.type.split(',').map((t) => t.trim()).filter(Boolean);
    if (list.length) { params.push(list); where.push(`e.type = ANY($${params.length})`); }
  }
  if (f.actor_id) { params.push(f.actor_id); where.push(`e.actor_id = $${params.length}`); }
  if (f.rider_id) {
    params.push(f.rider_id);
    where.push(`(e.booking_id IN (SELECT id FROM bk_bookings WHERE assigned_rider_id = $${params.length})
                 OR e.actor_id IN (SELECT id FROM bk_riders WHERE id = $${params.length}))`);
  }
  if (f.from) { params.push(new Date(f.from).toISOString()); where.push(`e.created_at >= $${params.length}`); }
  if (f.to) { params.push(new Date(f.to).toISOString()); where.push(`e.created_at < $${params.length}`); }
  if (f.q) {
    params.push(`%${f.q}%`);
    where.push(`(coalesce(e.message,'') ILIKE $${params.length} OR coalesce(b.ref,'') ILIKE $${params.length}
                 OR coalesce(e.actor_name,'') ILIKE $${params.length})`);
  }
  return where.join(' AND ');
}

const HISTORY_SELECT = `
  SELECT e.id, e.booking_id, e.entity, e.type, e.message, e.actor_type, e.actor_id, e.actor_name,
         e.from_status, e.to_status, e.amount_delta, e.visible_to_rider, e.meta, e.created_at,
         b.ref, b.customer_name, b.total, b.delivery_fee, b.food_value, b.commission_amount,
         b.rider_payout, b.status AS booking_status,
         r.full_name AS rider_name
  FROM bk_booking_events e
  LEFT JOIN bk_bookings b ON b.id = e.booking_id
  LEFT JOIN bk_riders r ON r.id = b.assigned_rider_id`;

export async function managerHistory(f: HistoryFilters = {}): Promise<{ rows: any[]; total: number }> {
  const params: any[] = [];
  const where = buildHistoryWhere(f, params);
  const page = Math.max(1, Number(f.page) || 1);
  const pageSize = Math.min(Number(f.page_size) || 50, 200);
  const totalRow = await q1<{ n: number }>(
    `SELECT count(*)::int AS n FROM bk_booking_events e
     LEFT JOIN bk_bookings b ON b.id = e.booking_id WHERE ${where}`,
    params,
  );
  const rows = await q(
    `${HISTORY_SELECT} WHERE ${where} ORDER BY e.created_at DESC, e.id DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, pageSize, (page - 1) * pageSize],
  );
  const tz = await storeTz();
  return {
    rows: rows.map((r: any) => ({
      ...r,
      day: dateInTz(r.created_at, tz),
      time: timeInTz(r.created_at, tz),
      local_at: toStoreLocal(r.created_at, tz),
    })),
    total: totalRow?.n ?? 0,
  };
}

/** Rider history: own jobs incl. declined & cancelled, with reasons (§6.10.5). */
export async function riderHistory(riderId: number, opts: { all_time?: boolean } = {}): Promise<any> {
  const tz = await storeTz();
  const bounds = opts.all_time ? null : dayBounds(dateInTz(new Date().toISOString(), tz), tz);
  const params: any[] = [riderId];
  let range = '';
  if (bounds) {
    params.push(bounds.fromIso);
    range = `AND b.created_at >= $${params.length}`;
    params.push(bounds.toIso);
    range += ` AND b.created_at < $${params.length}`;
  }
  const rows = await q(
    `SELECT b.*, l.status AS ledger_status, l.amount AS ledger_amount,
            (SELECT string_agg(e.message, ' · ') FROM bk_booking_events e
              WHERE e.booking_id = b.id AND e.type IN ('DECLINED','CANCELLED')) AS exclusion_reason
     FROM bk_bookings b
     LEFT JOIN bk_commission_ledger l ON l.booking_id = b.id
     WHERE (b.assigned_rider_id = $1
            OR b.id IN (SELECT booking_id FROM bk_booking_requests WHERE rider_id = $1))
      AND b.archived_at IS NULL
      ${range}
     ORDER BY b.created_at DESC`,
    params,
  );
  const { riderEarnings } = await import('./money');
  const earnings = await riderEarnings(riderId, bounds?.fromIso, bounds?.toIso);
  return {
    bookings: rows.map((r: any) => ({ ...r, day: dateInTz(r.created_at, tz) })),
    earnings,
    today: !opts.all_time,
  };
}

/** One booking's timeline (§9.6). Rider variant filters in SQL. */
export async function timeline(bookingId: number, opts: { riderId?: number } = {}): Promise<any[]> {
  const params: any[] = [bookingId];
  let scope = '';
  if (opts.riderId != null) {
    params.push(opts.riderId);
    scope = `AND e.visible_to_rider = 1
      AND (SELECT assigned_rider_id FROM bk_bookings WHERE id = e.booking_id) = $${params.length}`;
  }
  const rows = await q(
    `SELECT e.* FROM bk_booking_events e
     WHERE e.booking_id = $1 ${scope}
     ORDER BY e.created_at ASC, e.id ASC`,
    params,
  );
  const tz = await storeTz();
  return rows.map((r: any) => ({ ...r, local_at: toStoreLocal(r.created_at, tz), time: timeInTz(r.created_at, tz) }));
}

/** CSV export — same filtered set as the on-screen ledger (§6.10.4). */
export async function historyCsv(f: HistoryFilters = {}): Promise<string> {
  const { rows } = await managerHistory({ ...f, page: 1, page_size: 10_000 });
  const esc = (v: any) => {
    const s = v == null ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const header = 'time,day,actor,action,ref,subject,detail,from_status,to_status,amount';
  const lines = rows.map((r: any) => [
    r.time, r.day, r.actor_name, r.type, r.ref ?? '', r.rider_name ?? r.customer_name ?? '',
    r.message ?? '', r.from_status ?? '', r.to_status ?? '', r.amount_delta ?? '',
  ].map(esc).join(','));
  return [header, ...lines].join('\n');
}

/** Rider CSV export — the same figures the manager sees (§6.10.5). */
export async function riderHistoryCsv(riderId: number): Promise<string> {
  const { bookings } = await riderHistory(riderId, { all_time: true });
  const esc = (v: any) => {
    const s = v == null ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const header = 'ref,status,day,total,df,food,comm_rate,comm,you,reason';
  const lines = bookings.map((b: any) => [
    b.ref, b.status, b.day, b.total, b.delivery_fee, b.food_value,
    b.commission_rate ?? '', b.commission_amount ?? '', b.rider_payout ?? '',
    b.exclusion_reason ?? b.cancel_reason ?? '',
  ].map(esc).join(','));
  return [header, ...lines].join('\n');
}

