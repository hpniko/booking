/**
 * scripts/audit-e2e.ts â€” live end-to-end audit against the real DB (Â§14).
 * Self-cleaning: every row it creates is deleted at the end.
 */
import { q, q1 } from '../src/db/pg';
import { computeSplit } from '../src/lib/money';
import { buildNav } from '../src/lib/nav';
import { liveGroupOf } from '../src/services/bookings';
import { parsePaste } from '../src/services/parse';
import { createBooking, transition, listBookings, decorate } from '../src/services/bookings';

let pass = 0, fail = 0;
const ok = (name: string, cond: boolean, extra = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name} ${extra}`); }
};
const MGR: any = { id: 1, role: 'MANAGER', name: 'AUDIT Manager' };

const PASTE = `pick up:
POSTRE
Zone 5 San Francisco Magarao sa may pad Spiritsan

Drop off;
ðŸ“Date&Time: 30 Sep 2026 (2:30 PM)
Name: Maria Santos
Contact#: 09171234567
Order:
Honey Chicken
- Java Rice
Df â‚±50
Total:â‚±1,000

Delivery to.
123 Example St, Naga City
ðŸ“ Navigate (tap to open Waze app): https://waze.com/ul?ll=13.5234,123.4567&navigate=yes
;;;WAZE=%7B%22app%22%3A%22waze%3A%2F%2F%3Fll%3D13.5234%2C123.4567%26navigate%3Dyes%22%2C%22https%22%3A%22https%3A%2F%2Fwaze.com%2Ful%3Fll%3D13.5234%2C123.4567%26navigate%3Dyes%22%7D`;

async function pureChecks() {
  console.log('\nÂ§6.6.5 money invariants');
  let inv = true;
  for (let i = 0; i < 100; i++) {
    const total = 1 + Math.floor(Math.random() * 20000);
    const df = Math.floor(Math.random() * total);
    const rate = Math.random() * 60;
    const s = computeSplit(total, df, rate);
    if (s.foodValue !== total - df) { inv = false; break; }
    if (s.commission + s.riderPayout !== s.foodValue) { inv = false; break; }
    if (s.commission !== Math.round((s.foodValue * rate) / 100)) { inv = false; break; }
  }
  ok('food_value === total - Df and comm + rider === food_value (100 triples)', inv);
  const real = computeSplit(1000, 50, 15);
  ok('computeSplit(1000,50,15) => 950 / 143 / 807',
    real.foodValue === 950 && real.commission === 143 && real.riderPayout === 807, JSON.stringify(real));
  const pickup = computeSplit(1000, 0, 15);
  ok('pickup computeSplit(1000,0,15) => 1000 / 150 / 850',
    pickup.foodValue === 1000 && pickup.commission === 150 && pickup.riderPayout === 850);
  ok('odd amounts: computeSplit(333,83,15) => 250 / 38 / 212',
    (() => { const s = computeSplit(333, 83, 15); return s.foodValue === 250 && s.commission === 38 && s.riderPayout === 212; })());

  console.log('\nÂ§6.4.1 live groups');
  const g: Record<string, string> = {
    PENDING: 'OPEN', ASSIGNED: 'CLAIMED', ACCEPTED: 'ONGOING',
    PICKED_UP: 'ONGOING', DELIVERED: 'CLOSED', CANCELLED: 'CLOSED',
  };
  ok('all six statuses map correctly', Object.entries(g).every(([s, v]) => liveGroupOf(s) === v));
  ok('unknown status never hides a job', liveGroupOf('WAT') === 'OPEN');
  ok('ASSIGNED is CLAIMED, not ONGOING', liveGroupOf('ASSIGNED') === 'CLAIMED');

  console.log('\nÂ§6.5.3 nav derived, never stored');
  ok('0,0 rejected (open water)', buildNav(0, 0) === null);
  ok('null pin => null nav', buildNav(null, null) === null);
  ok('valid pin derives waze_app + waze_https + google', (() => {
    const n = buildNav(13.5234, 123.4567);
    return !!n && n.waze_app.startsWith('waze://') && n.waze_https.startsWith('https://') && n.google.includes('google.com');
  })());

  console.log('\nÂ§3.2 parser on the real paste');
  const p = parsePaste(PASTE);
  ok('total = 1000', p.total === 1000, String(p.total));
  ok('Df = 50', p.delivery_fee === 50, String(p.delivery_fee));
  ok('pin decoded from the ;;;WAZE= trailer', p.lat != null && p.lng != null, JSON.stringify([p.lat, p.lng]));
  ok('pin equals the visible link coords', p.lat === 13.5234 && p.lng === 123.4567);
  ok('details_text stored verbatim (byte-for-byte)', p.details_text === PASTE);
}

async function lifecycleChecks() {
  console.log('\nÂ§14 lifecycle against the live DB');
  const day = await q1<any>(`SELECT * FROM bk_dispatch_days WHERE status = 'OPEN' ORDER BY id LIMIT 1`);
  ok('an OPEN dispatch day exists (Â§6.1.1)', !!day);
  const rider = await q1<any>(
    `INSERT INTO bk_users (username, password_hash, role, full_name)
     VALUES ('audit_rider_' || floor(random()*1e9)::text, 'x', 'RIDER', 'AUDIT Rider') RETURNING *`);
  const riderProfile = await q1<any>(
    `INSERT INTO bk_riders (user_id, full_name, vehicle, is_active)
     VALUES ($1, 'AUDIT Rider', 'motorcycle', 1) RETURNING *`, [rider.id]);
  const created: number[] = [];

  try {
    const parsed = parsePaste(PASTE);
    const bk: any = await createBooking(MGR, {
      total: 1000, delivery_fee: 50, details_text: PASTE,
      delivery_lat: parsed.lat, delivery_lng: parsed.lng, pin_source: 'PASTE_LINK',
    });
    created.push(bk.id);
    ok('created: food 950 / comm 143 / rider 807',
      bk.food_value === 950 && bk.commission_amount === 143 && bk.rider_payout === 807,
      JSON.stringify([bk.food_value, bk.commission_amount, bk.rider_payout]));
    ok('commission_rate snapshotted onto the booking', Number(bk.commission_rate) > 0);
    ok('read returns live_group OPEN, is_ongoing false', bk.live_group === 'OPEN' && bk.is_ongoing === false);
    ok('nav derived on read, not a stored column', typeof bk.waze_app === 'string' && bk.waze_app.startsWith('waze://'));

    await transition(MGR, bk.id, { to: 'ASSIGNED', riderId: riderProfile.id });
    const a = decorate(await q1<any>(`SELECT * FROM bk_bookings WHERE id = $1`, [bk.id]));
    ok('after assign: CLAIMED, is_ongoing false', a.live_group === 'CLAIMED' && a.is_ongoing === false,
      JSON.stringify([a.status, a.live_group, a.is_ongoing]));

    const RA: any = { id: rider.id, role: 'RIDER', name: 'AUDIT Rider', riderId: riderProfile.id };
    await transition(RA, bk.id, { to: 'ACCEPTED' });
    await transition(RA, bk.id, { to: 'PICKED_UP' });
    const p2 = decorate(await q1<any>(`SELECT * FROM bk_bookings WHERE id = $1`, [bk.id]));
    ok('after pickup: ONGOING, is_ongoing true', p2.live_group === 'ONGOING' && p2.is_ongoing === true,
      JSON.stringify([p2.status, p2.live_group, p2.is_ongoing]));

    const otherUser = await q1<any>(
      `INSERT INTO bk_users (username, password_hash, role, full_name)
       VALUES ('audit_other_' || floor(random()*1e9)::text, 'x', 'RIDER', 'AUDIT Other') RETURNING *`);
    const other = await q1<any>(
      `INSERT INTO bk_riders (user_id, full_name, is_active) VALUES ($1, 'AUDIT Other', 1) RETURNING *`,
      [otherUser.id]);
    let blocked = false;
    try { await transition({ id: otherUser.id, role: 'RIDER', name: 'X', riderId: other.id }, bk.id, { to: 'DELIVERED' }); }
    catch { blocked = true; }
    ok('a foreign rider cannot deliver the job', blocked);

    await transition(RA, bk.id, { to: 'DELIVERED' });
    const d = decorate(await q1<any>(`SELECT * FROM bk_bookings WHERE id = $1`, [bk.id]));
    ok('delivered: CLOSED, is_ongoing false', d.live_group === 'CLOSED' && d.is_ongoing === false,
      JSON.stringify([d.status, d.live_group]));

    const led = await q1<any>(`SELECT * FROM bk_commission_ledger WHERE booking_id = $1`, [bk.id]);
    ok('commission_ledger row written on delivery, amount 143', !!led && Number(led.amount) === 143,
      JSON.stringify(led && led.amount));
    ok('ledger basis_food = 950', !!led && Number(led.basis_food) === 950);

    let dup = false;
    try {
      await q(`INSERT INTO bk_commission_ledger (booking_id, amount, basis_food, rate)
               VALUES ($1, 143, 950, 15)`, [bk.id]);
    } catch { dup = true; }
    ok('a duplicate ledger row for one booking is impossible', dup);

    const openJobs: any[] = await listBookings({ group: 'OPEN', limit: 200 });
    ok('?group=OPEN returns only PENDING', openJobs.every((x) => x.status === 'PENDING'),
      JSON.stringify(openJobs.map((x) => x.status)));
    const ong: any[] = await listBookings({ group: 'ONGOING', limit: 200 });
    ok('?group=ONGOING is exactly ACCEPTED + PICKED_UP',
      ong.every((x) => x.status === 'ACCEPTED' || x.status === 'PICKED_UP'),
      JSON.stringify(ong.map((x) => x.status)));

    let refrozen = false;
    try { await transition(MGR, bk.id, { to: 'DELIVERED' }); } catch { refrozen = true; }
    ok('a delivered booking cannot be transitioned again', refrozen);

    const bk2: any = await createBooking(MGR, { total: 500, delivery_fee: 50, details_text: 'audit-cancel' });
    created.push(bk2.id);
    await transition(MGR, bk2.id, { to: 'CANCELLED', reason: 'audit' });
    const c = await q1<any>(`SELECT * FROM bk_bookings WHERE id = $1`, [bk2.id]);
    ok('cancel zeroes the money columns',
      c.commission_amount === 0 && c.rider_payout === 0 && c.food_value === 0,
      JSON.stringify([c.commission_amount, c.rider_payout, c.food_value]));

    const evs: any[] = await q(`SELECT type FROM bk_booking_events WHERE booking_id = $1 ORDER BY id`, [bk.id]);
    const types = evs.map((e) => e.type);
    ok('every transition wrote an audit event',
      ['CREATED', 'ASSIGNED', 'ACCEPTED', 'PICKED_UP', 'DELIVERED'].every((t) => types.includes(t)),
      JSON.stringify(types));

    await q(`UPDATE bk_bookings SET archived_at = now() WHERE id = $1`, [bk.id]);
    const kept = await q1<any>(
      `SELECT (SELECT count(*) FROM bk_booking_events WHERE booking_id = $1) AS ev,
              (SELECT count(*) FROM bk_commission_ledger WHERE booking_id = $1) AS led`, [bk.id]);
    ok('archive keeps events + ledger', Number(kept.ev) > 0 && Number(kept.led) === 1);
    const hidden = await listBookings({ limit: 500 });
    ok('an archived booking leaves every board', !hidden.some((x) => x.id === bk.id));
    const withArchived = await listBookings({ include_archived: true, limit: 500 });
    ok('include_archived=1 brings it back for the manager', withArchived.some((x) => x.id === bk.id));
  } finally {
    if (created.length) {
      await q(`DELETE FROM bk_booking_events WHERE booking_id = ANY($1::int[])`, [created]);
      await q(`DELETE FROM bk_commission_ledger WHERE booking_id = ANY($1::int[])`, [created]);
      await q(`DELETE FROM bk_bookings WHERE id = ANY($1::int[])`, [created]);
    }
    await q(`DELETE FROM bk_riders WHERE full_name LIKE 'AUDIT %'`);
    await q(`DELETE FROM bk_users WHERE full_name LIKE 'AUDIT %'`);
  }
}

(async () => {
  await pureChecks();
  await lifecycleChecks();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
