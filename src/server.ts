/**
 * src/server.ts — bootstrap: rate limiters, static SPA, /api mount, health,
 * presence sweep, day ticker.
 *
 * Boundary (§0): this server never imports from, calls, or modifies the
 * Messenger-bot. Shared: the Supabase project only, and only via bk_* tables.
 */
import 'dotenv/config';
import express from 'express';
import rateLimit from 'express-rate-limit';
import * as path from 'path';
import * as fs from 'fs';
import { migrate } from './db/migrate';
import { jwtSecret } from './services/auth';
import { startPresenceSweep } from './services/presence';
import { startDayTicker, ensureOpenDay } from './services/day';
import { eventClientCount } from './services/events';
import { pushConfigured } from './services/push';

import { authRouter } from './routes/auth';
import { managerBookingsRouter, riderBookingsRouter } from './routes/bookings';
import { moneyRouter, riderMoneyRouter } from './routes/money';
import { historyRouter, riderHistoryRouter } from './routes/history';
import { chatRouter } from './routes/chat';
import { ridersRouter } from './routes/riders';
import { sharedRouter, managerMiscRouter, riderMiscRouter } from './routes/config';

const PORT = Number(process.env.PORT) || 3100;
const APP_VERSION = '1.0.0';

async function main(): Promise<void> {
  // hard requirement: refuse to boot without a real secret (§7.1)
  jwtSecret();

  await migrate();
  try { await ensureOpenDay(); } catch (err: any) {
    console.error('[boot] could not open dispatch day:', err.message);
  }

  const app = express();
  app.set('trust proxy', 1);
  app.use(express.json({ limit: '1mb' }));

  // ── rate limiters (mirrors Messenger-bot's server.ts pattern, §3.1) ─────────
  const loginLimiter = rateLimit({ windowMs: 15 * 60_000, limit: 20, standardHeaders: true, legacyHeaders: false });
  const apiLimiter = rateLimit({ windowMs: 60_000, limit: 300, standardHeaders: true, legacyHeaders: false });

  // ── health (§15.1 smoke test) ───────────────────────────────────────────────
  app.get('/health', (_req, res) => {
    res.json({
      ok: true, app: 'postre-booking', version: APP_VERSION,
      sse_clients: eventClientCount(),
      push: pushConfigured(),
      at: new Date().toISOString(),
    });
  });

  // ── API ─────────────────────────────────────────────────────────────────────
  app.use('/api/login/manager', loginLimiter);
  app.use('/api/login/rider', loginLimiter);
  app.use('/api', apiLimiter);
  app.use('/api', authRouter);
  app.use('/api', sharedRouter);
  app.use('/api/chat', chatRouter);
  app.use('/api/manager', managerBookingsRouter);
  app.use('/api/manager', moneyRouter);
  app.use('/api/manager', historyRouter);
  app.use('/api/manager', ridersRouter);
  app.use('/api/manager', managerMiscRouter);
  app.use('/api/rider', riderBookingsRouter);
  app.use('/api/rider', riderMoneyRouter);
  app.use('/api/rider', riderHistoryRouter);
  app.use('/api/rider', riderMiscRouter);

  // ── static SPA (our own public/ — no build step for the frontend) ───────────
  const publicDir = path.join(__dirname, '..', 'public');
  const distPublic = path.join(__dirname, 'public');
  const staticDir = fs.existsSync(distPublic) ? distPublic : publicDir;
  app.use(express.static(staticDir, {
    setHeaders: (res, p) => {
      if (p.endsWith('sw.js')) res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Service-Worker-Allowed', '/');
    },
  }));
  app.get(/^\/(?!api).*/, (_req, res) => {
    res.sendFile(path.join(staticDir, 'index.html'));
  });

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    console.error('[api] unhandled:', err);
    res.status(err.status || 500).json({ error: err.message || 'Server error' });
  });

  app.listen(PORT, () => {
    console.log(`[server] postre-booking v${APP_VERSION} on http://localhost:${PORT}`);
    console.log(`[server] push: ${pushConfigured() ? 'configured' : 'off (no BK_VAPID_* set)'}`);
    startPresenceSweep(Number(process.env.BK_SWEEP_MS) || 30_000);
    startDayTicker(Number(process.env.BK_DAY_TICK_MS) || 30_000);
  });
}

main().catch((err) => {
  console.error('[server] fatal:', err);
  process.exit(1);
});
