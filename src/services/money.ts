/**
 * src/services/money.ts — every peso in the system (§6.9).
 *
 * Nothing else computes money. computeSplit() in lib/money.ts is the only
 * function that turns numbers into pesos; this module persists the split,
 * accrues the ledger on delivery, and aggregates earnings in SQL.
 */
import { q, q1 } from '../db/pg';
import { computeSplit, Split } from '../lib/money';
import { currentRate } from './settings';
import { monthInTz } from '../lib/datetime';
import { storeTz } from './day';

export { computeSplit };

export interface Queryish {
  query: (text: string, params?: any[]) => Promise<any>;
}

/** Write food_value + commission_amount + rider_payout on the booking (§6.6.2). */
export async function applySplit(client: Queryish, bookingId: number, total: number, deliveryFee: number, rate: number): Promise<Split> {
  const s = computeSplit(total, deliveryFee, rate);
  await client.query(
    `UPDATE bk_bookings
     SET commission_rate = $2, food_value = $3, commission_amount = $4, rider_payout = $5, updated_at = now()
     WHERE id = $1`,
    [bookingId, s.rate, s.foodValue, s.commission, s.riderPayout],
  );
  return s;
}

/**
 * After a decline the job reopens at the CURRENT rate — a re-dispatch is a
 * new deal (§6.6.2). Never runs on a DELIVERED booking (no /reprice exists).
 */
export async function repriceOnRedispatch(bookingId: number): Promise<void> {
  const b = await q1<any>('SELECT total, delivery_fee, status FROM bk_bookings WHERE id = $1', [bookingId]);
  if (!b || b.status !== 'PENDING') return;
  const rate = await currentRate();
  await applySplit({ query: (t, p) => q(t, p) }, bookingId, b.total, b.delivery_fee, rate);
}

/**
 * DELIVERED → write the commission_ledger row in the SAME transaction (§6.4,
 * §6.6.2). Unique index on booking_id makes double-accrual impossible (R13).
 */
export async function accrueOnDelivery(client: Queryish, booking: any): Promise<void> {
  const tz = await storeTz();
  await client.query(
    `INSERT INTO bk_commission_ledger (booking_id, rider_id, amount, basis_food, rate, day_id, period, status, note)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'ACCRUED', $8)
     ON CONFLICT (booking_id) DO NOTHING`,
    [
      booking.id, booking.assigned_rider_id, booking.commission_amount, booking.food_value,
      booking.commission_rate ?? 0, booking.day_id, monthInTz(tz),
      `delivered ${booking.ref}`,
    ],
  );
}

/** Cancel → VOID any ledger row (§6.6.2). */
export async function voidLedgerForBooking(client: Queryish, bookingId: number): Promise<void> {
  await client.query(
    `UPDATE bk_commission_ledger SET status = 'VOID', note = coalesce(note,'') || ' [voided on cancel]'
     WHERE booking_id = $1 AND status <> 'VOID'`,
    [bookingId],
  );
}

export interface Earnings {
  earned: number; paid: number; owed: number;
  delivered: number; active: number; declined: number; cancelled: number;
  avg_per_job: number; total_value: number; commission_total: number;
}

function timeBounds(from?: string, to?: string): { from: string | null; to: string | null } {
  return {
    from: from ? new Date(from).toISOString() : null,
    to: to ? new Date(to).toISOString() : null,
  };
}

/** EARNED / PAID / OWED — three separate numbers (§6.6.3). Sums done in SQL. */
export async function riderEarnings(riderId: number, from?: string, to?: string): Promise<Earnings> {
  const b = timeBounds(from, to);
  const earnedRow = await q1<any>(
    `SELECT coalesce(sum(amount), 0) AS earned, count(*) AS delivered
     FROM bk_commission_ledger
     WHERE rider_id = $1 AND status = 'ACCRUED'
       AND ($2::timestamptz IS NULL OR created_at >= $2)
       AND ($3::timestamptz IS NULL OR created_at < $3)`,
    [riderId, b.from, b.to],
  );
  const paidRow = await q1<any>(
    `SELECT coalesce(sum(amount), 0) AS paid FROM bk_rider_payouts
     WHERE rider_id = $1 AND is_void = 0
       AND ($2::timestamptz IS NULL OR created_at >= $2)
       AND ($3::timestamptz IS NULL OR created_at < $3)`,
    [riderId, b.from, b.to],
  );
  const counts = await q1<any>(
    `SELECT count(*) FILTER (WHERE status IN ('ASSIGNED','ACCEPTED','PICKED_UP')) AS active
     FROM bk_bookings WHERE assigned_rider_id = $1 AND archived_at IS NULL`,
    [riderId],
  );
  const hist = await q1<any>(
    `SELECT count(*) FILTER (WHERE e.type = 'DECLINED') AS declined,
            count(*) FILTER (WHERE e.type = 'CANCELLED' AND e.actor_type = 'MANAGER') AS cancelled
     FROM bk_booking_events e
     JOIN bk_bookings b2 ON b2.id = e.booking_id
     WHERE b2.assigned_rider_id = $1`,
    [riderId],
  );
  const valueRow = await q1<any>(
    `SELECT coalesce(sum(total), 0) AS total_value, coalesce(sum(commission_amount), 0) AS commission_total
     FROM bk_bookings
     WHERE assigned_rider_id = $1 AND status <> 'CANCELLED' AND archived_at IS NULL
       AND ($2::timestamptz IS NULL OR created_at >= $2)
       AND ($3::timestamptz IS NULL OR created_at < $3)`,
    [riderId, b.from, b.to],
  );
  const earned = Number(earnedRow?.earned ?? 0);
  const paid = Number(paidRow?.paid ?? 0);
  const delivered = Number(earnedRow?.delivered ?? 0);
  return {
    earned, paid, owed: earned - paid, delivered,
    active: Number(counts?.active ?? 0),
    declined: Number(hist?.declined ?? 0),
    cancelled: Number(hist?.cancelled ?? 0),
    avg_per_job: delivered > 0 ? Math.round(earned / delivered) : 0,
    total_value: Number(valueRow?.total_value ?? 0),
    commission_total: Number(valueRow?.commission_total ?? 0),
  };
}

/** The per-booking money table under the period tabs (§6.7). */
export async function riderLedgerRows(riderId: number, from?: string, to?: string, limit = 100): Promise<any[]> {
  const b = timeBounds(from, to);
  return q(
    `SELECT bk.id, bk.ref, bk.status, bk.created_at, bk.delivered_at, bk.customer_name,
            bk.total, bk.delivery_fee, bk.food_value, bk.commission_rate, bk.commission_amount, bk.rider_payout,
            l.status AS ledger_status, l.amount AS ledger_amount
     FROM bk_bookings bk
     LEFT JOIN bk_commission_ledger l ON l.booking_id = bk.id
     WHERE bk.assigned_rider_id = $1 AND bk.archived_at IS NULL
       AND ($2::timestamptz IS NULL OR bk.created_at >= $2)
       AND ($3::timestamptz IS NULL OR bk.created_at < $3)
     ORDER BY bk.created_at DESC
     LIMIT $4`,
    [riderId, b.from, b.to, limit],
  );
}

export interface PayoutInput {
  amount: number; method?: string; reference?: string;
  period_from?: string; period_to?: string; note?: string; booking_ids?: number[];
}

/**
 * Insert a payout and flip covered ledger rows ACCRUED → PAID in ONE
 * transaction (R13). OWED = EARNED − PAID is recomputed on every read.
 */
export async function recordPayout(riderId: number, input: PayoutInput, actorId: number): Promise<any> {
  const amount = Math.round(Number(input.amount));
  if (!Number.isFinite(amount) || amount <= 0) {
    throw Object.assign(new Error('Payout amount must be positive'), { status: 400 });
  }
  const { tx } = await import('../db/pg');
  return tx(async (client) => {
    const payout = (await client.query(
      `INSERT INTO bk_rider_payouts (rider_id, amount, method, reference, period_from, period_to, note, booking_ids, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
      [
        riderId, amount, (input.method || 'CASH').toUpperCase(), input.reference ?? null,
        input.period_from ?? null, input.period_to ?? null, input.note ?? null,
        input.booking_ids ? JSON.stringify(input.booking_ids) : null, actorId,
      ],
    )).rows[0];

    await client.query(
      `WITH unpaid AS (
         SELECT id, amount, created_at FROM bk_commission_ledger
         WHERE rider_id = $1 AND status = 'ACCRUED'
         ORDER BY created_at
         FOR UPDATE SKIP LOCKED
       ), running AS (
         SELECT id, sum(amount) OVER (ORDER BY created_at) AS cum FROM unpaid
       )
       UPDATE bk_commission_ledger l SET status = 'PAID', paid_at = now()
       FROM running r WHERE l.id = r.id AND r.cum <= $2`,
      [riderId, amount],
    );

    const nameRow = await client.query('SELECT full_name FROM bk_riders WHERE id = $1', [riderId]);
    const name = nameRow.rows[0]?.full_name ?? 'rider';
    await client.query(
      `INSERT INTO bk_booking_events (entity, type, message, actor_type, actor_id, actor_name, amount_delta, meta, visible_to_rider)
       VALUES ('PAYOUT', 'PAYOUT_RECORDED', $1, 'MANAGER', $2, 'Manager', $3, $4, 1)`,
      [`Payout ₱${amount} to ${name}`, actorId, amount, JSON.stringify({ payout_id: payout.id, rider_id: riderId })],
    );
    return payout;
  });
}

/** Reverse a payout — never deletes it; OWED re-opens (§6.10.6). */
export async function voidPayout(payoutId: number, reason: string, actorId: number): Promise<any> {
  const { tx } = await import('../db/pg');
  return tx(async (client) => {
    const p = (await client.query('SELECT * FROM bk_rider_payouts WHERE id = $1 FOR UPDATE', [payoutId])).rows[0];
    if (!p) throw Object.assign(new Error('Payout not found'), { status: 404 });
    if (p.is_void) throw Object.assign(new Error('Payout is already void'), { status: 409 });
    const updated = (await client.query(
      'UPDATE bk_rider_payouts SET is_void = 1, void_reason = $2, voided_at = now() WHERE id = $1 RETURNING *',
      [payoutId, reason || 'voided'],
    )).rows[0];
    await client.query(
      `WITH paid AS (
         SELECT id, amount, paid_at, created_at FROM bk_commission_ledger
         WHERE rider_id = $1 AND status = 'PAID'
         ORDER BY paid_at DESC NULLS LAST, created_at DESC
         FOR UPDATE SKIP LOCKED
       ), running AS (
         SELECT id, sum(amount) OVER (ORDER BY created_at DESC) AS cum FROM paid
       )
       UPDATE bk_commission_ledger l SET status = 'ACCRUED', paid_at = NULL
       FROM running r WHERE l.id = r.id AND r.cum <= $2`,
      [p.rider_id, p.amount],
    );
    await client.query(
      `INSERT INTO bk_booking_events (entity, type, message, actor_type, actor_id, actor_name, amount_delta, meta, visible_to_rider)
       VALUES ('PAYOUT', 'PAYOUT_VOIDED', $1, 'MANAGER', $2, 'Manager', $3, $4, 1)`,
      [`Payout ₱${p.amount} voided: ${reason}`, actorId, -p.amount, JSON.stringify({ payout_id: payoutId })],
    );
    return updated;
  });
}

export async function riderPayouts(riderId: number, limit = 50): Promise<any[]> {
  return q(
    'SELECT * FROM bk_rider_payouts WHERE rider_id = $1 ORDER BY created_at DESC LIMIT $2',
    [riderId, limit],
  );
}

/**
 * The manager's own commission: ACCRUED / PAID / UNPAID + per-rider split (§9.5).
 * Aggregation in SQL — never rows-into-Node.
 */
export async function managerCommission(from?: string, to?: string): Promise<any> {
  const b = timeBounds(from, to);
  const summary = await q1<any>(
    `SELECT coalesce(sum(amount) FILTER (WHERE status = 'ACCRUED'), 0) AS accrued,
            coalesce(sum(amount) FILTER (WHERE status = 'PAID'), 0)    AS paid,
            count(*) FILTER (WHERE status = 'ACCRUED')                 AS jobs
     FROM bk_commission_ledger
     WHERE ($1::timestamptz IS NULL OR created_at >= $1)
       AND ($2::timestamptz IS NULL OR created_at < $2)`,
    [b.from, b.to],
  );
  const byRider = await q(
    `SELECT l.rider_id, r.full_name,
            sum(l.amount) FILTER (WHERE l.status = 'ACCRUED') AS accrued,
            sum(l.amount) FILTER (WHERE l.status = 'PAID')    AS paid,
            count(*) AS jobs
     FROM bk_commission_ledger l
     LEFT JOIN bk_riders r ON r.id = l.rider_id
     WHERE ($1::timestamptz IS NULL OR l.created_at >= $1)
       AND ($2::timestamptz IS NULL OR l.created_at < $2)
     GROUP BY l.rider_id, r.full_name
     ORDER BY accrued DESC NULLS LAST`,
    [b.from, b.to],
  );
  const accrued = Number(summary?.accrued ?? 0);
  const paid = Number(summary?.paid ?? 0);
  return {
    accrued, paid, unpaid: accrued - paid, jobs: Number(summary?.jobs ?? 0),
    by_rider: byRider.map((r: any) => ({
      rider_id: r.rider_id, full_name: r.full_name,
      accrued: Number(r.accrued ?? 0), paid: Number(r.paid ?? 0), jobs: Number(r.jobs),
    })),
  };
}



