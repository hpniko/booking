/**
 * src/services/push.ts — Web Push with OUR OWN BK_VAPID_* pair (§0.1).
 * Never Messenger-bot's keys: a shared VAPID pair would make both apps'
 * subscriptions visible to each other's server.
 *
 * Push rules (§6.11.4): plain chat chatter is NEVER pushed — only BOOKING
 * cards and @mentions. New-job / request / status pushes respect the
 * notify_* settings. If no VAPID keys are configured, push is a logged no-op.
 */
import { q } from '../db/pg';
import { getBool } from './settings';

let webPush: any = null;
try { webPush = require('web-push'); } catch { /* optional until installed */ }

export function pushConfigured(): boolean {
  return !!(process.env.BK_VAPID_PUBLIC_KEY && process.env.BK_VAPID_PRIVATE_KEY && webPush);
}

export function vapidKeys(): { publicKey: string | null } {
  return { publicKey: process.env.BK_VAPID_PUBLIC_KEY || null };
}

export function ensureVapid(): boolean {
  if (!pushConfigured()) return false;
  try {
    webPush.setVapidDetails(
      process.env.BK_VAPID_SUBJECT || 'mailto:admin@example.com',
      process.env.BK_VAPID_PUBLIC_KEY!,
      process.env.BK_VAPID_PRIVATE_KEY!,
    );
    return true;
  } catch (err: any) {
    console.error('[push] vapid setup failed:', err.message);
    return false;
  }
}

export async function subscribe(
  audience: 'MANAGER' | 'RIDER', endpoint: string, keys: { p256dh: string; auth: string },
  ctx: { userId?: number; riderId?: number; userAgent?: string },
): Promise<void> {
  await q(
    `INSERT INTO bk_booking_devices (rider_id, user_id, audience, endpoint, p256dh, auth, user_agent, last_used_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, now())
     ON CONFLICT (endpoint) DO UPDATE
       SET audience = EXCLUDED.audience, rider_id = EXCLUDED.rider_id,
           user_id = EXCLUDED.user_id, p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth,
           last_used_at = now()`,
    [ctx.riderId ?? null, ctx.userId ?? null, audience, endpoint, keys.p256dh, keys.auth, ctx.userAgent ?? null],
  );
}

export async function unsubscribe(endpoint: string): Promise<void> {
  await q('DELETE FROM bk_booking_devices WHERE endpoint = $1', [endpoint]);
}

interface PushTarget { endpoint: string; p256dh: string; auth: string }

async function sendToAudience(
  audience: 'MANAGER' | 'RIDER',
  payload: any,
  opts: { riderIds?: number[] | null; settingKey?: string } = {},
): Promise<number> {
  if (opts.settingKey && !(await getBool(opts.settingKey, true))) return 0;
  if (!ensureVapid()) return 0;

  const params: any[] = [audience];
  let sql = 'SELECT endpoint, p256dh, auth FROM bk_booking_devices WHERE audience = $1';
  if (opts.riderIds) {
    if (!opts.riderIds.length) return 0;
    params.push(opts.riderIds);
    sql += ` AND rider_id = ANY($${params.length})`;
  }
  const rows = await q<PushTarget>(sql, params);
  let sent = 0;
  for (const row of rows) {
    try {
      await webPush.sendNotification(
        { endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth } },
        JSON.stringify(payload),
      );
      sent++;
    } catch (err: any) {
      if (err.statusCode === 404 || err.statusCode === 410) {
        await q('DELETE FROM bk_booking_devices WHERE endpoint = $1', [row.endpoint]);
      }
    }
  }
  return sent;
}

/** New open job → online riders (§4.1). */
export async function pushNewJob(booking: any): Promise<number> {
  if (!(await getBool('notify_new_job', true))) return 0;
  const online = await (await import('./presence')).onlineRiderIds();
  if (!online.length) return 0;
  return sendToAudience('RIDER', {
    title: `🆕 New job ${booking.ref}`,
    body: `Total ₱${booking.total} · tap to view`,
    url: `#/rider/jobs/${booking.id}`,
    tag: `booking-${booking.id}`,
  }, { riderIds: online, settingKey: 'notify_new_job' });
}

/** Manager alerts (request received, approval confirmations, …). */
export async function pushManager(title: string, body: string, url = '#/manager/dashboard', settingKey?: string): Promise<number> {
  return sendToAudience('MANAGER', { title, body, url }, { settingKey });
}

/** Targeted push to specific riders (assignment, approval, status). */
export async function pushRiders(
  riderIds: number[], title: string, body: string, url: string, settingKey?: string,
): Promise<number> {
  if (!riderIds.length) return 0;
  return sendToAudience('RIDER', { title, body, url, tag: url }, { riderIds, settingKey });
}

/**
 * Chat push — BOOKING cards and mentions ONLY (§6.11.4, R22).
 * Plain chatter is never pushed; it arrives over SSE with an unread badge.
 */
export async function pushChatMessage(msg: any, mentionedIds: number[]): Promise<void> {
  if (!(await getBool('push_chat_enabled', true))) return;
  if (msg.kind === 'BOOKING') {
    if (!(await getBool('push_chat_booking_cards', true))) return;
    const online = await (await import('./presence')).onlineRiderIds();
    void sendToAudience('RIDER', {
      title: `📋 ${msg.booking_ref ?? 'New job'} posted`,
      body: msg.body, url: '#/rider/chat',
    }, { riderIds: online, settingKey: 'push_chat_booking_cards' });
    void sendToAudience('MANAGER', {
      title: `📋 ${msg.booking_ref ?? 'Job'} card posted`,
      body: msg.body, url: '#/manager/chat',
    }, { settingKey: 'push_chat_booking_cards' });
    return;
  }
  if (!mentionedIds.length || !(await getBool('push_chat_mentions', true))) return;
  const rows = await q<{ id: number; rider_id: number | null; role: string }>(
    `SELECT u.id, u.role, (SELECT id FROM bk_riders WHERE user_id = u.id) AS rider_id
     FROM bk_users u WHERE u.id = ANY($1)`,
    [mentionedIds],
  );
  const riderIds = rows.filter((r) => r.rider_id != null).map((r) => Number(r.rider_id));
  const managerMentioned = rows.some((r) => r.role === 'MANAGER');
  if (riderIds.length) {
    void sendToAudience('RIDER', {
      title: `💬 ${msg.sender_name} mentioned you`,
      body: msg.body, url: '#/rider/chat',
    }, { riderIds, settingKey: 'push_chat_mentions' });
  }
  if (managerMentioned && msg.sender_role === 'RIDER') {
    void sendToAudience('MANAGER', {
      title: `💬 ${msg.sender_name} mentioned you`,
      body: msg.body, url: '#/manager/chat',
    }, { settingKey: 'push_chat_mentions' });
  }
}


