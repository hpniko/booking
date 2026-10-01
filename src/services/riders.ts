/**
 * src/services/riders.ts — rider registration & roster (§7.4, §9.9).
 * Manager-only. Credentials live in bk_users; dispatch data in bk_riders.
 */
import bcrypt from 'bcryptjs';
import { q, q1, tx } from '../db/pg';
import { emit } from './events';
import { riderRoster } from './presence';
import { riderEarnings } from './money';

const USERNAME_RE = /^[a-z0-9._-]{3,32}$/;

export interface RegisterInput {
  full_name: string; username: string; password: string;
  phone?: string; vehicle?: string; plate?: string; notes?: string;
}

export async function registerRider(actorId: number, input: RegisterInput): Promise<any> {
  const name = String(input.full_name || '').trim();
  const username = String(input.username || '').trim().toLowerCase();
  const password = String(input.password || '');

  if (name.length < 2) throw Object.assign(new Error('full_name is required'), { status: 400 });
  if (!USERNAME_RE.test(username)) {
    throw Object.assign(new Error('username must be 3–32 chars of a-z 0-9 . _ -'), { status: 400 });
  }
  if (password.length < 8) {
    throw Object.assign(new Error('password must be at least 8 characters'), { status: 400 });
  }

  const dupe = await q1('SELECT id FROM bk_users WHERE username = $1', [username]);
  if (dupe) throw Object.assign(new Error('That username is taken'), { status: 409 });

  const out = await tx(async (client) => {
    const user = (await client.query(
      `INSERT INTO bk_users (username, password_hash, role, full_name, phone, is_active, password_reset_required, created_by)
       VALUES ($1, $2, 'RIDER', $3, $4, 1, 1, $5) RETURNING id, username, full_name`,
      [username, bcrypt.hashSync(password, 10), name, input.phone ?? null, actorId],
    )).rows[0];
    const rider = (await client.query(
      `INSERT INTO bk_riders (user_id, full_name, phone, vehicle, plate, notes, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [user.id, name, input.phone ?? null, input.vehicle ?? null, input.plate ?? null, input.notes ?? null, actorId],
    )).rows[0];
    await client.query(
      `INSERT INTO bk_booking_events (entity, type, message, actor_type, actor_id, actor_name, meta, visible_to_rider)
       VALUES ('RIDER', 'RIDER_REGISTERED', $1, 'MANAGER', $2, 'Manager', $3, 0)`,
      [`${name} registered (@${username})`, actorId, JSON.stringify({ rider_id: rider.id, user_id: user.id })],
    );
    return { ...rider, username, must_change_password: true };
  });

  emit('riders', { action: 'registered', rider: out });
  return out;
}

export async function updateRider(actorId: number, riderId: number, input: Partial<RegisterInput> & { is_active?: number }): Promise<any> {
  const cur = await q1<any>('SELECT * FROM bk_riders WHERE id = $1', [riderId]);
  if (!cur) throw Object.assign(new Error('Rider not found'), { status: 404 });

  const patch: string[] = ['updated_at = now()'];
  const params: any[] = [riderId];
  // Only '?' fragments bind a value (see the same helper in transition()).
  const push = (frag: string, val: any) => {
    if (!frag.includes('?')) { patch.push(frag); return; }
    params.push(val);
    patch.push(frag.replace(/\?/g, () => `$${params.length}`));
  };

  if (input.full_name !== undefined) push('full_name = ?', String(input.full_name).trim());
  if (input.phone !== undefined) push('phone = ?', input.phone || null);
  if (input.vehicle !== undefined) push('vehicle = ?', input.vehicle || null);
  if (input.plate !== undefined) push('plate = ?', input.plate || null);
  if (input.notes !== undefined) push('notes = ?', input.notes || null);
  if (input.is_active !== undefined) push('is_active = ?', input.is_active ? 1 : 0);

  const row = await q1<any>(
    `UPDATE bk_riders SET ${patch.join(', ')} WHERE id = $1 RETURNING *`, params,
  );
  if (input.is_active !== undefined) {
    await q('UPDATE bk_users SET is_active = $2, updated_at = now() WHERE id = $1',
      [cur.user_id, input.is_active ? 1 : 0]);
  }
  await q(
    `INSERT INTO bk_booking_events (entity, type, message, actor_type, actor_id, actor_name, meta, visible_to_rider)
     VALUES ('RIDER', 'RIDER_UPDATED', $1, 'MANAGER', $2, 'Manager', $3, 0)`,
    [`${row.full_name} profile updated`, actorId, JSON.stringify({ rider_id: riderId, is_active: row.is_active })],
  );
  emit('riders', { action: 'updated', rider: row });
  return row;
}

/** Soft disable — blocks login on the next request, preserves history (§7.4). */
export async function toggleActive(actorId: number, riderId: number): Promise<any> {
  const cur = await q1<any>('SELECT * FROM bk_riders WHERE id = $1', [riderId]);
  if (!cur) throw Object.assign(new Error('Rider not found'), { status: 404 });
  const next = cur.is_active ? 0 : 1;
  await q('UPDATE bk_riders SET is_active = $2, updated_at = now() WHERE id = $1', [riderId, next]);
  await q('UPDATE bk_users SET is_active = $2, updated_at = now() WHERE id = $1', [cur.user_id, next]);
  await q(
    `INSERT INTO bk_booking_events (entity, type, message, actor_type, actor_id, actor_name, visible_to_rider)
     VALUES ('RIDER', $1, $2, 'MANAGER', $3, 'Manager', 0)`,
    [next ? 'RIDER_UPDATED' : 'RIDER_DEACTIVATED',
     `${cur.full_name} ${next ? 'reactivated' : 'deactivated'}`, actorId],
  );
  emit('riders', { action: 'toggled', rider_id: riderId, is_active: next });
  return { id: riderId, is_active: next };
}

/** Returns a one-time temp password (shown once, §7.4). */
export async function resetPassword(actorId: number, riderId: number): Promise<{ temp_password: string }> {
  const cur = await q1<any>('SELECT * FROM bk_riders WHERE id = $1', [riderId]);
  if (!cur) throw Object.assign(new Error('Rider not found'), { status: 404 });
  const temp = `postre${Math.random().toString(36).slice(2, 8)}`;
  await q(
    'UPDATE bk_users SET password_hash = $2, password_reset_required = 1, updated_at = now() WHERE id = $1',
    [cur.user_id, bcrypt.hashSync(temp, 10)],
  );
  await q(
    `INSERT INTO bk_booking_events (entity, type, message, actor_type, actor_id, actor_name, visible_to_rider)
     VALUES ('RIDER', 'RIDER_UPDATED', $1, 'MANAGER', $2, 'Manager', 0)`,
    [`${cur.full_name} password reset`, actorId],
  );
  return { temp_password: temp };
}

/** Lifetime + today counts (§9.9). */
export async function riderStats(riderId: number): Promise<any> {
  const counts = await q1<any>(
    `SELECT count(*) FILTER (WHERE status = 'ASSIGNED')::int AS assigned,
            count(*) FILTER (WHERE status IN ('ACCEPTED','PICKED_UP'))::int AS active,
            count(*) FILTER (WHERE status = 'DELIVERED')::int AS delivered,
            count(*) FILTER (WHERE status = 'CANCELLED')::int AS cancelled,
            count(*)::int AS total
     FROM bk_bookings WHERE assigned_rider_id = $1 AND archived_at IS NULL`,
    [riderId],
  );
  const declined = await q1<{ n: number }>(
    `SELECT count(*)::int AS n FROM bk_booking_events e
     WHERE e.type = 'DECLINED' AND e.actor_id = (SELECT user_id FROM bk_riders WHERE id = $1)`,
    [riderId],
  );
  const earnings = await riderEarnings(riderId);
  return { ...counts, declined: declined?.n ?? 0, earnings };
}

/** Full roster + presence + owed per rider (§9.9). */
export async function rosterWithMoney(): Promise<any[]> {
  const roster = await riderRoster();
  return Promise.all(roster.map(async (r: any) => {
    const earnings = await riderEarnings(r.id);
    return {
      ...r, owed: earnings.owed, earned: earnings.earned, paid: earnings.paid,
      active_jobs: Number(r.active_jobs),
    };
  }));
}


