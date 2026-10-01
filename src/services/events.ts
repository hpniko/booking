/**
 * src/services/events.ts — audience-aware SSE hub (§6.2).
 *
 * Ported from Messenger-bot's admin-events.ts pattern (20s heartbeat, client
 * set, no-op when nobody listens) but with an audience filter so a rider device
 * can never receive another rider's job or a manager-only event.
 *
 * Scopes: bookings | requests | presence | riders | chat | session | release | day
 */
import type { Response } from 'express';

export type EventScope = 'bookings' | 'requests' | 'presence' | 'riders' | 'chat' | 'session' | 'release' | 'day';

export interface Listener {
  res: Response;
  audience: 'MANAGER' | 'RIDER';
  riderId?: number;         // RIDER listeners only
  userId?: number;
}

const listeners = new Set<Listener>();
const HEARTBEAT_MS = 20_000;

export function eventClientCount(): number {
  return listeners.size;
}

export function addListener(l: Listener): () => void {
  listeners.add(l);
  const ping = setInterval(() => {
    try { l.res.write(': ping\n\n'); } catch { /* dropped — cleaned up below */ }
  }, HEARTBEAT_MS);
  const drop = () => { clearInterval(ping); listeners.delete(l); };
  l.res.on('close', drop);
  l.res.on('error', drop);
  return drop;
}

/**
 * Should this listener receive this event? The filter is server-side (§6.2),
 * never the client hiding things.
 */
function allowed(l: Listener, scope: EventScope, detail: any): boolean {
  if (l.audience === 'MANAGER') return true;
  switch (scope) {
    case 'presence':
    case 'riders':
    case 'release':
    case 'day':
      return true;               // roster / app info every device needs
    case 'chat':
      return true;               // one shared room (§6.11)
    case 'bookings': {
      const id = detail?.id ?? detail?.booking?.id;
      const status = detail?.status ?? detail?.booking?.status;
      // riders only see open jobs and their own bookings (§6.2 channel scoping)
      if (detail?.assigned_rider_id != null) return detail.assigned_rider_id === l.riderId;
      if (status) return status === 'PENDING';
      return id != null;
    }
    case 'requests':
      return detail?.rider_id === l.riderId || detail?.booking?.assigned_rider_id === l.riderId;
    case 'session':
      return detail?.user_id === l.userId;
    default:
      return false;
  }
}

/** Broadcast. No-op when nobody listens, so call sites stay simple. */
export function emit(scope: EventScope, detail: Record<string, unknown> = {}): void {
  if (listeners.size === 0) return;
  const payload = JSON.stringify({ scope, ...detail, at: new Date().toISOString() });
  for (const l of listeners) {
    if (!allowed(l, scope, detail)) continue;
    try {
      l.res.write(`event: change\ndata: ${payload}\n\n`);
    } catch {
      listeners.delete(l);
    }
  }
}
