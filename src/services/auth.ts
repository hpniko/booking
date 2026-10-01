/**
 * src/services/auth.ts — our OWN identity (§7). Never Messenger-bot's admins.
 *
 * - Access: 12h JWT signed with BK_JWT_SECRET (32+ chars, hard-required at boot).
 * - Refresh: opaque 32-byte hex in bk_booking_sessions, 30 days, ROTATED on
 *   every use (old row deleted, new inserted) so a stolen token is single-use.
 * - is_active is re-read per request, never trusted from the token (§7.3).
 */
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import type { Request, Response, NextFunction } from 'express';
import { q, q1 } from '../db/pg';

const ACCESS_TTL = '12h';
const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export interface AuthUser {
  id: number;
  username: string;
  role: 'MANAGER' | 'RIDER';
  full_name: string;
  is_active: number;
  password_reset_required: number;
  rider_id?: number | null;
}

export function jwtSecret(): string {
  const s = process.env.BK_JWT_SECRET || '';
  if (s.length < 32) {
    throw new Error('BK_JWT_SECRET must be set and at least 32 characters (§7.1)');
  }
  return s;
}

export function signAccess(user: AuthUser): string {
  return jwt.sign(
    { sub: String(user.id), username: user.username, role: user.role, rider_id: user.rider_id ?? undefined },
    jwtSecret(), { expiresIn: ACCESS_TTL },
  );
}

export function hashPassword(pw: string): string {
  return bcrypt.hashSync(pw, 10);
}

export function checkPassword(pw: string, hash: string): boolean {
  return bcrypt.compareSync(pw, hash);
}

export async function createSession(user: AuthUser): Promise<string> {
  const token = crypto.randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + REFRESH_TTL_MS).toISOString();
  await q(
    'INSERT INTO bk_booking_sessions (rider_id, user_id, refresh_token, expires_at) VALUES ($1, $2, $3, $4)',
    [user.rider_id ?? null, user.id, token, expires],
  );
  return token;
}

/** Rotate: the presented refresh token is deleted, a new one issued (§7.2). */
export async function rotateSession(refresh: string): Promise<{ user: AuthUser; refresh: string } | null> {
  const row = await q1<any>(
    'DELETE FROM bk_booking_sessions WHERE refresh_token = $1 AND expires_at > now() RETURNING user_id',
    [refresh],
  );
  if (!row) return null;
  const user = await loadUser(row.user_id);
  if (!user) return null;
  const newRefresh = await createSession(user);
  return { user, refresh: newRefresh };
}

export async function destroySession(refresh: string): Promise<void> {
  await q('DELETE FROM bk_booking_sessions WHERE refresh_token = $1', [refresh]);
}

/** Load a user fresh from the DB — role + is_active always current (§7.3). */
export async function loadUser(id: number): Promise<AuthUser | null> {
  const row = await q1<any>(
    `SELECT u.id, u.username, u.role, u.full_name, u.is_active, u.password_reset_required, r.id AS rider_id
     FROM bk_users u LEFT JOIN bk_riders r ON r.user_id = u.id
     WHERE u.id = $1`,
    [id],
  );
  if (!row) return null;
  return {
    id: row.id, username: row.username, role: row.role, full_name: row.full_name,
    is_active: row.is_active, password_reset_required: row.password_reset_required,
    rider_id: row.rider_id ?? null,
  };
}

export async function verifyAccess(token: string): Promise<AuthUser | null> {
  try {
    const payload = jwt.verify(token, jwtSecret()) as jwt.JwtPayload;
    const id = Number(payload.sub);
    if (!Number.isFinite(id)) return null;
    const user = await loadUser(id);
    if (!user || user.is_active !== 1) return null; // suspended → locked out in one request
    return user;
  } catch {
    return null;
  }
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express { interface Request { user?: AuthUser; riderId?: number } }
}

function readToken(req: Request): string | null {
  const h = req.headers.authorization;
  if (h && h.startsWith('Bearer ')) return h.slice(7);
  // EventSource cannot set headers — SSE may pass ?token= (same secret, same checks)
  const qToken = (req.query as any)?.token;
  return typeof qToken === 'string' && qToken ? qToken : null;
}

export async function requireAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  const token = readToken(req);
  if (!token) { res.status(401).json({ error: 'Not authenticated' }); return; }
  const user = await verifyAccess(token);
  if (!user) { res.status(401).json({ error: 'Invalid or expired session' }); return; }
  req.user = user;
  req.riderId = user.rider_id ?? undefined;
  next();
}

export function requireManager(req: Request, res: Response, next: NextFunction): void {
  if (!req.user || req.user.role !== 'MANAGER') { res.status(403).json({ error: 'Manager access only' }); return; }
  next();
}

/** Rider must also have an ACTIVE bk_riders profile (§7.3) — re-read per request. */
export async function requireRider(req: Request, res: Response, next: NextFunction): Promise<void> {
  if (!req.user || req.user.role !== 'RIDER' || !req.user.rider_id) {
    res.status(403).json({ error: 'Rider access only' }); return;
  }
  const profile = await q1<{ is_active: number }>(
    'SELECT is_active FROM bk_riders WHERE id = $1', [req.user.rider_id],
  );
  if (!profile || profile.is_active !== 1) {
    res.status(403).json({ error: 'Rider account is deactivated' }); return;
  }
  next();
}
