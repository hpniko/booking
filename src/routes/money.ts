/**
 * src/routes/money.ts — earnings, payouts, commission, settings (§9.5).
 * Rider earnings are ownership-filtered in SQL — no client rider_id trusted.
 */
import { Router } from 'express';
import { requireAuth, requireManager, requireRider } from '../services/auth';
import {
  riderEarnings, riderLedgerRows, recordPayout, voidPayout, riderPayouts, managerCommission,
} from '../services/money';
import { q, q1 } from '../db/pg';
import {
  allSettings, setSetting, getSetting, logSettingChange,
  BOOKING_SETTING_KEYS, currentRate,
} from '../services/settings';
import { resolvePeriod } from '../services/day';
import { emit } from '../services/events';
import { logSystemEvent } from '../services/chat';
import { handle } from './bookings';

export const moneyRouter = Router();      // /api/manager/*
export const riderMoneyRouter = Router(); // /api/rider/*

moneyRouter.use(requireAuth, requireManager);
riderMoneyRouter.use(requireAuth, requireRider);

/**
 * Money range from the query. `?period=today|7d|month|all` is the PREFERRED
 * form: the client states the intent and the SERVER resolves the boundaries in
 * the store's timezone (§R16). Explicit `from`/`to` still work for CSV callers.
 */
async function period(req: any): Promise<{ from?: string; to?: string }> {
  const key = req.query.period ? String(req.query.period) : '';
  if (key) return resolvePeriod(key);
  return {
    from: req.query.from ? String(req.query.from) : undefined,
    to: req.query.to ? String(req.query.to) : undefined,
  };
}

/** Exported so the riders aggregate (/riders/:id/money) resolves periods identically. */
export { period };

// ── manager: per-rider money ──────────────────────────────────────────────────
moneyRouter.get('/riders/:id/earnings', async (req, res) => {
  try {
    const { from, to } = await period(req);
    res.json(await riderEarnings(Number(req.params.id), from, to));
  }
  catch (err: any) { handle(err, res); }
});

moneyRouter.get('/riders/:id/ledger', async (req, res) => {
  try {
    const { from, to } = await period(req);
    res.json(await riderLedgerRows(Number(req.params.id), from, to, Number(req.query.limit) || 100));
  } catch (err: any) { handle(err, res); }
});

moneyRouter.get('/riders/:id/earnings.csv', async (req, res) => {
  try {
    const { from, to } = await period(req);
    const rows = await riderLedgerRows(Number(req.params.id), from, to, 10_000);
    const esc = (v: any) => {
      const s = v == null ? '' : String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const csv = [
      'ref,status,date,total,df,food,comm_rate,comm,you,ledger',
      ...rows.map((r: any) => [
        r.ref, r.status, r.created_at, r.total, r.delivery_fee, r.food_value,
        r.commission_rate ?? '', r.commission_amount, r.rider_payout, r.ledger_status ?? '',
      ].map(esc).join(',')),
    ].join('\n');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="rider-${req.params.id}-earnings.csv"`);
    res.send(csv);
  } catch (err: any) { handle(err, res); }
});

moneyRouter.post('/riders/:id/payouts', async (req, res) => {
  try {
    const payout = await recordPayout(Number(req.params.id), req.body ?? {}, req.user!.id);
    void logSystemEvent(`💵 Payout ₱${payout.amount} recorded`);
    emit('riders', { action: 'payout', rider_id: Number(req.params.id) });
    res.status(201).json(payout);
  } catch (err: any) { handle(err, res); }
});

moneyRouter.get('/riders/:id/payouts', async (req, res) => {
  try { res.json(await riderPayouts(Number(req.params.id))); } catch (err: any) { handle(err, res); }
});

moneyRouter.post('/payouts/:id/void', async (req, res) => {
  try {
    const p = await voidPayout(Number(req.params.id), String(req.body?.reason ?? ''), req.user!.id);
    emit('riders', { action: 'payout_void', rider_id: p.rider_id });
    res.json(p);
  } catch (err: any) { handle(err, res); }
});

moneyRouter.get('/commission', async (req, res) => {
  try {
    const { from, to } = await period(req);
    res.json(await managerCommission(from, to));
  }
  catch (err: any) { handle(err, res); }
});

// POST + PATCH share one handler — new bookings only, past earnings never rewritten.
moneyRouter.post('/commission', async (req, res) => {
  try {
    const rate = req.body?.rate != null ? Number(req.body.rate) : undefined;
    if (rate === undefined || !Number.isFinite(rate) || rate < 0 || rate > 100) {
      res.status(400).json({ error: 'Rate must be between 0 and 100' });
      return;
    }
    const actor = { id: req.user!.id, name: req.user!.full_name };
    const oldRate = await getSetting('commission_rate', '15');
    if (String(rate) !== oldRate) {
      await setSetting('commission_rate', String(rate));
      await logSettingChange('commission_rate', `${oldRate}%`, `${rate}%`, actor);
      await logSystemEvent(`⚙️ Commission is now ${rate}% — applies to new bookings`);
    }
    res.json({ rate: await currentRate() });
  } catch (err: any) { handle(err, res); }
});

// ── settings (§6.8) — whitelisted keys only, applied with no redeploy ─────────
moneyRouter.get('/settings', async (_req, res) => {
  try {
    const all = await allSettings();
    const out: Record<string, string> = {};
    for (const k of BOOKING_SETTING_KEYS) out[k] = all[k] ?? '';
    res.json(out);
  } catch (err: any) { handle(err, res); }
});

moneyRouter.put('/settings/commission', async (req, res) => {
  try {
    const rate = req.body?.rate != null ? Number(req.body.rate) : undefined;
    const enabled = req.body?.enabled;
    if (rate !== undefined && (!Number.isFinite(rate) || rate < 0 || rate > 100)) {
      res.status(400).json({ error: 'Rate must be between 0 and 100' });
      return;
    }
    const actor = { id: req.user!.id, name: req.user!.full_name };
    const oldRate = await getSetting('commission_rate', '15');
    const oldEnabled = await getSetting('booking_commission_enabled', '1');
    if (rate !== undefined && String(rate) !== oldRate) {
      await setSetting('commission_rate', String(rate));
      await logSettingChange('commission_rate', `${oldRate}%`, `${rate}%`, actor);
      const snapshotted = await q1<{ n: number }>(
        `SELECT count(*)::int AS n FROM bk_bookings WHERE commission_rate = $1`,
        [Number(oldRate)],
      );
      await q(
        `INSERT INTO bk_booking_events (entity, type, message, actor_type, actor_id, actor_name, meta, visible_to_rider)
         VALUES ('SETTING', 'COMMISSION_RATE_CHANGED', $1, 'MANAGER', $2, $3, $4, 0)`,
        [`Rate ${oldRate}% → ${rate}% — new bookings only · ${snapshotted?.n ?? 0} already at ${oldRate}%`,
         actor.id, actor.name, JSON.stringify({ from: oldRate, to: rate, snapshotted: snapshotted?.n ?? 0 })],
      );
      await logSystemEvent(`⚙️ Commission is now ${rate}% — applies to new bookings`);
    }
    if (enabled !== undefined && String(enabled ? 1 : 0) !== oldEnabled) {
      await setSetting('booking_commission_enabled', enabled ? '1' : '0');
      await logSettingChange('booking_commission_enabled', oldEnabled, enabled ? '1' : '0', actor);
    }
    res.json({
      rate: await currentRate(),
      enabled: (await getSetting('booking_commission_enabled', '1')) === '1',
      note: 'Applies to new bookings only — past earnings are never rewritten (no /reprice endpoint exists)',
    });
  } catch (err: any) { handle(err, res); }
});

moneyRouter.put('/settings/:key', async (req, res) => {
  try {
    const key = req.params.key;
    const value = String(req.body?.value ?? '');
    const oldValue = await getSetting(key, '');
    await setSetting(key, value); // throws 400 on unknown key
    await logSettingChange(key, oldValue, value, { id: req.user!.id, name: req.user!.full_name });
    emit('session', { settings_changed: key });
    res.json({ key, value });
  } catch (err: any) { handle(err, res); }
});

// ── rider: own earnings only, hard-scoped in SQL (§12) ────────────────────────
riderMoneyRouter.get('/earnings', async (req, res) => {
  try {
    const { from, to } = await period(req);
    res.json(await riderEarnings(req.user!.rider_id!, from, to));
  } catch (err: any) { handle(err, res); }
});

riderMoneyRouter.get('/ledger', async (req, res) => {
  try {
    const { from, to } = await period(req);
    res.json(await riderLedgerRows(req.user!.rider_id!, from, to));
  } catch (err: any) { handle(err, res); }
});

riderMoneyRouter.get('/payouts', async (req, res) => {
  try { res.json(await riderPayouts(req.user!.rider_id!)); } catch (err: any) { handle(err, res); }
});

/** A payout REQUEST — does not create a payout; the manager records it (§9.6). */
riderMoneyRouter.post('/payouts/request', async (req, res) => {
  try {
    const amount = Math.round(Number(req.body?.amount));
    if (!Number.isFinite(amount) || amount <= 0) {
      res.status(400).json({ error: 'Amount must be positive' }); return;
    }
    const riderId = req.user!.rider_id!;
    const row = await q1<any>(
      `INSERT INTO bk_booking_events (entity, type, message, actor_type, actor_id, actor_name, amount_delta, meta, visible_to_rider)
       VALUES ('PAYOUT', 'NOTE', $1, 'RIDER', $2, $3, $4, $5, 0) RETURNING *`,
      [`payout requested: ₱${amount}${req.body?.note ? ` — ${req.body.note}` : ''}`,
       req.user!.id, req.user!.full_name, amount, JSON.stringify({ rider_id: riderId, requested: true })],
    );
    emit('riders', { action: 'payout_requested', rider_id: riderId });
    res.status(201).json(row);
  } catch (err: any) { handle(err, res); }
});


