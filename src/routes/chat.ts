/**
 * src/routes/chat.ts — the shared room (§9.7).
 * chatLimiter: 10 msgs / 30s per user, enforced here (§6.11.5).
 */
import { Router, Request, Response, NextFunction } from 'express';
import { requireAuth, requireManager, requireRider } from '../services/auth';
import {
  postMessage, postBookingCard, listMessages, newerMessages, softDeleteMessage,
  unreadCount, participants, CHAT_MAX_LEN,
} from '../services/chat';
import { pushChatMessage } from '../services/push';
import { handle } from './bookings';

export const chatRouter = Router();

/** Per-user chat rate limit: 10 / 30 s (§6.11.5). */
const buckets = new Map<number, { count: number; resetAt: number }>();
export function chatLimiter(req: Request, res: Response, next: NextFunction): void {
  const userId = req.user?.id;
  if (!userId) { next(); return; }
  const now = Date.now();
  const b = buckets.get(userId);
  if (!b || now > b.resetAt) {
    buckets.set(userId, { count: 1, resetAt: now + 30_000 });
    next();
    return;
  }
  b.count++;
  if (b.count > 10) {
    res.status(429).json({ error: 'Slow down — max 10 messages every 30 seconds' });
    return;
  }
  next();
}

// reading is open to any authenticated active manager or rider
chatRouter.get('/messages', requireAuth, async (req, res) => {
  try {
    const beforeId = req.query.before_id ? Number(req.query.before_id) : undefined;
    const afterId = req.query.after_id ? Number(req.query.after_id) : undefined;
    const limit = Number(req.query.limit) || 50;
    if (afterId != null) { res.json(await newerMessages(afterId, limit)); return; }
    res.json(await listMessages(beforeId, limit));
  } catch (err: any) { handle(err, res); }
});

chatRouter.get('/unread', requireAuth, async (req, res) => {
  try { res.json(await unreadCount(Number(req.query.after_id) || 0, req.user!.id)); }
  catch (err: any) { handle(err, res); }
});

chatRouter.get('/participants', requireAuth, async (_req, res) => {
  try { res.json(await participants()); } catch (err: any) { handle(err, res); }
});

chatRouter.get('/online', requireAuth, async (_req, res) => {
  try {
    const { riderRoster } = await import('../services/presence');
    const roster = await riderRoster();
    res.json(roster.map((r: any) => ({
      user_id: r.user_id, full_name: r.full_name, online: r.online,
    })));
  } catch (err: any) { handle(err, res); }
});

// writing requires an ACTIVE rider or the manager (requireRider re-reads is_active)
chatRouter.post('/messages', requireAuth, chatLimiter, async (req, res) => {
  try {
    const u = req.user!;
    if (u.role === 'RIDER') {
      // must still be an active rider — no "lurker" role (§6.11.5)
      const { q1 } = await import('../db/pg');
      const profile = await q1('SELECT is_active FROM bk_riders WHERE id = $1', [u.rider_id]);
      if (!profile || profile.is_active !== 1) { res.status(403).json({ error: 'Account deactivated' }); return; }
    }
    const body = String(req.body?.body ?? '');
    if (body.length > CHAT_MAX_LEN) {
      res.status(400).json({ error: `Message is ${body.length} characters — max ${CHAT_MAX_LEN}` });
      return;
    }
    const msg = await postMessage(
      { id: u.id, role: u.role, name: u.full_name },
      {
        body,
        kind: req.body?.kind,
        booking_id: req.body?.booking_id ?? null,
        client_msg_id: req.body?.client_msg_id ?? null,
        mention_all: !!req.body?.mention_all,
      },
    );
    void pushChatMessage(msg, msg?.mentioned_ids ?? []);
    res.status(201).json(msg);
  } catch (err: any) { handle(err, res); }
});

/** Manager posts a BOOKING card — riders hitting this get 403 (§6.11.5). */
chatRouter.post('/messages/booking', requireAuth, requireManager, chatLimiter, async (req, res) => {
  try {
    const u = req.user!;
    const msg = await postBookingCard(
      { id: u.id, role: 'MANAGER', name: u.full_name },
      Number(req.body?.booking_id),
      req.body?.note,
    );
    void pushChatMessage(msg, []);
    res.status(201).json(msg);
  } catch (err: any) { handle(err, res); }
});

/** Soft delete — manager only (§6.11.5). */
chatRouter.delete('/messages/:id', requireAuth, requireManager, async (req, res) => {
  try {
    const u = req.user!;
    const msg = await softDeleteMessage(Number(req.params.id), { id: u.id, role: 'MANAGER', name: u.full_name });
    if (!msg) { res.status(404).json({ error: 'Message not found or already deleted' }); return; }
    res.json(msg);
  } catch (err: any) { handle(err, res); }
});

/** Full transcript export — manager only (§9.7). */
chatRouter.get('/export', requireAuth, requireManager, async (_req, res) => {
  try {
    const rows = await listMessages(undefined, 100);
    const lines = rows.map((m: any) =>
      m.deleted ? `[${m.created_at}] — deleted —`
        : `[${m.created_at}] ${m.sender_name} (${m.sender_role}${m.kind !== 'TEXT' ? `/${m.kind}` : ''}): ${m.body}`,
    );
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="team-chat.txt"');
    res.send(lines.join('\n'));
  } catch (err: any) { handle(err, res); }
});
