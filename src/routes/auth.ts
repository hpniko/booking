/**
 * src/routes/auth.ts — separate logins, refresh rotation, /me (§9.1).
 * Manager and rider physically cannot land on each other's screen (§7.2).
 */
import { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import { q, q1 } from '../db/pg';
import {
  signAccess, checkPassword, createSession, rotateSession, destroySession,
  requireAuth, loadUser, hashPassword,
} from '../services/auth';

export const authRouter = Router();

async function doLogin(req: Request, res: Response, wantRole: 'MANAGER' | 'RIDER'): Promise<void> {
  const { username, password } = req.body ?? {};
  if (!username || !password) { res.status(400).json({ error: 'username and password are required' }); return; }

  const user = await q1<any>('SELECT * FROM bk_users WHERE username = $1', [String(username).toLowerCase().trim()]);
  if (!user || !checkPassword(String(password), user.password_hash)) {
    res.status(401).json({ error: 'Incorrect username or password' });
    return;
  }
  if (user.role !== wantRole) {
    res.status(403).json({ error: wantRole === 'MANAGER' ? 'This is the manager login — riders sign in below' : 'This is the rider login — managers sign in above' });
    return;
  }
  if (user.is_active !== 1) { res.status(403).json({ error: 'Account is deactivated' }); return; }

  let riderProfile: any = null;
  if (wantRole === 'RIDER') {
    riderProfile = await q1('SELECT * FROM bk_riders WHERE user_id = $1', [user.id]);
    if (!riderProfile || riderProfile.is_active !== 1) {
      res.status(403).json({ error: 'No active rider profile on this account' });
      return;
    }
  }

  await q('UPDATE bk_users SET last_login_at = now() WHERE id = $1', [user.id]);
  const refresh = await createSession({
    id: user.id, username: user.username, role: user.role, full_name: user.full_name,
    is_active: user.is_active, password_reset_required: user.password_reset_required,
    rider_id: riderProfile?.id ?? null,
  });
  const token = signAccess({
    id: user.id, username: user.username, role: user.role, full_name: user.full_name,
    is_active: user.is_active, password_reset_required: user.password_reset_required,
    rider_id: riderProfile?.id ?? null,
  });

  res.json({
    token, refresh, expires_in: 12 * 60 * 60,
    profile: {
      id: user.id, username: user.username, role: user.role, full_name: user.full_name,
      must_change_password: user.password_reset_required === 1,
      rider: riderProfile,
    },
  });
}

authRouter.post('/login/manager', (req, res) => void doLogin(req, res, 'MANAGER'));
authRouter.post('/login/rider', (req, res) => void doLogin(req, res, 'RIDER'));

authRouter.post('/refresh', async (req, res) => {
  const { refresh } = req.body ?? {};
  if (!refresh) { res.status(400).json({ error: 'refresh token required' }); return; }
  const out = await rotateSession(String(refresh));
  if (!out) { res.status(401).json({ error: 'Refresh token is invalid or expired' }); return; }
  res.json({
    token: signAccess(out.user),
    refresh: out.refresh,
    expires_in: 12 * 60 * 60,
    profile: {
      id: out.user.id, username: out.user.username, role: out.user.role,
      full_name: out.user.full_name,
      must_change_password: out.user.password_reset_required === 1,
    },
  });
});

authRouter.post('/logout', requireAuth, async (req, res) => {
  const { refresh } = req.body ?? {};
  if (refresh) await destroySession(String(refresh));
  res.json({ ok: true });
});

authRouter.get('/me', requireAuth, async (req, res) => {
  const u = req.user!;
  const rider = u.rider_id
    ? await q1('SELECT * FROM bk_riders WHERE id = $1', [u.rider_id])
    : null;
  res.json({
    id: u.id, username: u.username, role: u.role, full_name: u.full_name,
    must_change_password: u.password_reset_required === 1,
    rider,
  });
});

authRouter.post('/change-password', requireAuth, async (req, res) => {
  const { current_password, new_password } = req.body ?? {};
  if (!new_password || String(new_password).length < 8) {
    res.status(400).json({ error: 'New password must be at least 8 characters' });
    return;
  }
  const row = await q1<any>('SELECT password_hash FROM bk_users WHERE id = $1', [req.user!.id]);
  if (current_password != null && String(current_password) !== '' && !checkPassword(String(current_password), row.password_hash)) {
    res.status(401).json({ error: 'Current password is incorrect' });
    return;
  }
  await q(
    'UPDATE bk_users SET password_hash = $2, password_reset_required = 0, updated_at = now() WHERE id = $1',
    [req.user!.id, hashPassword(String(new_password))],
  );
  res.json({ ok: true });
});
