/**
 * src/routes/history.ts — audit ledger for both roles (§9.6).
 * Rider timeline privacy is enforced in SQL, not JS.
 */
import { Router } from 'express';
import { requireAuth, requireManager, requireRider } from '../services/auth';
import {
  managerHistory, historyCsv, riderHistory, riderHistoryCsv, timeline,
} from '../services/history';
import { handle } from './bookings';

export const historyRouter = Router();      // /api/manager/*
export const riderHistoryRouter = Router(); // /api/rider/*

historyRouter.use(requireAuth, requireManager);
riderHistoryRouter.use(requireAuth, requireRider);

historyRouter.get('/history', async (req, res) => {
  try {
    const g = req.query as any;
    const out = await managerHistory({
      type: g.type, actor_id: g.actor_id ? Number(g.actor_id) : undefined,
      rider_id: g.rider_id ? Number(g.rider_id) : undefined,
      from: g.from, to: g.to, q: g.q,
      include_internal: g.include_internal === '1',
      page: g.page ? Number(g.page) : 1,
      page_size: g.page_size ? Number(g.page_size) : 50,
    });
    res.json(out);
  } catch (err: any) { handle(err, res); }
});

historyRouter.get('/history.csv', async (req, res) => {
  try {
    const g = req.query as any;
    const csv = await historyCsv({
      type: g.type, actor_id: g.actor_id ? Number(g.actor_id) : undefined,
      rider_id: g.rider_id ? Number(g.rider_id) : undefined,
      from: g.from, to: g.to, q: g.q, include_internal: true,
    });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="booking-history.csv"');
    res.send(csv);
  } catch (err: any) { handle(err, res); }
});

// ── rider history (§6.10.5) ───────────────────────────────────────────────────
riderHistoryRouter.get('/history', async (req, res) => {
  try {
    res.json(await riderHistory(req.user!.rider_id!, { all_time: req.query.all_time === '1' }));
  } catch (err: any) { handle(err, res); }
});

riderHistoryRouter.get('/history.csv', async (req, res) => {
  try {
    const csv = await riderHistoryCsv(req.user!.rider_id!);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="my-history.csv"');
    res.send(csv);
  } catch (err: any) { handle(err, res); }
});

riderHistoryRouter.get('/bookings/:id/timeline', async (req, res) => {
  try {
    // the booking itself must be theirs, else 404 — checked inside timeline's SQL
    const rows = await timeline(Number(req.params.id), { riderId: req.user!.rider_id! });
    if (!rows.length) { res.status(404).json({ error: 'Job not found' }); return; }
    res.json(rows);
  } catch (err: any) { handle(err, res); }
});
