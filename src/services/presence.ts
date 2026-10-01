/**
 * src/services/presence.ts — heartbeat + server-authoritative online set (§4.5).
 *
 * A rider is online when ANY of their instance rows is fresh within the TTL.
 * Two devices: closing one never yanks the dot off the other. A 30s sweep
 * recomputes and broadcasts ONLY on change, so a crashed app never shows a
 * stale "online".
 */
import { q, q1 } from '../db/pg';
import { getNumber } from './settings';
import { emit } from './events';

let lastOnline: number[] = [];

export async function heartbeat(
  riderId: number, instanceId: string, platform?: string, appVersion?: string,
): Promise<void> {
  await q(
    `INSERT INTO bk_rider_presence (rider_id, instance_id, platform, app_version, last_seen_at)
     VALUES ($1, $2, $3, $4, now())
     ON CONFLICT (rider_id, instance_id)
     DO UPDATE SET last_seen_at = now(), platform = EXCLUDED.platform, app_version = EXCLUDED.app_version`,
    [riderId, instanceId, platform ?? null, appVersion ?? null],
  );
  // No COUNT here: the 30s sweep already computes the online set and broadcasts
  // it on change. Counting on every heartbeat (every 20s per rider) was a
  // second, redundant scan of the presence table.
}

export async function goOffline(riderId: number, instanceId: string): Promise<void> {
  await q('DELETE FROM bk_rider_presence WHERE rider_id = $1 AND instance_id = $2', [riderId, instanceId]);
}

/** Riders with at least one presence row fresher than the TTL. */
export async function onlineRiderIds(): Promise<number[]> {
  const ttl = await getNumber('booking_presence_ttl_s', 60);
  const rows = await q<{ rider_id: number }>(
    `SELECT DISTINCT rider_id FROM bk_rider_presence
     WHERE last_seen_at > now() - ($1 || ' seconds')::interval`,
    [String(ttl)],
  );
  return rows.map((r) => r.rider_id);
}

export async function onlineRiderSet(): Promise<Set<number>> {
  return new Set(await onlineRiderIds());
}

/** 30s sweep — broadcast presence only when the set changed (§6.2, R5). */
export function startPresenceSweep(intervalMs = 30_000): NodeJS.Timeout {
  const tick = async () => {
    try {
      const ids = (await onlineRiderIds()).slice().sort((a, b) => a - b);
      const changed = ids.length !== lastOnline.length || ids.some((v, i) => v !== lastOnline[i]);
      if (changed) {
        lastOnline = ids;
        emit('presence', { online: ids });
      }
    } catch (err: any) {
      console.error('[presence] sweep error:', err.message);
    }
  };
  const t = setInterval(tick, intervalMs);
  t.unref?.();
  return t;
}

/** Roster for the manager: green/grey dot + current job count (§9.9). */
export async function riderRoster(): Promise<any[]> {
  const online = await onlineRiderSet();
  const rows = await q(
    `SELECT r.id, r.full_name, r.phone, r.vehicle, r.plate, r.is_active, r.user_id, u.username,
            (SELECT count(*) FROM bk_bookings b
              WHERE b.assigned_rider_id = r.id AND b.status IN ('ASSIGNED','ACCEPTED','PICKED_UP')
                AND b.archived_at IS NULL) AS active_jobs
     FROM bk_riders r JOIN bk_users u ON u.id = r.user_id
     ORDER BY r.is_active DESC, r.full_name`,
  );
  return rows.map((r: any) => ({ ...r, online: online.has(r.id) }));
}

/** Presence of a single rider (green dot on a booking card). */
export async function presenceMap(ids: number[]): Promise<Map<number, boolean>> {
  const m = new Map<number, boolean>();
  if (!ids.length) return m;
  const online = await onlineRiderSet();
  for (const id of ids) m.set(id, online.has(id));
  return m;
}

/** Used by tests: force the cached "last broadcast" set. */
export function _resetSweepCache(): void { lastOnline = []; }

export async function lastSeenFor(riderId: number): Promise<string | null> {
  const row = await q1<{ t: string | null }>(
    'SELECT max(last_seen_at)::text AS t FROM bk_rider_presence WHERE rider_id = $1', [riderId],
  );
  return row?.t ?? null;
}
