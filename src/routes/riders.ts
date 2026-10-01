/**
 * src/routes/riders.ts — manager roster CRUD (§9.9).
 */
import { Router } from 'express';
import { requireAuth, requireManager } from '../services/auth';
import {
  registerRider, updateRider, toggleActive, resetPassword, riderStats, rosterWithMoney,
} from '../services/riders';
import { riderEarnings, riderLedgerRows, riderPayouts } from '../services/money';
import { handle } from './bookings';
import { period } from './money';

export const ridersRouter = Router();
ridersRouter.use(requireAuth, requireManager);

ridersRouter.get('/riders', async (_req, res) => {
  try { res.json(await rosterWithMoney()); } catch (err: any) { handle(err, res); }
});

ridersRouter.post('/riders', async (req, res) => {
  try { res.status(201).json(await registerRider(req.user!.id, req.body ?? {})); }
  catch (err: any) { handle(err, res); }
});

ridersRouter.put('/riders/:id', async (req, res) => {
  try { res.json(await updateRider(req.user!.id, Number(req.params.id), req.body ?? {})); }
  catch (err: any) { handle(err, res); }
});

ridersRouter.post('/riders/:id/toggle-active', async (req, res) => {
  try { res.json(await toggleActive(req.user!.id, Number(req.params.id))); }
  catch (err: any) { handle(err, res); }
});

ridersRouter.post('/riders/:id/reset-password', async (req, res) => {
  try { res.json(await resetPassword(req.user!.id, Number(req.params.id))); }
  catch (err: any) { handle(err, res); }
});

ridersRouter.get('/riders/:id/stats', async (req, res) => {
  try { res.json(await riderStats(Number(req.params.id))); } catch (err: any) { handle(err, res); }
});

/** The money screen's data (§6.7) — earnings + ledger + payouts in one call. */
ridersRouter.get('/riders/:id/money', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const { from, to } = await period(req);
    const [earnings, ledger, payouts, stats] = await Promise.all([
      riderEarnings(id, from, to),
      riderLedgerRows(id, from, to),
      riderPayouts(id),
      riderStats(id),
    ]);
    res.json({ earnings, ledger, payouts, stats, period: { from: from ?? null, to: to ?? null } });
  } catch (err: any) { handle(err, res); }
});
