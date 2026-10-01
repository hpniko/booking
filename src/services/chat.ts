/**
 * src/services/chat.ts — the single shared room (§6.11).
 *
 * Ordering is by `id` (monotonic), never created_at. Keyset pagination only.
 * client_msg_id makes a retried send idempotent. Push rules (§6.11.4):
 * plain chatter is NEVER pushed — only BOOKING cards and @mentions.
 */
import { q, q1 } from '../db/pg';
import { emit } from './events';

export const CHAT_MAX_LEN = 500;

export interface ChatSender {
  id: number; role: 'MANAGER' | 'RIDER'; name: string;
}

function serialize(row: any): any {
  if (!row) return row;
  return {
    id: row.id,
    sender_id: row.sender_id,
    sender_name: row.deleted_at ? '' : row.sender_name,
    sender_role: row.sender_role,
    body: row.deleted_at ? null : row.body,
    kind: row.kind,
    booking_id: row.booking_id,
    booking_ref: row.booking_ref ?? null,
    booking_status: row.booking_status ?? null,
    mentioned_ids: safeJson(row.mentioned_ids, []),
    client_msg_id: row.client_msg_id,
    created_at: row.created_at,
    deleted: !!row.deleted_at,
  };
}

function safeJson(v: any, fb: any) {
  if (v == null) return fb;
  if (typeof v === 'object') return v;
  try { return JSON.parse(v); } catch { return fb; }
}

/**
 * Resolve @mentions against bk_users. Unknown handles are plain text — no
 * error, no dead mention, no way to enumerate accounts (§6.11.4).
 */
export async function resolveMentions(body: string, all: boolean): Promise<number[]> {
  const handles = [...body.matchAll(/@([a-z0-9._-]{3,32})/gi)].map((m) => m[1].toLowerCase());
  if (!handles.length && !all) return [];
  const rows = await q<{ id: number }>(
    `SELECT id FROM bk_users WHERE is_active = 1 AND (username = ANY($1) OR $2::boolean)`,
    [handles, all],
  );
  return rows.map((r) => r.id);
}

export interface PostInput {
  body: string;
  kind?: 'TEXT' | 'SYSTEM' | 'BOOKING';
  booking_id?: number | null;
  client_msg_id?: string | null;
  mention_all?: boolean;
}

/**
 * Insert one message. `sender` comes from the verified JWT — never the body.
 * A RIDER sending kind BOOKING/SYSTEM is silently downgraded to TEXT (§6.11.5).
 */
export async function postMessage(sender: ChatSender, input: PostInput): Promise<any | null> {
  const body = String(input.body ?? '').trim();
  if (!body) throw Object.assign(new Error('Message body is required'), { status: 400 });
  if (body.length > CHAT_MAX_LEN) {
    throw Object.assign(new Error(`Message is ${body.length} characters — max ${CHAT_MAX_LEN}`), { status: 400 });
  }
  let kind = input.kind ?? 'TEXT';
  if (sender.role !== 'MANAGER' && (kind === 'BOOKING' || kind === 'SYSTEM')) kind = 'TEXT';

  if (kind === 'BOOKING' && input.booking_id) {
    const b = await q1<any>('SELECT id FROM bk_bookings WHERE id = $1', [input.booking_id]);
    if (!b) throw Object.assign(new Error('Booking not found'), { status: 404 });
  }

  const mentioned = await resolveMentions(body, !!input.mention_all && sender.role === 'MANAGER');

  // idempotent retry: same (sender, client_msg_id) → return the existing row
  if (input.client_msg_id) {
    const dup = await q1<any>(
      'SELECT * FROM bk_chat_messages WHERE sender_id = $1 AND client_msg_id = $2',
      [sender.id, input.client_msg_id],
    );
    if (dup) return serialize(dup);
  }

  const row = await q1<any>(
    `INSERT INTO bk_chat_messages (sender_id, sender_role, sender_name, body, kind, booking_id, mentioned_ids, client_msg_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING *`,
    [sender.id, sender.role, sender.name, body, kind, input.booking_id ?? null,
     JSON.stringify(mentioned), input.client_msg_id ?? null],
  );
  const out = serialize(row);
  emit('chat', { message: out });
  return out;
}

/**
 * System lines are server-emitted, never client-writable (§6.11.6).
 * Presence join/leave is deliberately NOT persisted (§6.11.6 last para).
 */
export async function logSystemEvent(body: string): Promise<any | null> {
  try {
    const row = await q1<any>(
      `INSERT INTO bk_chat_messages (sender_id, sender_role, sender_name, body, kind)
       SELECT id, 'SYSTEM', 'System', $1, 'SYSTEM' FROM bk_users WHERE role = 'MANAGER' ORDER BY id LIMIT 1
       RETURNING *`,
      [body],
    );
    if (row) emit('chat', { message: serialize(row) });
    return row;
  } catch (err: any) {
    console.error('[chat] system event failed:', err.message);
    return null;
  }
}

/** Manager posts a BOOKING card — broadcast to every rider (§6.11.2). */
export async function postBookingCard(sender: ChatSender, bookingId: number, note?: string): Promise<any | null> {
  if (sender.role !== 'MANAGER') throw Object.assign(new Error('Manager only'), { status: 403 });
  const b = await q1<any>('SELECT id, ref FROM bk_bookings WHERE id = $1', [bookingId]);
  if (!b) throw Object.assign(new Error('Booking not found'), { status: 404 });
  const body = note?.trim() ? `${b.ref}: ${note.trim()}` : `📋 ${b.ref} is available`;
  return postMessage(sender, { body, kind: 'BOOKING', booking_id: bookingId });
}

/** Keyset pagination — never OFFSET (§6.11.3). */
export async function listMessages(beforeId?: number, limit = 50): Promise<any[]> {
  const lim = Math.min(Math.max(Number(limit) || 50, 1), 100);
  const rows = beforeId
    ? await q(
      `SELECT m.*, b.ref AS booking_ref, b.status AS booking_status
       FROM bk_chat_messages m LEFT JOIN bk_bookings b ON b.id = m.booking_id
       WHERE m.id < $1 ORDER BY m.id DESC LIMIT $2`,
      [beforeId, lim])
    : await q(
      `SELECT m.*, b.ref AS booking_ref, b.status AS booking_status
       FROM bk_chat_messages m LEFT JOIN bk_bookings b ON b.id = m.booking_id
       ORDER BY m.id DESC LIMIT $1`,
      [lim]);
  return rows.map(serialize).reverse();
}

export async function newerMessages(afterId: number, limit = 50): Promise<any[]> {
  const rows = await q(
    `SELECT m.*, b.ref AS booking_ref, b.status AS booking_status
     FROM bk_chat_messages m LEFT JOIN bk_bookings b ON b.id = m.booking_id
     WHERE m.id > $1 ORDER BY m.id ASC LIMIT $2`,
    [afterId, Math.min(Number(limit) || 50, 200)],
  );
  return rows.map(serialize);
}

/** Soft delete — body replaced, row retained (§6.11.5). */
export async function softDeleteMessage(id: number, actor: ChatSender): Promise<any | null> {
  if (actor.role !== 'MANAGER') throw Object.assign(new Error('Manager only'), { status: 403 });
  const row = await q1<any>(
    `UPDATE bk_chat_messages SET deleted_at = now(), deleted_by = $2, body = 'message deleted'
     WHERE id = $1 AND deleted_at IS NULL RETURNING *`,
    [id, actor.id],
  );
  if (!row) return null;
  const out = serialize(row);
  emit('chat', { message: out });
  return out;
}

export async function unreadCount(afterId: number): Promise<{ count: number; last_id: number }> {
  const row = await q1<any>(
    'SELECT count(*) FILTER (WHERE id > $1)::int AS count, coalesce(max(id), 0)::int AS last_id FROM bk_chat_messages',
    [afterId],
  );
  return { count: Number(row?.count ?? 0), last_id: Number(row?.last_id ?? 0) };
}

/** Mention autocomplete: id + display name ONLY (§6.11.5 enumeration guard). */
export async function participants(): Promise<any[]> {
  const rows = await q(
    `SELECT u.id, u.username, u.full_name, u.role
     FROM bk_users u WHERE u.is_active = 1
       AND (u.role = 'MANAGER' OR EXISTS (SELECT 1 FROM bk_riders r WHERE r.user_id = u.id AND r.is_active = 1))
     ORDER BY u.full_name`,
  );
  return rows.map((r: any) => ({ id: r.id, name: r.full_name, handle: r.username, role: r.role }));
}

