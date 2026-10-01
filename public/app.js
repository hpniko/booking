/**
 * Postre Booking SPA — vanilla JS, hash routing, no framework, no build step (§10).
 *
 * Money is SERVER-DRIVEN: the client only DISPLAYS commission_amount / rider_payout
 * integers the API returned. It never re-derives a percentage (§6.7, §10.3).
 */
'use strict';

// ═══════════════════════════════════════════════════════════════════════════════
// 1. tiny helpers
// ═══════════════════════════════════════════════════════════════════════════════
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/** Every interpolated field goes through esc() — chat bodies included (§6.11.5). */
function esc(v) {
  return String(v == null ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** Parse an HTML string into a live fragment. */
function h(html) {
  const tpl = document.createElement('template');
  tpl.innerHTML = String(html).trim();
  return tpl.content;
}

/** Peso rendering: the symbol comes from /config, the number from the server. */
function peso(n) {
  const sym = (store.config && store.config.currency) || '₱';
  const v = Math.round(Number(n || 0));
  return sym + v.toLocaleString('en-PH', { maximumFractionDigits: 0 });
}

function timeLabel(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleTimeString('en-PH', { hour: '2-digit', minute: '2-digit', hour12: false });
}
function dateLabel(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-PH', { day: '2-digit', month: 'short' });
}
function dateTimeLabel(iso) {
  return iso ? `${dateLabel(iso)} ${timeLabel(iso)}` : '';
}
function pct(rate) {
  return `${Number(rate || 0)}%`;
}
/** Avatar initials from a full name. */
function initials(name) {
  const parts = String(name || '?').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  return (parts[0][0] + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
}
// ═══════════════════════════════════════════════════════════════════════════════
// 2. store — JWT + cached state
// ═══════════════════════════════════════════════════════════════════════════════
const store = {
  token: localStorage.getItem('bk_token') || null,
  refreshToken: localStorage.getItem('bk_refresh') || null,
  profile: JSON.parse(localStorage.getItem('bk_profile') || 'null'),
  config: {},
  dash: null,          // manager dashboard cache
  home: null,          // rider home cache
  bkIndex: {},         // id → booking, filled by every list paint
  listFilter: null,    // one-shot filter for #/manager/bookings
  unread: 0,
  pendingReqs: 0,   // manager: requests awaiting approval (nav badge)
  online: new Set(),   // online rider ids (from presence events)
  lastChatId: 0,
  sound: localStorage.getItem('bk_sound') !== '0',
  notify: loadNotifyPrefs(),   // per-device: chatSound / chatBadge / jobSound
  theme: localStorage.getItem('bk_theme') || 'dark',   // dark | light | system

  instanceId: localStorage.getItem('bk_instance') || (() => {
    const id = 'inst-' + Math.random().toString(36).slice(2) + Date.now().toString(36);
    localStorage.setItem('bk_instance', id);
    return id;
  })(),

  save() {
    localStorage.setItem('bk_token', this.token || '');
    localStorage.setItem('bk_refresh', this.refreshToken || '');
    localStorage.setItem('bk_profile', JSON.stringify(this.profile));
  },
  clear() {
    this.token = this.refreshToken = null;
    this.profile = null;
    this.dash = this.home = null;
    this.unread = 0;
    this.pendingReqs = 0;
    this.lastChatId = 0;
    localStorage.removeItem('bk_token');
    localStorage.removeItem('bk_refresh');
    localStorage.removeItem('bk_profile');
  },
  get role() { return this.profile && this.profile.role ? this.profile.role : null; },
  get isManager() { return this.role === 'MANAGER'; },
  get isRider() { return this.role === 'RIDER'; },
  get riderId() { return this.profile && this.profile.rider ? this.profile.rider.id : null; },
  get name() { return (this.profile && this.profile.full_name) || ''; },
};

// ═══════════════════════════════════════════════════════════════════════════════
// 3. api() — one funnel, refresh-once-on-401
// ═══════════════════════════════════════════════════════════════════════════════
async function api(path, opts = {}) {
  const url = path.startsWith('/api') ? path : `/api${path}`;
  const send = () => fetch(url, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      ...(store.token ? { Authorization: `Bearer ${store.token}` } : {}),
      ...(opts.headers || {}),
    },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });

  let res = await send();
  if (res.status === 401 && store.refreshToken) {
    if (await tryRefresh()) res = await send();
  }
  if (res.status === 401 && store.profile) {
    logout(true);
    throw new Error('Your session expired — please sign in again');
  }
  const data = (res.headers.get('content-type') || '').includes('json')
    ? await res.json().catch(() => ({}))
    : await res.text();
  if (!res.ok) {
    const err = new Error((data && data.error) || `Request failed (${res.status})`);
    err.status = res.status;
    err.body = data;
    throw err;
  }
  return data;
}

async function tryRefresh() {
  try {
    const res = await fetch('/api/refresh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh: store.refreshToken }),
    });
    if (!res.ok) return false;
    const data = await res.json();
    store.token = data.token;
    store.refreshToken = data.refresh;
    store.save();
    return true;
  } catch { return false; }
}
// ── offline outbox — the rider lifecycle must not be lost on flaky mobile data ──
// accept / pickup / deliver are the three actions a rider cannot afford to lose
// mid-delivery, so they are queued and replayed instead of being hard-refused.
const OUTBOX_KEY = 'bk_outbox';

function readOutbox() {
  try {
    const raw = JSON.parse(localStorage.getItem(OUTBOX_KEY) || '[]');
    return Array.isArray(raw) ? raw.filter((x) => x && x.id && x.act) : [];
  } catch { return []; }
}

function writeOutbox(list) {
  try {
    localStorage.setItem(OUTBOX_KEY, JSON.stringify(list.slice(-25)));
  } catch { /* quota — the queue is best-effort, never fatal */ }
}

function outboxHas(id) {
  return readOutbox().some((x) => Number(x.id) === Number(id));
}

/** Send one queued action. A 409 means the world already moved on → drop it. */
async function flushOutbox() {
  const list = readOutbox();
  if (!list.length || !navigator.onLine) return 0;
  let sent = 0;
  const remaining = [];
  for (const item of list) {
    try {
      await api(`/api/rider/jobs/${item.id}/${item.act}`, { method: 'POST' });
      sent++;
    } catch (err) {
      // 4xx = stale (already applied / no longer mine) → discard, never retry.
      if (err && err.status >= 400 && err.status < 500) continue;
      remaining.push(item);                                 // network / 5xx → keep
    }
  }
  writeOutbox(remaining);
  if (sent) {
    toast(`${sent} queued update${sent === 1 ? '' : 's'} sent`, 'ok');
    chime('ok'); haptic(10);
    refreshCurrent().catch(() => {});
  }
  paintOutbox();
  return sent;
}

function queueRiderAction(id, act, label) {
  const list = readOutbox();
  if (list.some((x) => Number(x.id) === Number(id) && x.act === act)) return false;
  list.push({ id: Number(id), act, label, at: new Date().toISOString() });
  writeOutbox(list);
  paintOutbox();
  return true;
}

/** Show a "waiting to send" chip on any card with a queued action. */
function paintOutbox() {
  const ids = new Set(readOutbox().map((x) => Number(x.id)));
  $$('[data-queued]').forEach((el) => {
    el.classList.toggle('hidden', !ids.has(Number(el.getAttribute('data-queued'))));
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// 4. feedback — toast / haptics / chime (§10.6.5). Three channels for one event.
// ═══════════════════════════════════════════════════════════════════════════════
// ═══════════════════════════════════════════════════════════════════════════════
// 3.5. theme — dark / light / system (§6.8)
// ═══════════════════════════════════════════════════════════════════════════════
const THEME_KEY = 'bk_theme';
let themeMedia = null;

function prefersLight() {
  try { return window.matchMedia('(prefers-color-scheme: light)').matches; }
  catch { return false; }
}

/** Resolve 'dark' | 'light' | 'system' into what the document should show now. */
function applyTheme() {
  const pref = store.theme || 'dark';
  const resolved = pref === 'system' ? (prefersLight() ? 'light' : 'dark') : pref;
  document.documentElement.setAttribute('data-theme', resolved);
  const meta = $('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', resolved === 'light' ? '#f4f6fa' : '#0b0f17');
  return resolved;
}

function setTheme(pref) {
  store.theme = pref;
  try { localStorage.setItem(THEME_KEY, pref); } catch { /* private mode */ }
  applyTheme();
}

// Follow the OS live while the preference is 'system'.
function watchSystemTheme() {
  if (themeMedia || !window.matchMedia) return;
  themeMedia = window.matchMedia('(prefers-color-scheme: light)');
  const onChange = () => { if ((store.theme || 'dark') === 'system') applyTheme(); };
  if (themeMedia.addEventListener) themeMedia.addEventListener('change', onChange);
  else if (themeMedia.addListener) themeMedia.addListener(onChange);
}

// ── per-device notification preferences (BOTH roles get these) ────────────────
// Deliberately local, not bk_settings: this is about THIS phone in THIS pocket.
// A rider who silences chat at the depot should not silence it at home, and the
// manager's own device must not be governed by a store-wide switch.
const NOTIFY_KEY = 'bk_notify';
const NOTIFY_DEFAULTS = { chatSound: true, chatBadge: true, jobSound: true };

function loadNotifyPrefs() {
  try {
    return Object.assign({}, NOTIFY_DEFAULTS, JSON.parse(localStorage.getItem(NOTIFY_KEY) || '{}'));
  } catch { return Object.assign({}, NOTIFY_DEFAULTS); }
}

function setNotifyPref(key, value) {
  const prefs = loadNotifyPrefs();
  prefs[key] = !!value;
  try { localStorage.setItem(NOTIFY_KEY, JSON.stringify(prefs)); } catch { /* private mode */ }
  store.notify = prefs;
  return prefs;
}

/** Per-user read cursor, so a returning device can show a truthful badge. */
function lastChatKey() { return `bk_lastchat_${store.profile && store.profile.id}`; }
function readLastChatId() {
  const v = Number(localStorage.getItem(lastChatKey()) || 0);
  return Number.isFinite(v) && v > 0 ? v : 0;
}
function writeLastChatId(id) {
  if (!id || !store.profile) return;
  try { localStorage.setItem(lastChatKey(), String(id)); } catch { /* private mode */ }
}

/**
 * Shared "Alerts" card — rendered on Manager Settings, Manager profile and the
 * Rider profile so neither role is stuck with someone else's choices.
 */
function alertPrefsHtml() {
  const n = store.notify;
  const row = (key, label, note) => `
    <label class="kv" style="align-items:center;cursor:pointer">
      <span class="k">${esc(label)}${note ? `<span class="req-note" style="display:block">${esc(note)}</span>` : ''}</span>
      <input type="checkbox" data-notify="${key}" ${n[key] ? 'checked' : ''}
             style="width:22px;height:22px;flex:0 0 auto">
    </label>`;
  return `<div class="card tight">
    ${row('chatSound', 'Sound when someone chats', 'Rings for every message from the team, not just bookings or @mentions')}
    ${row('chatBadge', 'Unread badge on the Chat tab', 'Off = no count on the tab. Messages still appear when you open Chat')}
    ${row('jobSound', 'Sound when a new job arrives', 'An unassigned booking hitting the board')}
    <div class="range-note">Saved on this device only. Your teammate’s settings are unaffected.</div>
  </div>`;
}

function bindAlertPrefs(el) {
  $$('[data-notify]', el).forEach((c) => {
    c.onchange = () => {
      const key = c.getAttribute('data-notify');
      const prefs = setNotifyPref(key, c.checked);
      if (c.checked && key === 'chatSound') chime('ok');   // audible confirmation
      toast(c.checked ? 'Alerts on' : 'Alerts off', 'ok');
      paintUnread();
      // Re-evaluate immediately: un-muting the badge should reveal a real count.
      if (key === 'chatBadge') refreshChatUnread();
      void prefs;
    };
  });
}

/**
 * Seed the Chat badge on login. Without this the badge only ever counts messages
 * that arrived over a LIVE SSE connection, so anyone who closed the app (or whose
 * connection dropped) came back to a badge of 0 and never knew they had missed
 * something.
 */
async function refreshChatUnread() {
  if (!store.token || !store.profile) return;
  try {
    if (!readLastChatId()) {
      // First time on this device: establish a baseline WITHOUT a badge spike,
      // otherwise a new user would see the entire chat history as "unread".
      const rows = await api('/api/chat/messages?limit=1');
      const last = rows.length ? Number(rows[rows.length - 1].id) || 0 : 0;
      store.lastChatId = last;
      writeLastChatId(last);
      if (store.unread !== 0) { store.unread = 0; paintUnread(); }
      return;
    }
    const out = await api(`/api/chat/unread?after_id=${readLastChatId()}`);
    const n = Number(out && out.count) || 0;
    store.unread = store.notify.chatBadge ? n : 0;
    if (out && out.last_id) { store.lastChatId = Math.max(store.lastChatId, Number(out.last_id) || 0); }
    paintUnread();
  } catch { /* the badge is best-effort; never block a screen on it */ }
}

function toast(msg, kind = '') {
  const root = $('#toast-root');
  if (!root) return;
  const el = document.createElement('div');
  el.className = 'toast ' + kind;
  el.textContent = String(msg);
  root.appendChild(el);
  setTimeout(() => { el.style.transition = 'opacity .3s'; el.style.opacity = '0'; }, 2600);
  setTimeout(() => el.remove(), 3000);
}

function haptic(pattern = 10) {
  // The Vibration toggle writes bk_haptic; honour it here so "silence" really
  // is silent on a phone resting on a table.
  try {
    if (localStorage.getItem('bk_haptic') === '0') return;
    if (navigator.vibrate) navigator.vibrate(pattern);
  } catch { /* unsupported */ }
}

let audioCtx = null;
function unlockAudio() {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();
  } catch { /* no WebAudio — the toast and haptic still fire */ }
}

function chime(kind = 'ok') {
  if (!store.sound) return;
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();
    const o = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    o.connect(g); g.connect(audioCtx.destination);
    o.type = 'sine';
    o.frequency.value = kind === 'newjob' ? 880 : (kind === 'bad' ? 320 : 660);
    g.gain.setValueAtTime(0.0001, audioCtx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.14, audioCtx.currentTime + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + 0.45);
    o.start();
    o.stop(audioCtx.currentTime + 0.47);
  } catch { /* audio blocked until first gesture — fine */ }
}

// ═══════════════════════════════════════════════════════════════════════════════
// 5. bottom sheets — never a centred modal (§10.6.2)
// ═══════════════════════════════════════════════════════════════════════════════
let sheetStack = [];

const FOCUSABLE = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

function openSheet(html, opts = {}) {
  const opener = document.activeElement;
  const backdrop = document.createElement('div');
  backdrop.className = 'sheet-backdrop';
  const sheet = document.createElement('div');
  sheet.className = 'sheet';
  sheet.setAttribute('role', 'dialog');
  sheet.setAttribute('aria-modal', 'true');
  if (opts.label) sheet.setAttribute('aria-label', opts.label);
  sheet.appendChild(h(`<div class="sheet-grip"></div>`));
  sheet.appendChild(h(html));
  backdrop.appendChild(sheet);
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop && !opts.locked) closeSheet(); });

  // Keyboard/switch accessibility (§10.6.8): Tab cycles INSIDE the sheet, Escape
  // closes it, and focus returns to whatever opened it.
  const onKey = (e) => {
    if (sheetStack[sheetStack.length - 1] !== backdrop) return;
    if (e.key === 'Escape' && !opts.locked) { e.preventDefault(); closeSheet(); return; }
    if (e.key !== 'Tab') return;
    const items = $$(FOCUSABLE, sheet).filter((n) => !n.disabled && n.offsetParent !== null);
    if (!items.length) return;
    const first = items[0];
    const last = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  };
  document.addEventListener('keydown', onKey);
  backdrop._release = () => {
    document.removeEventListener('keydown', onKey);
    if (opener && opener.focus) { try { opener.focus(); } catch { /* gone */ } }
  };

  $('#sheet-root').appendChild(backdrop);
  sheetStack.push(backdrop);
  if (opts.locked) document.body.style.overflow = 'hidden';
  return sheet;
}

function closeSheet() {
  const top = sheetStack.pop();
  if (!top) return;
  if (top._release) top._release();
  top.remove();
  if (!sheetStack.length) document.body.style.overflow = '';
}

/** Yes/no confirmation, promise-based. */
function confirmSheet(title, body, okLabel = 'Confirm', danger = false) {
  return new Promise((resolve) => {
    const sheet = openSheet(`
      <h3>${esc(title)}</h3>
      <p style="color:var(--text-2);font-size:14.5px;margin:0 0 6px">${esc(body || '')}</p>
      <div class="sheet-actions">
        <button class="btn ghost" data-no>Cancel</button>
        <button class="btn ${danger ? 'danger' : 'primary'}" data-yes>${esc(okLabel)}</button>
      </div>`);
    $('[data-no]', sheet).onclick = () => { closeSheet(); resolve(false); };
    $('[data-yes]', sheet).onclick = () => { closeSheet(); resolve(true); };
  });
}

/** Prompt for one text field, promise-based. Returns null when cancelled. */
function promptSheet(title, { label = '', value = '', placeholder = '', required = true, multiline = false } = {}) {
  return new Promise((resolve) => {
    const field = multiline
      ? `<textarea rows="3" style="width:100%;background:var(--bg-2);border:1px solid var(--line);border-radius:10px;padding:11px;color:var(--text);font:inherit">${esc(value)}</textarea>`
      : `<input type="text" value="${esc(value)}" placeholder="${esc(placeholder)}"
           style="width:100%;background:var(--bg-2);border:1px solid var(--line);border-radius:10px;padding:11px;color:var(--text);font:inherit">`;
    const sheet = openSheet(`
      <h3>${esc(title)}</h3>
      ${label ? `<div class="field"><span style="font-size:13px;color:var(--text-2)">${esc(label)}</span></div>` : ''}
      <div class="field">${field}</div>
      <div class="form-error hidden" data-err></div>
      <div class="sheet-actions">
        <button class="btn ghost" data-no>Cancel</button>
        <button class="btn primary" data-yes>Save</button>
      </div>`);
    const input = $('input,textarea', sheet);
    setTimeout(() => input.focus(), 60);
    $('[data-no]', sheet).onclick = () => { closeSheet(); resolve(null); };
    $('[data-yes]', sheet).onclick = () => {
      const v = input.value.trim();
      if (required && !v) {
        const e = $('[data-err]', sheet);
        e.textContent = 'This field is required';
        e.classList.remove('hidden');
        input.focus();
        return;
      }
      closeSheet();
      resolve(v);
    };
  });
}
// ═══════════════════════════════════════════════════════════════════════════════
// 6. status metadata — glyph + colour + word, never colour alone (§10.6.4)
// ═══════════════════════════════════════════════════════════════════════════════
const STATUS = {
  PENDING: { group: 'open', label: 'Open', glyph: '⏳' },
  ASSIGNED: { group: 'claimed', label: 'Claimed', glyph: '📩' },
  ACCEPTED: { group: 'ongoing', label: 'On the way', glyph: '🚗' },
  PICKED_UP: { group: 'ongoing', label: 'Picked up', glyph: '📦' },
  DELIVERED: { group: 'closed', label: 'Delivered', glyph: '✅' },
  CANCELLED: { group: 'cancelled', label: 'Cancelled', glyph: '❌' },
};
function statusMeta(s) {
  return STATUS[s] || { group: 'closed', label: String(s || '—'), glyph: '•' };
}
function statusPill(s) {
  const m = statusMeta(s);
  return `<span class="status ${m.group}"><span class="dot"></span>${m.glyph} ${esc(m.label)}</span>`;
}
function groupClass(b) {
  return String(b.live_group || 'OPEN').toLowerCase();
}

/** Does the server-side derived state say the assigned rider is offline? */
function riderWarn(b) {
  return b.live_group === 'ONGOING' && b.rider_online === false;
}

// ═══════════════════════════════════════════════════════════════════════════════
// 7. booking card — one primary action per card (§10.6.2)
// ═══════════════════════════════════════════════════════════════════════════════
function bkCard(b, opts = {}) {
  const g = groupClass(b);
  const customer = b.customer_name ? esc(b.customer_name) : 'Walk-in / unnamed';
  const when = dateTimeLabel(b.created_at);
  const riderLine = b.assigned_rider_id
    ? `<div class="rider-line">
         <span data-rider-dot="${b.assigned_rider_id}"
               class="${b.rider_online === false ? 'dot-offline' : 'dot-online'}"></span>
         ${esc(b.rider_name || 'Rider')}
         ${b.priority === 'HIGH' ? ' · <strong>HIGH</strong>' : ''}
       </div>`
    : (opts.showOpenHint ? `<div class="rider-line"><span class="dot-offline"></span>Unassigned</div>` : '');
  const warn = riderWarn(b)
    ? `<div class="warn-line">⚠ Ongoing · the rider's phone has gone offline</div>` : '';
  const money = b.total != null
    ? `<div class="bk-money">${peso(b.total)}</div>`
    : '<div class="bk-money" style="color:var(--text-3)">—</div>';
  // "You ₱X" reads as the viewer's own money, which is wrong on the manager
  // board — there it is the RIDER's payout. Name it for whoever is looking.
  const payoutLabel = store.isManager ? 'Rider' : 'You';

  return `
    <div class="bk-card ${g}" data-bk="${b.id}">
      <div class="bk-top">
        <span class="bk-ref">${esc(b.ref)}</span>
        ${money}
      </div>
      <div class="bk-sub">${customer}</div>
      <div class="bk-meta">
        <span>${esc(when)}</span>
        <span>Df ${peso(b.delivery_fee || 0)}</span>
        ${b.total != null ? `<span>${payoutLabel} ${peso(b.rider_payout)}</span>` : ''}
      </div>
      ${riderLine}
      ${warn}
      <div class="warn-line hidden" data-queued="${b.id}" style="background:var(--blue-soft);color:var(--blue);border-color:rgba(77,163,255,.4)">
        ⏳ Waiting to send — will go out when you reconnect
      </div>
      <div class="bk-top" style="margin-top:9px">
        ${statusPill(b.status)}
        ${b.nav ? '<span style="font-size:12px;color:var(--text-3)">📍 pin</span>' : ''}
      </div>
      ${opts.actions || ''}
    </div>`;
}

function emptyBox(glyph, text) {
  return `<div class="empty"><span class="big">${glyph}</span>${esc(text)}</div>`;
}

// ═══════════════════════════════════════════════════════════════════════════════
// 8. one-tap navigation (§10.6.7) — app deep-link with an https fallback
// ═══════════════════════════════════════════════════════════════════════════════
let navLeft = false;
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') navLeft = true;
}, true);
window.addEventListener('blur', () => { navLeft = true; }, true);

function openNav(appUrl, webUrl) {
  if (!appUrl && !webUrl) { toast('No drop-off pin on this booking', 'err'); return; }
  haptic(10);
  navLeft = false;
  try { window.location.href = appUrl || webUrl; } catch { /* noop */ }
  setTimeout(() => {
    if (!navLeft && document.visibilityState === 'visible') window.location.href = webUrl;
  }, 2200);
}
function openMaps(url) {
  if (!url) { toast('No drop-off pin on this booking', 'err'); return; }
  haptic(10);
  window.open(url, '_blank', 'noopener');
}
// ═══════════════════════════════════════════════════════════════════════════════
// 9. SSE — one connect after login, native auto-retry + our own backoff (§10.4)
// ═══════════════════════════════════════════════════════════════════════════════
let es = null;
let esRetry = 0;
let esTimer = null;

/**
 * Current chip state. setLive is IDEMPOTENT on purpose: writing
 * `chip.innerHTML` destroys and recreates the <i> dot, which restarts its
 * `pulse` CSS animation from full brightness. Re-rendering on every repeated
 * call is what made the dot strobe instead of breathe.
 */
let liveState = null;

function setLive(on, why) {
  const chip = $('#live-chip');
  if (!chip) return;
  const mode = on ? 'live' : (why === 'connecting' ? 'connecting' : 'off');
  if (liveState === mode) return;           // nothing changed — leave the DOM alone
  liveState = mode;
  chip.classList.toggle('off', mode === 'off');
  chip.title = mode === 'live' ? 'Live connection'
    : mode === 'connecting' ? 'Connecting…' : 'Reconnecting…';
  chip.innerHTML = `<i></i> ${mode === 'live' ? 'Live' : (mode === 'connecting' ? '…' : 'Off')}`;
}

/** True once this session has had a live channel — distinguishes 1st connect from a reconnect. */
let esEverConnected = false;

function connectSSE() {
  if (esTimer) { clearTimeout(esTimer); esTimer = null; }
  if (es) { try { es.close(); } catch { /* noop */ } es = null; }
  if (!store.token || !store.profile) return;
  setLive(false, 'connecting');
  try {
    es = new EventSource(`/api/events?token=${encodeURIComponent(store.token)}`);
  } catch {
    setLive(false);
    return;
  }
  const open = () => {
    const isReconnect = esEverConnected;
    esEverConnected = true;
    esRetry = 0;
    setLive(true);
    // A dropped channel (Render spin-down, tunnel, phone sleep) never delivers
    // the events emitted while it was down — so a new job could sit unseen on
    // the board. Re-read state on every reconnect instead of trusting the gap.
    if (isReconnect) {
      refreshCurrent().catch(() => {});
      refreshPendingReqs();
      refreshChatUnread();     // chat events were lost during the drop
      if (store.isRider) fire(heartbeatOnce());
    }
  };
  es.addEventListener('open', open);
  es.addEventListener('hello', open);
  es.addEventListener('change', (ev) => {
    let payload = null;
    try { payload = JSON.parse(ev.data); } catch { return; }
    const { scope, at, ...detail } = payload || {};
    if (scope) liveApply(scope, detail);
  });
  es.addEventListener('error', () => {
    if (es && es.readyState === 2 /* CLOSED — fatal, we must reconnect ourselves */) {
      setLive(false, 'reconnecting');
      try { es.close(); } catch { /* noop */ }
      es = null;
      esRetry = Math.min(esRetry + 1, 6);
      esTimer = setTimeout(connectSSE, Math.min(1000 * Math.pow(2, esRetry), 20000));
    } else {
      // readyState 0/1 = the browser is ALREADY auto-reconnecting. That is not
      // "offline" — showing the amber Off state here was the other half of the
      // flicker, flipping the chip green/amber on every transient blip.
      setLive(false, 'connecting');
    }
  });
}

function disconnectSSE() {
  if (esTimer) { clearTimeout(esTimer); esTimer = null; }
  if (es) { try { es.close(); } catch { /* noop */ } es = null; }
  esEverConnected = false;   // signing out must not make the next login a "reconnect"
  setLive(false, 'connecting');
}

/** Repaint every visible presence dot from the new set — no refetch (§10.4). */
function repaintPresence() {
  $$('[data-rider-dot]').forEach((el) => {
    const id = Number(el.getAttribute('data-rider-dot'));
    const on = store.online.has(id);
    el.classList.toggle('dot-online', on);
    el.classList.toggle('dot-offline', !on);
  });
  $$('[data-presence]').forEach((el) => {
    const id = Number(el.getAttribute('data-presence'));
    const on = store.online.has(id);
    el.classList.toggle('on', on);
    el.classList.toggle('off', !on);
  });
  const chip = $('#chat-online-count');
  if (chip) chip.textContent = String(chatState.onlineUsers.size);
}

let refreshTimer = null;
function liveApply(scope, detail) {
  if (scope === 'presence') {
    if (Array.isArray(detail.online)) store.online = new Set(detail.online.map(Number));
    else if (detail.rider_id != null) {
      if (detail.online) store.online.add(Number(detail.rider_id));
      else store.online.delete(Number(detail.rider_id));
    }
    repaintPresence();
    if (store.isManager && currentView.name === 'dashboard') scheduleRefresh('presence');
    return;
  }

  if (scope === 'chat') {
    const m = detail.message;
    if (!m) return;
    const id = Number(m.id) || 0;
    if (id) store.lastChatId = Math.max(store.lastChatId, id);
    if (currentView.name === 'chat') {
      appendChatMessage(m);
      scrollChat(true);
      return;
    }
    // Don't badge or ring for your OWN message arriving back on a second device.
    const mine = store.profile && Number(m.sender_id) === Number(store.profile.id);
    const system = m.kind === 'SYSTEM';
    if (mine || system) return;

    // A new message from a teammate: badge it (if the user wants that) and make
    // a noise. Previously only BOOKING cards and @mentions rang, so ordinary
    // rider-to-rider chatter was silent — riders had no idea anyone replied.
    if (store.notify.chatBadge) {
      store.unread += 1;
      paintUnread();
    }
    if (store.notify.chatSound) { chime('newjob'); haptic([200, 100, 200]); }
    return;
  }

  if (scope === 'session') { refreshConfig().catch(() => {}); return; }

  // bookings / requests / riders / day / release → patch the CURRENT view only
  if (scope === 'bookings' && (detail.status === 'PENDING' || (detail.booking && detail.booking.status === 'PENDING'))) {
    if (store.notify.jobSound) { chime('newjob'); haptic([200, 100, 200]); }
    if (!store.isManager) toast('A new job is on the board');
  }
  if (scope === 'day') { toast('Dispatch day changed'); }
  // A request appearing/resolving changes the approval queue from either role.
  if (scope === 'requests' || scope === 'bookings') refreshPendingReqs();
  scheduleRefresh(scope);
}

function scheduleRefresh() {
  if (refreshTimer) clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => { refreshCurrent().catch(() => {}); }, 320);
}
// ═══════════════════════════════════════════════════════════════════════════════
// 10. navigation + hash router (§10.2, §10.3)
// ═══════════════════════════════════════════════════════════════════════════════
/**
 * Bottom tab bar (mobile, max 5 by §10.6.2) / left rail (desktop).
 *
 * Items flagged `desk: true` exist ONLY in the desktop rail. The manager's
 * phone tab bar is capped at five, so New booking / Requests / History /
 * Days / Settings / Profile are reached through the "More" hub — but a PC
 * rail is tall enough to show every destination at once, so there the hub
 * itself is hidden and the same destinations become real nav items.
 */
const NAV = {
  MANAGER: [
    { key: 'dashboard', label: 'Dashboard', icon: '🏠' },
    { key: 'bookings', label: 'Jobs', icon: '📋' },
    { key: 'chat', label: 'Chat', icon: '💬', badge: true },
    { key: 'riders', label: 'Riders', icon: '🏍' },
    { key: 'more', label: 'More', icon: '⋯', phone: true, reqBadge: true },
    { key: '_sep', sep: true },
    { key: 'new', label: 'New booking', icon: '＋', desk: true },
    { key: 'requests', label: 'Requests', icon: '🔔', desk: true, reqBadge: true },
    { key: 'history', label: 'History', icon: '🧾', desk: true },
    { key: 'days', label: 'Dispatch days', icon: '📅', desk: true },
    { key: 'settings', label: 'Settings', icon: '⚙️', desk: true },
    { key: 'profile', label: 'My profile', icon: '👔', desk: true },
  ],
  RIDER: [
    // Open jobs live ON this dashboard, so the separate "Open" tab that used to
    // duplicate them is gone — one screen, four tabs, nothing repeated.
    { key: 'home', label: 'Dashboard', icon: '🏠' },
    { key: 'chat', label: 'Chat', icon: '💬', center: true, badge: true },
    { key: 'history', label: 'History', icon: '🧾' },
    { key: 'profile', label: 'Profile', icon: '👤' },
  ],
};

const DEFAULT_ROUTE = { MANAGER: '#/manager/dashboard', RIDER: '#/rider/home' };

const views = {};
const currentView = { name: '', route: '', tab: '', params: null };

/** Destinations the phone reaches through the "More" hub. */
const MORE_GROUP = ['new', 'requests', 'history', 'days', 'settings', 'profile'];

function paintNav(role, loc) {
  const nav = $('#bottom-nav');
  const v = views[currentView.route];
  const activeTab = v ? v.tab : '';
  const items = NAV[role] || [];
  nav.innerHTML = items.map((it) => {
    if (it.sep) return '<div class="nav-sep" aria-hidden="true"></div>';
    // A "More" child lights its own rail item AND the More hub. On the phone the
    // hub is the only one of the two that is visible, so this needs no viewport JS.
    const isActive = it.key === activeTab || (it.key === 'more' && MORE_GROUP.includes(activeTab));
    const active = isActive ? ' active' : '';
    const cls = `nav-btn${active}${it.center ? ' center' : ''}`
      + (it.desk ? ' desk-only' : '') + (it.phone ? ' phone-only' : '');
    const badge = it.badge && store.unread > 0
      ? `<span class="nav-badge" data-unread>${store.unread > 99 ? '99+' : store.unread}</span>` : '';
    // A pending request blocks a rider from working, so the count rides on both
    // the phone hub and the desktop rail item (§ flow: approvals are urgent).
    const reqBadge = it.reqBadge && store.pendingReqs > 0
      ? `<span class="nav-badge req" data-reqbadge>${store.pendingReqs > 99 ? '99+' : store.pendingReqs}</span>` : '';
    const label = it.reqBadge && store.pendingReqs > 0
      ? `${esc(it.label)}, ${store.pendingReqs} waiting for approval` : esc(it.label);
    return `<button class="${cls}" data-nav="${it.key}"${isActive ? ' aria-current="page"' : ''}>
              <span class="nav-ico" aria-hidden="true">${it.icon}</span>
              <span>${label}</span>${badge}${reqBadge}
            </button>`;
  }).join('');
  $$('[data-nav]', nav).forEach((b) => {
    b.onclick = () => {
      haptic(10);
      goTab(role, b.getAttribute('data-nav'));
    };
  });
}

function goTab(role, key) {
  const map = {
    MANAGER: {
      dashboard: '#/manager/dashboard', bookings: '#/manager/bookings', chat: '#/manager/chat',
      riders: '#/manager/riders', more: '#/manager/more',
      // desktop rail shortcuts for the destinations the phone hides behind More
      new: '#/manager/new', requests: '#/manager/requests', history: '#/manager/history',
      days: '#/manager/days', settings: '#/manager/settings', profile: '#/manager/profile',
    },
    RIDER: {
      home: '#/rider/home', chat: '#/rider/chat',
      history: '#/rider/history', profile: '#/rider/profile',
    },
  };
  const target = map[role] && map[role][key];
  if (target) location.hash = target;
}

function paintUnread() {
  const badge = $('[data-unread]');
  if (badge) {
    badge.textContent = store.unread > 99 ? '99+' : String(store.unread);
    badge.classList.toggle('hidden', store.unread <= 0);
  }
}

/**
 * Keep the nav's "N waiting" badge truthful. The count lives on the nav, which
 * paintNav() owns, so a change repaints the bar rather than mutating one node.
 */
function paintReqBadge() {
  const has = $('[data-reqbadge]');
  if (has) paintNav(store.role, currentView.params || {});
}

/** COUNT-only fetch — never pulls the whole queue just to draw a badge. */
async function refreshPendingReqs() {
  if (!store.isManager || !store.token) return;
  try {
    const out = await api('/api/manager/requests/count');
    const n = Number(out && out.count) || 0;
    if (n === store.pendingReqs) return;
    store.pendingReqs = n;
    paintReqBadge();
  } catch { /* the badge is best-effort; never block a screen on it */ }
}

function parseHash() {
  const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  if (!parts.length) return null;
  const role = parts[0].toLowerCase();
  if (role !== 'manager' && role !== 'rider') return null;
  const name = (parts[1] || (role === 'manager' ? 'dashboard' : 'home')).toLowerCase();
  const id = parts[2] != null && /^\d+$/.test(parts[2]) ? Number(parts[2]) : null;
  return { role: role.toUpperCase(), name, id };
}

async function router() {
  const loc = parseHash();
  if (!store.profile) { showLogin(); return; }
  if (store.profile.must_change_password) { showPasswordChange(); return; }
  if (!loc || loc.role !== store.role) {
    location.hash = DEFAULT_ROUTE[store.role] || DEFAULT_ROUTE.MANAGER;
    return; // hashchange re-enters the router
  }
  const key = loc.id != null ? `${loc.role.toLowerCase()}/${loc.name}/:id` : `${loc.role.toLowerCase()}/${loc.name}`;
  const v = views[key];
  if (!v) {
    location.hash = DEFAULT_ROUTE[store.role];
    return;
  }
  currentView.name = loc.name;
  currentView.route = key;
  currentView.tab = v.tab || loc.name;
  currentView.params = loc;

  // Drop the previous screen's index. Every list paint re-indexes what it shows,
  // so a leftover entry can only ever be a STALE booking handed to an action
  // (assign/transfer/navigate) after the board already moved on.
  store.bkIndex = {};

  showApp();
  const titleEl = $('#topbar-title');
  titleEl.textContent = typeof v.title === 'function' ? v.title(loc) : v.title;
  paintNav(store.role, loc);

  const el = $('#view');
  el.className = 'view' + (v.chatMode ? ' chat-mode' : '');
  el.scrollTop = 0;
  el.innerHTML = `<div class="empty"><span class="big">🍰</span>Loading…</div>`;
  try {
    await v.mount(el, loc);
  } catch (err) {
    el.innerHTML = emptyBox('⚠️', err.message || 'Something went wrong');
    if (err && err.status !== 401) toast(err.message || 'Could not load', 'err');
  }
}

/** Re-run the current view's mount — SSE-driven, current view only (§10.4). */
async function refreshCurrent() {
  if (!store.profile || !currentView.route) return;
  const v = views[currentView.route];
  if (!v || v.live === false) return;
  const el = $('#view');
  if (!el || el.classList.contains('chat-mode')) return;
  try { await v.mount(el, currentView.params || {}); }
  catch { /* a transient refresh failure must not blank the screen */ }
}

window.addEventListener('hashchange', () => { router().catch(() => {}); });
// ═══════════════════════════════════════════════════════════════════════════════
// 11. action helper — every mutation: visual + haptic + audible (§10.6.5)
// ═══════════════════════════════════════════════════════════════════════════════
async function run(fn, okMsg) {
  if (!navigator.onLine) {
    toast("You're offline — this will not send", 'err');
    haptic([400, 200, 400]);
    throw new Error('offline');
  }
  try {
    const out = await fn();
    if (okMsg) toast(okMsg, 'ok');
    chime('ok');
    haptic(10);
    await refreshCurrent();
    return out;
  } catch (err) {
    toast(err.message || 'Action failed', 'err');
    chime('bad');
    haptic([400, 200, 400]);
    throw err;
  }
}

/** Fire-and-refresh without awaiting inside a click handler. */
const fire = (p) => { p.catch(() => {}); };

// ═══════════════════════════════════════════════════════════════════════════════
// 12. shared sheets: assign / transfer / cancel / payout
// ═══════════════════════════════════════════════════════════════════════════════
function riderPickList(riders, selectedId, allowNone) {
  const rows = (riders || []).map((r) => `
    <button class="pick${Number(selectedId) === Number(r.id) ? ' selected' : ''}" data-pick="${r.id}">
      <span class="avatar" style="width:34px;height:34px;font-size:12px">
        ${esc(initials(r.full_name))}
        <span class="presence ${r.online ? 'on' : 'off'}" data-presence="${r.id}"></span>
      </span>
      <span class="grow">
        <span class="nm">${esc(r.full_name)}</span>
        <span class="sub">${r.online ? '🟢 online' : '⚪ offline'} · ${Number(r.active_jobs || 0)} active</span>
      </span>
      <span style="font-size:13px;color:var(--text-3)">${peso(r.owed || 0)} owed</span>
    </button>`).join('');
  return `${allowNone ? '<button class="pick" data-pick="0"><span class="grow"><span class="nm">Leave unassigned</span></span></button>' : ''}
    ${rows || '<div class="empty">No riders registered yet</div>'}`;
}

async function assignSheet(booking, presetTransfer) {
  let riders = [];
  try { riders = await api('/api/manager/riders'); } catch { riders = []; }
  if (!riders.length) { toast('Register a rider first', 'err'); return; }
  riders = [...riders.filter((r) => r.online), ...riders.filter((r) => !r.online)];

  const sheet = openSheet(`
    <h3>${presetTransfer ? 'Transfer' : 'Assign'} ${esc(booking.ref)}</h3>
    <div class="pick-list">${riderPickList(riders, booking.assigned_rider_id, false)}</div>
    <div class="field">
      <span>${presetTransfer ? 'Reason (required for a transfer)' : 'Note for the rider (optional)'}</span>
      <input id="assign-note" type="text" placeholder="${presetTransfer ? 'e.g. rider requested the swap' : 'e.g. take this one next'}">
    </div>
    <div class="form-error hidden" data-err></div>
    <div class="sheet-actions">
      <button class="btn ghost" data-no>Cancel</button>
      <button class="btn primary" data-yes disabled>${presetTransfer ? 'Transfer' : 'Assign'}</button>
    </div>`);

  let picked = null;
  const yes = $('[data-yes]', sheet);
  $$('[data-pick]', sheet).forEach((b) => {
    b.onclick = () => {
      picked = Number(b.getAttribute('data-pick'));
      $$('.pick', sheet).forEach((x) => x.classList.remove('selected'));
      b.classList.add('selected');
      yes.disabled = !picked;
      haptic(10);
    };
  });
  $('[data-no]', sheet).onclick = () => closeSheet();
  yes.onclick = () => {
    const note = $('#assign-note', sheet).value.trim();
    if (!picked) return;
    if (presetTransfer && !note) {
      const e = $('[data-err]', sheet);
      e.textContent = 'A reason is required for every transfer';
      e.classList.remove('hidden');
      return;
    }
    closeSheet();
    fire(run(
      () => (presetTransfer
        ? api(`/api/manager/bookings/${booking.id}/transfer`, { method: 'POST', body: { to_rider_id: picked, reason: note } })
        : api(`/api/manager/bookings/${booking.id}/assign`, { method: 'POST', body: { rider_id: picked, note } })),
      presetTransfer ? 'Transferred' : 'Assigned',
    ));
  };
}
async function cancelSheet(booking) {
  const reason = await promptSheet(`Cancel ${booking.ref}`, {
    label: 'Reason (required — it is written to the audit ledger)',
    placeholder: 'e.g. customer cancelled the order',
  });
  if (reason == null) return;
  fire(run(() => api(`/api/manager/bookings/${booking.id}/cancel`, { method: 'POST', body: { reason } }), 'Booking cancelled'));
}

function payoutSheet(rider, owed) {
  const sheet = openSheet(`
    <h3>Record payout — ${esc(rider.full_name)}</h3>
    <div class="kv"><span class="k">Currently owed</span><span class="v">${peso(owed)}</span></div>
    <div class="field" style="margin-top:12px">
      <span>Amount (₱)</span>
      <input id="po-amt" type="text" inputmode="decimal" value="${Number(owed || 0)}">
    </div>
    <div class="field">
      <span>Method</span>
      <select id="po-method">
        <option value="CASH">Cash</option>
        <option value="GCASH">GCash</option>
        <option value="BANK">Bank transfer</option>
        <option value="OTHER">Other</option>
      </select>
    </div>
    <div class="field"><span>Reference (optional)</span><input id="po-ref" type="text" placeholder="e.g. 1182"></div>
    <div class="field"><span>Note (optional)</span><input id="po-note" type="text" placeholder="e.g. 3 jobs settled"></div>
    <div class="form-error hidden" data-err></div>
    <div class="sheet-actions">
      <button class="btn ghost" data-no>Cancel</button>
      <button class="btn primary" data-yes>Record payout</button>
    </div>`);
  $('[data-no]', sheet).onclick = () => closeSheet();
  $('[data-yes]', sheet).onclick = () => {
    const amount = Math.round(Number(String($('#po-amt', sheet).value).replace(/[^\d.-]/g, '')));
    if (!Number.isFinite(amount) || amount <= 0) {
      const e = $('[data-err]', sheet);
      e.textContent = 'Amount must be a positive number';
      e.classList.remove('hidden');
      return;
    }
    const body = {
      amount,
      method: $('#po-method', sheet).value,
      reference: $('#po-ref', sheet).value.trim() || undefined,
      note: $('#po-note', sheet).value.trim() || undefined,
    };
    closeSheet();
    fire(run(() => api(`/api/manager/riders/${rider.id}/payouts`, { method: 'POST', body }), 'Payout recorded'));
  };
}

/** Manager posts a BOOKING card into the shared room so every rider sees it. */
async function postBookingToChat(booking) {
  const note = await promptSheet(`Post ${booking.ref} to chat`, {
    label: 'Note (optional)', required: false, placeholder: 'e.g. fast pickup, ₱50 tip',
  });
  if (note == null) return;
  fire(run(() => api('/api/chat/messages/booking', { method: 'POST', body: { booking_id: booking.id, note } }), 'Posted to chat'));
}
// ═══════════════════════════════════════════════════════════════════════════════
// 13. shared render bits
// ═══════════════════════════════════════════════════════════════════════════════
/**
 * A titled section. The body is wrapped in `.sec-body` so the desktop layer
 * (§10.6) can lay a run of booking cards out as a responsive grid without
 * every call site having to add its own wrapper.
 */
function section(title, body, right = '') {
  return `<div class="section-title"><span>${esc(title)}</span>${right}</div>`
       + `<div class="sec-body">${body}</div>`;
}
function firstName(full) { return String(full || '').trim().split(/\s+/)[0] || '?'; }

function rosterStrip(riders) {
  if (!riders.length) return '<div class="empty">No riders yet</div>';
  return `<div class="roster">${riders.map((r) => `
    <button class="roster-item" data-rider="${r.id}">
      <span class="avatar">${esc(initials(r.full_name))}
        <span class="presence ${r.online ? 'on' : 'off'}" data-presence="${r.id}"></span>
      </span>
      <span>${esc(firstName(r.full_name))}</span>
      <span class="j">${Number(r.active_jobs || 0)} job${Number(r.active_jobs || 0) === 1 ? '' : 's'}</span>
    </button>`).join('')}</div>`;
}

// ═══════════════════════════════════════════════════════════════════════════════
// 14. MANAGER — dashboard (§10.2)
// ═══════════════════════════════════════════════════════════════════════════════
views['manager/dashboard'] = {
  title: 'Dashboard',
  tab: 'dashboard',
  async mount(el) {
    const d = await api('/api/manager/dashboard');
    store.dash = d;
    store.online = new Set((d.onlineRiders || []).map(Number));
    const live = d.live || {};
    const reqs = d.pendingRequests || [];
    // the dashboard already returns the queue — seed the nav badge from it
    if (reqs.length !== store.pendingReqs) { store.pendingReqs = reqs.length; paintReqBadge(); }
    const roster = (d.riders || []).filter((r) => Number(r.is_active) === 1);
    const day = d.day;

    const reqHtml = requestCards(reqs);

    const cards = (list, actions) => list.map((b) => bkCard(b, {
      showOpenHint: true,
      actions: actions(b),
    })).join('');

    el.innerHTML = `
      ${day ? `<div class="card tight" style="display:flex;justify-content:space-between;align-items:center;gap:10px">
        <div>
          <strong>Dispatch day ${esc(day.date_ref)}</strong>
          <div style="color:var(--text-3);font-size:12.5px">
            ${esc(day.status || 'OPEN')} · opened ${esc(timeLabel(day.opened_at))}
          </div>
        </div>
        <button class="btn small ghost" data-days>Manage</button>
      </div>` : ''}

      <div class="stat-grid">
        <button class="stat open" data-jump="open"><span class="n">${Number(live.open || 0)}</span><span class="l">Open</span></button>
        <button class="stat ongoing" data-jump="ongoing"><span class="n">${Number(live.ongoing || 0)}</span><span class="l">Ongoing</span></button>
        <button class="stat" data-jump="closed"><span class="n">${Number(live.done_today || 0)}</span><span class="l">Done today</span></button>
        <button class="stat claimed" data-jump="claimed"><span class="n">${reqs.length}</span><span class="l">Needs approval</span></button>
      </div>

      ${section(`Needs approval${reqs.length ? ` · ${reqs.length}` : ''}`, reqHtml)}

      ${section(`Ongoing · ${(d.ongoing || []).length}`, (d.ongoing || []).length
        ? cards(d.ongoing, (b) => `
            <div class="bk-actions">
              <button class="btn primary small" data-open="${b.id}">Open</button>
              ${b.nav ? `<button class="btn small maps" data-nav-app="${b.id}">🗺️ Navigate</button>` : ''}
              <button class="btn ghost small" data-transfer="${b.id}">Transfer</button>
            </div>`)
        : '<div class="empty">Nothing on the road right now</div>')}

      ${section(`Awaiting acceptance · ${(d.claimed || []).length}`, (d.claimed || []).length
        ? cards(d.claimed, (b) => `
            <div class="bk-actions">
              <button class="btn primary small" data-open="${b.id}">Open</button>
              <button class="btn ghost small" data-transfer="${b.id}">Transfer</button>
            </div>`)
        : '<div class="empty">No job is waiting on a rider</div>')}

      ${section(`Open board · ${(d.open || []).length}`, (d.open || []).length
        ? cards(d.open, (b) => `
            <div class="bk-actions">
              <button class="btn primary small" data-open="${b.id}">Open</button>
              <button class="btn small" data-assign="${b.id}">Assign</button>
              <button class="btn ghost small" data-chat-bk="${b.id}">Post</button>
            </div>`)
        : '<div class="empty">The board is clear</div>')}

      ${section('Riders on shift', rosterStrip(roster))}
    `;

    wireDashboard(el, d, reqs);
  },
};
function indexBookings(lists) {
  for (const list of lists) {
    for (const b of (list || [])) store.bkIndex[Number(b.id)] = b;
  }
}

/** Look up a booking from whatever the last paint indexed. */
function findBooking(id) {
  return store.bkIndex[Number(id)] || null;
}

function wireDashboard(el, d, reqs) {
  indexBookings([d.ongoing, d.claimed, d.open, d.done]);

  $$('[data-open]', el).forEach((b) => {
    b.onclick = () => { haptic(10); location.hash = `#/manager/bookings/${b.getAttribute('data-open')}`; };
  });
  $$('[data-assign]', el).forEach((b) => {
    b.onclick = () => { const bk = findBooking(b.getAttribute('data-assign')); if (bk) fire(assignSheet(bk, false)); };
  });
  $$('[data-transfer]', el).forEach((b) => {
    b.onclick = () => { const bk = findBooking(b.getAttribute('data-transfer')); if (bk) fire(assignSheet(bk, true)); };
  });
  $$('[data-chat-bk]', el).forEach((b) => {
    b.onclick = () => { const bk = findBooking(b.getAttribute('data-chat-bk')); if (bk) fire(postBookingToChat(bk)); };
  });
  $$('[data-nav-app]', el).forEach((b) => {
    b.onclick = () => {
      const bk = findBooking(b.getAttribute('data-nav-app'));
      if (bk) openNav(bk.waze_app, bk.waze_https);
    };
  });
  bindRequestActions(el);                       // shared: approve / reject / open-req
  $$('[data-jump]', el).forEach((b) => {
    b.onclick = () => {
      store.listFilter = { group: b.getAttribute('data-jump') };
      location.hash = '#/manager/bookings';
    };
  });
  $$('[data-rider]', el).forEach((b) => {
    b.onclick = () => { haptic(10); location.hash = `#/manager/riders/${b.getAttribute('data-rider')}`; };
  });
  const days = $('[data-days]', el);
  if (days) days.onclick = () => { location.hash = '#/manager/days'; };
}
// ═══════════════════════════════════════════════════════════════════════════════
// 15. MANAGER — full board (§10.2)
// ═══════════════════════════════════════════════════════════════════════════════
const BOARD_FILTERS = [
  { key: '', label: 'All live' },
  { key: 'open', label: 'Open' },
  { key: 'claimed', label: 'Claimed' },
  { key: 'ongoing', label: 'Ongoing' },
  { key: 'closed', label: 'Closed' },
  { key: 'unassigned', label: 'Unassigned' },
  { key: 'archived', label: 'Archived' },
];

views['manager/bookings'] = {
  title: 'Jobs',
  tab: 'bookings',
  async mount(el) {
    const state = Object.assign(
      { group: '', q: '' },
      store.listFilter || {},
    );
    store.listFilter = null;

    const params = new URLSearchParams();
    if (state.group === 'unassigned') params.set('unassigned', '1');
    else if (state.group === 'archived') params.set('include_archived', '1');
    else if (state.group) params.set('group', state.group);
    if (state.q) params.set('q', state.q);
    params.set('limit', '60');

    let rows = await api(`/api/manager/bookings?${params}`);
    if (state.group === 'archived') rows = rows.filter((b) => b.archived_at);
    indexBookings([rows]);

    const chips = BOARD_FILTERS.map((f) => `
      <button class="chip${state.group === f.key ? ' active' : ''}" data-filter="${f.key}">${esc(f.label)}</button>`).join('');

    el.innerHTML = `
      <div class="chip-row">${chips}</div>
      <div class="field" style="margin-bottom:12px">
        <input id="q" type="search" placeholder="Search ref, customer or details" value="${esc(state.q)}">
      </div>
      <div id="board">${rows.length
        ? rows.map((b) => bkCard(b, {
          showOpenHint: true,
          actions: `<div class="bk-actions">
              <button class="btn primary small" data-open="${b.id}">Open</button>
              ${b.status === 'PENDING' ? `<button class="btn small" data-assign="${b.id}">Assign</button>` : ''}
            </div>`,
        })).join('')
        : emptyBox('🔍', 'No bookings match this filter')}</div>
      <button class="fab" id="new-bk" aria-label="New booking">＋</button>
    `;

    $$('[data-filter]', el).forEach((c) => {
      c.onclick = () => {
        store.listFilter = { group: c.getAttribute('data-filter'), q: state.q };
        fire(router());
      };
    });
    const q = $('#q', el);
    let qt = null;
    q.oninput = () => {
      clearTimeout(qt);
      qt = setTimeout(() => {
        store.listFilter = { group: state.group, q: q.value.trim() };
        const pos = q.selectionStart;
        router().then(() => {
          const nq = $('#q', $('#view'));
          if (nq) { nq.focus(); try { nq.setSelectionRange(pos, pos); } catch { /* noop */ } }
        }).catch(() => {});
      }, 420);
    };
    $$('[data-open]', el).forEach((b) => {
      b.onclick = () => { location.hash = `#/manager/bookings/${b.getAttribute('data-open')}`; };
    });
    $$('[data-assign]', el).forEach((b) => {
      b.onclick = () => { const bk = findBooking(b.getAttribute('data-assign')); if (bk) fire(assignSheet(bk, false)); };
    });
    $('#new-bk', el).onclick = () => { location.hash = '#/manager/new'; };
  },
};
// ═══════════════════════════════════════════════════════════════════════════════
// 16. MANAGER — booking detail sheet (§10.2)
// ═══════════════════════════════════════════════════════════════════════════════
function timelineHtml(events) {
  if (!events || !events.length) return '<div class="empty">No history yet</div>';
  return `<div class="tl">${events.slice().reverse().map((e) => `
    <div class="tl-item">
      <div class="t">${esc(e.local_at || e.time || dateTimeLabel(e.created_at))}</div>
      <div class="m">${esc(e.message || e.type)}</div>
      <div class="who">${esc(e.actor_name || e.actor_type || 'System')}${e.to_status ? ` · → ${esc(e.to_status)}` : ''}</div>
    </div>`).join('')}</div>`;
}

function moneyBreakdown(b) {
  const food = b.food_value != null ? b.food_value : (b.total != null ? b.total - (b.delivery_fee || 0) : null);
  return `
    <div class="kv"><span class="k">Total paid by customer</span><span class="v">${peso(b.total)}</span></div>
    <div class="kv"><span class="k">Delivery fee (Df)</span><span class="v">${peso(b.delivery_fee || 0)}</span></div>
    <div class="kv"><span class="k">Food value (basis)</span><span class="v">${peso(food)}</span></div>
    <div class="kv"><span class="k">Manager commission${b.commission_rate != null ? ` (${pct(b.commission_rate)})` : ''}</span><span class="v">${b.commission_amount != null ? peso(b.commission_amount) : '—'}</span></div>
    <div class="kv total"><span class="k">Rider payout</span><span class="v">${b.rider_payout != null ? peso(b.rider_payout) : '—'}</span></div>`;
}

views['manager/bookings/:id'] = {
  title: (loc) => `Booking #${loc.id}`,
  tab: 'bookings',
  async mount(el, loc) {
    const b = await api(`/api/manager/bookings/${loc.id}`);
    store.bkIndex[Number(b.id)] = b;

    const reqs = (b.requests || []).filter((r) => r.status === 'PENDING');
    const archived = !!b.archived_at;

    el.innerHTML = `
      <div class="card">
        <div class="bk-top">
          <span class="bk-ref">${esc(b.ref)}</span>
          ${statusPill(b.status)}
        </div>
        <div class="bk-sub">${esc(b.customer_name || 'Walk-in / unnamed')}
          ${b.customer_phone ? ` · <a href="tel:${esc(b.customer_phone)}" style="color:var(--accent-2)">${esc(b.customer_phone)}</a>` : ''}
        </div>
        <div class="bk-meta">
          <span>${esc(dateTimeLabel(b.created_at))}</span>
          ${b.date_ref ? `<span>day ${esc(b.date_ref)}</span>` : ''}
          ${b.priority === 'HIGH' ? '<span>🔥 HIGH priority</span>' : ''}
          ${b.source ? `<span>${esc(b.source)}</span>` : ''}
        </div>
        ${b.assigned_rider_id ? `<div class="rider-line">
            <span data-rider-dot="${b.assigned_rider_id}" class="${b.rider_online === false ? 'dot-offline' : 'dot-online'}"></span>
            ${esc(b.rider_name || 'Rider')}${b.rider_phone ? ` · ${esc(b.rider_phone)}` : ''}
          </div>` : '<div class="rider-line"><span class="dot-offline"></span>Unassigned</div>'}
        ${riderWarn(b) ? '<div class="warn-line">⚠ Ongoing · the rider\'s phone has gone offline</div>' : ''}
        ${archived ? '<div class="warn-line">📦 Archived — this booking is hidden from the board</div>' : ''}
      </div>

      ${b.nav ? `<button class="nav-cta" id="nav-app">🗺️ NAVIGATE</button>
        <button class="btn maps" id="nav-maps">Open in Google Maps</button>`
        : '<div class="no-pin">📍 No drop-off pin on this booking — read the details below</div>'}

      <div class="section-title">Money</div>
      <div class="card">${moneyBreakdown(b)}</div>

      ${section(`Requests · ${reqs.length}`, reqs.length ? requestCards(reqs, { showOpen: false }) : '')}

      ${section('Actions', `
        <div class="card tight">
          <div style="display:flex;flex-wrap:wrap;gap:8px">
            ${b.status === 'PENDING' ? '<button class="btn primary small" data-assign>Assign a rider</button>' : ''}
            ${b.assigned_rider_id ? '<button class="btn small" data-transfer>Transfer</button>' : ''}
            ${(b.status === 'PENDING' || b.live_group === 'ONGOING' || b.live_group === 'CLAIMED') ? '<button class="btn danger small" data-cancel>Cancel booking</button>' : ''}
            <button class="btn ghost small" data-edit>Edit</button>
            <button class="btn ghost small" data-note>Add note</button>
            <button class="btn ghost small" data-chat-bk>Post to chat</button>
            ${archived ? '<button class="btn ghost small" data-unarchive>Unarchive</button>'
              : '<button class="btn ghost small" data-archive>Archive</button>'}
          </div>
        </div>`)}

      ${section('Original paste (verbatim)', `<div class="details-box">${esc(b.details_text || '(no details)')}</div>`)}

      ${section('Timeline', `<div class="card">${timelineHtml(b.events)}</div>`)}
    `;

    wireBookingDetail(el, b, reqs);
  },
};
function wireBookingDetail(el, b) {
  const on = (sel, fn) => { const n = $(sel, el); if (n) n.onclick = fn; };
  on('#nav-app', () => openNav(b.waze_app, b.waze_https));
  on('#nav-maps', () => openMaps(b.google_maps));
  on('[data-assign]', () => fire(assignSheet(b, false)));
  on('[data-transfer]', () => fire(assignSheet(b, true)));
  on('[data-cancel]', () => fire(cancelSheet(b)));
  on('[data-edit]', () => fire(editBookingSheet(b)));
  on('[data-note]', () => {
    fire((async () => {
      const msg = await promptSheet('Add a manager note', {
        label: 'Internal only — the rider never sees this', multiline: true,
      });
      if (msg == null) return;
      await run(() => api(`/api/manager/bookings/${b.id}/note`, { method: 'POST', body: { message: msg } }), 'Note added');
    })());
  });
  on('[data-chat-bk]', () => fire(postBookingToChat(b)));
  on('[data-archive]', () => {
    fire((async () => {
      const reason = await promptSheet('Archive this booking', {
        label: 'Reason (optional)', required: false, placeholder: 'e.g. duplicate entry',
      });
      if (reason == null) return;
      await run(() => api(`/api/manager/bookings/${b.id}/archive`, { method: 'POST', body: { reason } }), 'Booking archived');
    })());
  });
  on('[data-unarchive]', () => fire(run(
    () => api(`/api/manager/bookings/${b.id}/unarchive`, { method: 'POST' }),
    'Booking unarchived',
  )));

  bindRequestActions(el);                       // shared: approve / reject
}

/** Edit the money/customer fields. PUT /manager/bookings/:id (§9.3). */
function editBookingSheet(b) {
  const sheet = openSheet(`
    <h3>Edit ${esc(b.ref)}</h3>
    <div class="field"><span>Total (₱)</span>
      <input id="ed-total" type="text" inputmode="decimal" value="${b.total != null ? b.total : ''}"></div>
    <div class="field"><span>Delivery fee Df (₱)</span>
      <input id="ed-df" type="text" inputmode="decimal" value="${b.delivery_fee != null ? b.delivery_fee : 0}"></div>
    <div class="field"><span>Customer name</span>
      <input id="ed-name" type="text" value="${esc(b.customer_name || '')}"></div>
    <div class="field"><span>Customer phone</span>
      <input id="ed-phone" type="tel" inputmode="tel" value="${esc(b.customer_phone || '')}"></div>
    <div class="field"><span>Notes for the rider</span>
      <textarea id="ed-notes" rows="3">${esc(b.notes || '')}</textarea></div>
    <div class="field"><span>Priority</span>
      <select id="ed-prio">
        <option value="NORMAL"${b.priority !== 'HIGH' ? ' selected' : ''}>Normal</option>
        <option value="HIGH"${b.priority === 'HIGH' ? ' selected' : ''}>High</option>
      </select></div>
    <div class="form-error hidden" data-err></div>
    <div class="sheet-actions">
      <button class="btn ghost" data-no>Cancel</button>
      <button class="btn primary" data-yes>Save changes</button>
    </div>`);

  $('[data-no]', sheet).onclick = () => closeSheet();
  $('[data-yes]', sheet).onclick = () => {
    const num = (v) => { const n = String(v || '').replace(/[^\d.-]/g, ''); return n === '' ? null : Math.round(Number(n)); };
    const total = num($('#ed-total', sheet).value);
    const df = num($('#ed-df', sheet).value);
    if (total != null && df != null && df > total) {
      const e = $('[data-err]', sheet);
      e.textContent = 'Df cannot exceed the booking total';
      e.classList.remove('hidden');
      return;
    }
    const body = {
      customer_name: $('#ed-name', sheet).value.trim() || null,
      customer_phone: $('#ed-phone', sheet).value.trim() || null,
      notes: $('#ed-notes', sheet).value.trim() || null,
      priority: $('#ed-prio', sheet).value,
    };
    if (total != null) body.total = total;
    if (df != null) body.delivery_fee = df;
    closeSheet();
    fire(run(() => api(`/api/manager/bookings/${b.id}`, { method: 'PUT', body }), 'Booking updated'));
  };
}
// ═══════════════════════════════════════════════════════════════════════════════
// 17. MANAGER — paste a booking (§6.5.4, §10.2)
// ═══════════════════════════════════════════════════════════════════════════════
views['manager/new'] = {
  title: 'New booking',
  tab: 'new',
  live: false,   // never repaint over a half-typed paste
  async mount(el) {
    el.innerHTML = `
      <div class="card">
        <div class="field">
          <span>Paste the Messenger booking here</span>
          <textarea id="raw" rows="12" placeholder="Paste everything — the app reads only Total, Df and the Waze pin.&#10;Everything else is kept verbatim for the rider."></textarea>
        </div>
        <div style="display:flex;gap:8px">
          <button class="btn" id="btn-clip">📋 Paste from clipboard</button>
          <button class="btn primary" id="btn-read">Read details</button>
        </div>
        <div class="form-error hidden" id="parse-err" style="margin-top:12px"></div>
      </div>
      <div id="preview"></div>
    `;

    const raw = $('#raw', el);

    $('#btn-clip', el).onclick = async () => {
      try {
        const text = await navigator.clipboard.readText();
        if (text) { raw.value = text; toast('Pasted from clipboard', 'ok'); }
        else toast('Clipboard is empty', 'err');
      } catch {
        toast('Clipboard blocked — long-press the box and paste', 'err');
      }
    };

    const read = async () => {
      const err = $('#parse-err', el);
      err.classList.add('hidden');
      if (!raw.value.trim()) {
        err.textContent = 'Paste some booking text first';
        err.classList.remove('hidden');
        return;
      }
      $('#btn-read', el).disabled = true;
      try {
        const p = await api('/api/manager/bookings/parse', { method: 'POST', body: { raw: raw.value } });
        renderPreview(el, p);
      } catch (e) {
        err.textContent = e.message;
        err.classList.remove('hidden');
      } finally {
        $('#btn-read', el).disabled = false;
      }
    };
    $('#btn-read', el).onclick = () => fire(read());
  },
};

function renderPreview(el, p) {
  const box = $('#preview', el);
  const pin = p.has_pin
    ? `<span style="color:var(--green)">📍 pin found (${Number(p.lat).toFixed(5)}, ${Number(p.lng).toFixed(5)})</span>`
    : (p.link_error
      ? '<span style="color:var(--red)">📍 a Waze link was found but gave no coordinates</span>'
      : '<span style="color:var(--text-3)">📍 no pin — the rider reads the details</span>');

  const blocked = !p.can_create && !p.link_error;
  box.innerHTML = `
    <div class="section-title">Check these three things</div>
    <div class="card">
      <div class="field" style="margin-bottom:12px">
        <span>Total (₱) ${p.total == null ? '— required' : ''}</span>
        <input id="pv-total" type="text" inputmode="decimal" value="${p.total != null ? p.total : ''}" placeholder="e.g. 1000">
      </div>
      <div class="field" style="margin-bottom:12px">
        <span>Df — delivery fee (₱)${p.has_df_line ? '' : ' — none found in the paste'}</span>
        <input id="pv-df" type="text" inputmode="decimal" value="${p.delivery_fee != null ? p.delivery_fee : 0}">
      </div>
      <div class="kv" style="font-size:13px"><span class="k">Drop-off</span><span class="v">${pin}</span></div>
      ${p.money_error ? `<div class="warn-line">⚠ ${esc(p.money_error)}</div>` : ''}
      ${p.link_error ? `<div class="warn-line">⚠ Create is blocked until you confirm text-only</div>` : ''}
      ${blocked ? `<div class="warn-line">⚠ ${esc(p.money_error || 'A booking total is required')}</div>` : ''}
    </div>

    <div class="section-title">Optional</div>
    <div class="card">
      <div class="field" style="margin-bottom:12px"><span>Customer name</span><input id="pv-name" type="text"></div>
      <div class="field" style="margin-bottom:12px"><span>Customer phone</span><input id="pv-phone" type="tel" inputmode="tel"></div>
      <div class="field" style="margin-bottom:12px"><span>Notes for the rider</span><input id="pv-notes" type="text"></div>
      <div class="field"><span>Priority</span>
        <select id="pv-prio"><option value="NORMAL">Normal</option><option value="HIGH">High</option></select>
      </div>
      ${p.link_error ? `<label style="display:flex;gap:9px;align-items:center;margin-top:12px;font-size:14px">
          <input id="pv-textonly" type="checkbox" style="width:20px;height:20px"> Create anyway, text-only (no pin)
        </label>` : ''}
    </div>

    <button class="btn primary block" id="btn-create"${blocked ? ' disabled' : ''}>Create booking</button>
  `;

  $('#btn-create', box).onclick = () => {
    const num = (v) => { const n = String(v || '').replace(/[^\d.-]/g, ''); return n === '' ? null : Math.round(Number(n)); };
    const body = {
      raw_text: p.details_text,
      total: num($('#pv-total', box).value),
      delivery_fee: num($('#pv-df', box).value),
      customer_name: $('#pv-name', box).value.trim() || null,
      customer_phone: $('#pv-phone', box).value.trim() || null,
      notes: $('#pv-notes', box).value.trim() || null,
      priority: $('#pv-prio', box).value,
      allow_text_only: $('#pv-textonly', box) ? $('#pv-textonly', box).checked : undefined,
    };
    if (body.total == null || body.total <= 0) { toast('A booking total is required', 'err'); return; }
    fire((async () => {
      const created = await run(
        () => api('/api/manager/bookings', { method: 'POST', body }),
        'Booking created',
      );
      if (p.link_error && body.allow_text_only) toast('Created without a pin', 'ok');
      if (created && created.id) location.hash = `#/manager/bookings/${created.id}`;
      else location.hash = '#/manager/bookings';
    })());
  };
}
// ═══════════════════════════════════════════════════════════════════════════════
// 18. MANAGER — requests queue + rider roster (§10.2)
// ═══════════════════════════════════════════════════════════════════════════════
function requestCards(reqs, opts = {}) {
  if (!reqs.length) return emptyBox('✅', 'No riders waiting for approval');
  // ONE renderer for both the dashboard strip and the Requests page. They used to
  // be separate copies that had already drifted (the dashboard copy lost the
  // "Open" button) — the option now drives the difference instead.
  return reqs.map((r) => `
    <div class="req-card">
      <div class="req-top">
        <div>
          <div class="req-name">${esc(r.rider_name || 'Rider')}</div>
          <div class="req-note">wants ${esc(r.ref || `#${r.booking_id}`)}${r.customer_name ? ` · ${esc(r.customer_name)}` : ''}</div>
        </div>
        <div class="bk-money">${r.total != null ? peso(r.total) : ''}</div>
      </div>
      ${r.note ? `<div class="req-note">“${esc(r.note)}”</div>` : ''}
      <div class="req-actions">
        <button class="btn success small" data-approve="${r.id}">Approve</button>
        <button class="btn danger small" data-reject="${r.id}">Reject</button>
        ${opts.showOpen === false ? '' : `<button class="btn ghost small" data-open-req="${r.booking_id}">Open</button>`}
      </div>
    </div>`).join('');
}

/**
 * Approve / Reject / Open wiring, shared by the dashboard, the Requests page and
 * the booking detail screen. Previously re-declared three times.
 */
function bindRequestActions(el) {
  $$('[data-approve]', el).forEach((b) => {
    b.onclick = () => fire(run(
      () => api(`/api/manager/requests/${b.getAttribute('data-approve')}/approve`, { method: 'POST' }),
      'Request approved',
    ));
  });
  $$('[data-reject]', el).forEach((b) => {
    b.onclick = () => {
      fire((async () => {
        const reason = await promptSheet('Reject this request', {
          label: 'Reason (optional — the rider sees it)', required: false,
        });
        if (reason == null) return;
        await run(
          () => api(`/api/manager/requests/${b.getAttribute('data-reject')}/reject`, { method: 'POST', body: { reason } }),
          'Request rejected',
        );
      })());
    };
  });
  $$('[data-open-req]', el).forEach((b) => {
    b.onclick = () => { location.hash = `#/manager/bookings/${b.getAttribute('data-open-req')}`; };
  });
}

views['manager/requests'] = {
  title: 'Requests',
  tab: 'requests',
  async mount(el) {
    const reqs = await api('/api/manager/requests');
    if (reqs.length !== store.pendingReqs) { store.pendingReqs = reqs.length; paintReqBadge(); }
    el.innerHTML = `${section(`Waiting on you · ${reqs.length}`, requestCards(reqs))}
      <button class="btn ghost block" id="back-home">Back to dashboard</button>`;
    bindRequestActions(el);
    $('#back-home', el).onclick = () => { location.hash = '#/manager/dashboard'; };
  },
};
views['manager/riders'] = {
  title: 'Riders',
  tab: 'riders',
  async mount(el) {
    const riders = await api('/api/manager/riders');
    store.online = new Set(riders.filter((r) => r.online).map((r) => Number(r.id)));

    const active = riders.filter((r) => Number(r.is_active) === 1);
    const inactive = riders.filter((r) => Number(r.is_active) !== 1);
    const owedTotal = riders.reduce((s, r) => s + Number(r.owed || 0), 0);

    const card = (r) => `
      <div class="card tight">
        <div style="display:flex;gap:11px;align-items:center">
          <span class="avatar" style="width:44px;height:44px">${esc(initials(r.full_name))}
            <span class="presence ${r.online ? 'on' : 'off'}" data-presence="${r.id}"></span>
          </span>
          <div style="flex:1;min-width:0">
            <div style="font-weight:800">${esc(r.full_name)}${Number(r.is_active) === 1 ? '' : ' <span style="color:var(--text-3);font-size:12px">· inactive</span>'}</div>
            <div style="color:var(--text-3);font-size:12.5px">@${esc(r.username || '')}${r.vehicle ? ` · ${esc(r.vehicle)}` : ''}${r.plate ? ` · ${esc(r.plate)}` : ''}</div>
            <div style="font-size:12.5px;color:var(--text-2);margin-top:2px">
              ${Number(r.active_jobs || 0)} active · owed <strong>${peso(r.owed)}</strong>
            </div>
          </div>
        </div>
        <div class="bk-actions" style="flex-wrap:wrap">
          <button class="btn primary small" data-profile="${r.id}">Money</button>
          <button class="btn small" data-payout="${r.id}">Payout</button>
          <button class="btn ghost small" data-edit="${r.id}">Edit</button>
          <button class="btn ghost small" data-reset="${r.id}">Reset pw</button>
          <button class="btn ghost small" data-toggle="${r.id}">${Number(r.is_active) === 1 ? 'Deactivate' : 'Reactivate'}</button>
        </div>
      </div>`;

    el.innerHTML = `
      <div class="card tight" style="display:flex;justify-content:space-between;align-items:center">
        <div>
          <div style="font-size:12px;color:var(--text-3);text-transform:uppercase;letter-spacing:.5px">Total owed to riders</div>
          <div style="font-size:22px;font-weight:800" class="money">${peso(owedTotal)}</div>
        </div>
        <button class="btn primary small" id="add-rider">＋ Add rider</button>
      </div>
      ${section(`Active · ${active.length}`, active.length ? active.map(card).join('') : emptyBox('🏍', 'Register your first rider'))}
      ${inactive.length ? section(`Inactive · ${inactive.length}`, inactive.map(card).join('')) : ''}
    `;

    $('#add-rider', el).onclick = () => fire(registerRiderSheet());
    const byId = (id) => riders.find((x) => Number(x.id) === Number(id));

    $$('[data-profile]', el).forEach((b) => {
      b.onclick = () => { location.hash = `#/manager/riders/${b.getAttribute('data-profile')}`; };
    });
    $$('[data-payout]', el).forEach((b) => {
      b.onclick = () => { const r = byId(b.getAttribute('data-payout')); if (r) payoutSheet(r, r.owed); };
    });
    $$('[data-edit]', el).forEach((b) => {
      b.onclick = () => { const r = byId(b.getAttribute('data-edit')); if (r) fire(editRiderSheet(r)); };
    });
    $$('[data-reset]', el).forEach((b) => {
      b.onclick = () => {
        const r = byId(b.getAttribute('data-reset'));
        fire((async () => {
          const ok = await confirmSheet(
            `Reset ${r.full_name}'s password?`,
            'A one-time temporary password is generated. The rider must change it at next sign-in.',
            'Reset password',
          );
          if (!ok) return;
          const out = await run(() => api(`/api/manager/riders/${r.id}/reset-password`, { method: 'POST' }), 'Password reset');
          if (out && out.temp_password) showTempPassword(r.full_name, out.temp_password);
        })());
      };
    });
    $$('[data-toggle]', el).forEach((b) => {
      b.onclick = () => {
        const r = byId(b.getAttribute('data-toggle'));
        fire((async () => {
          const on = Number(r.is_active) === 1;
          const ok = await confirmSheet(
            `${on ? 'Deactivate' : 'Reactivate'} ${r.full_name}?`,
            on ? 'They are locked out on their next request. All history is kept.' : 'They can sign in again.',
            on ? 'Deactivate' : 'Reactivate', on,
          );
          if (!ok) return;
          await run(() => api(`/api/manager/riders/${r.id}/toggle-active`, { method: 'POST' }), 'Rider updated');
        })());
      };
    });
  },
};

function showTempPassword(name, temp) {
  const sheet = openSheet(`
    <h3>Temporary password</h3>
    <p style="color:var(--text-2);font-size:14px">Give this to ${esc(name)} — it is shown once and never again.</p>
    <div class="details-box" style="font-size:20px;font-weight:800;text-align:center">${esc(temp)}</div>
    <div class="sheet-actions"><button class="btn primary" data-ok>Done</button></div>`);
  $('[data-ok]', sheet).onclick = () => closeSheet();
}
function randPassword() {
  return 'postre' + Math.random().toString(36).slice(2, 8);
}

function registerRiderSheet() {
  const sheet = openSheet(`
    <h3>Register a rider</h3>
    <div class="field"><span>Full name</span><input id="rg-name" type="text" placeholder="e.g. Jose Ramos"></div>
    <div class="field"><span>Username</span><input id="rg-user" type="text" autocapitalize="none" spellcheck="false" placeholder="3–32 chars: a-z 0-9 . _ -"></div>
    <div class="field"><span>Temporary password</span>
      <div style="display:flex;gap:8px">
        <input id="rg-pass" type="text" value="${esc(randPassword())}" style="flex:1">
        <button class="btn small" data-gen>New</button>
      </div>
    </div>
    <div class="field"><span>Phone</span><input id="rg-phone" type="tel" inputmode="tel"></div>
    <div class="field"><span>Vehicle</span><input id="rg-vehicle" type="text" placeholder="e.g. Motorcycle"></div>
    <div class="field"><span>Plate</span><input id="rg-plate" type="text"></div>
    <div class="form-error hidden" data-err></div>
    <div class="sheet-actions">
      <button class="btn ghost" data-no>Cancel</button>
      <button class="btn primary" data-yes>Register rider</button>
    </div>`);

  $('[data-gen]', sheet).onclick = () => { $('#rg-pass', sheet).value = randPassword(); haptic(10); };
  $('[data-no]', sheet).onclick = () => closeSheet();
  $('[data-yes]', sheet).onclick = () => {
    const body = {
      full_name: $('#rg-name', sheet).value.trim(),
      username: $('#rg-user', sheet).value.trim().toLowerCase(),
      password: $('#rg-pass', sheet).value,
      phone: $('#rg-phone', sheet).value.trim() || undefined,
      vehicle: $('#rg-vehicle', sheet).value.trim() || undefined,
      plate: $('#rg-plate', sheet).value.trim() || undefined,
    };
    const err = $('[data-err]', sheet);
    if (!body.full_name) { err.textContent = 'Full name is required'; err.classList.remove('hidden'); return; }
    if (!/^[a-z0-9._-]{3,32}$/.test(body.username)) { err.textContent = 'Username must be 3–32 chars of a-z 0-9 . _ -'; err.classList.remove('hidden'); return; }
    if (body.password.length < 8) { err.textContent = 'Password must be at least 8 characters'; err.classList.remove('hidden'); return; }
    closeSheet();
    fire((async () => {
      const created = await run(() => api('/api/manager/riders', { method: 'POST', body }), 'Rider registered');
      if (created && created.id) openSheet(`<h3>Rider created</h3>
        <p style="color:var(--text-2);font-size:14px">${esc(created.full_name)} signs in on the <strong>Rider</strong> tab with the password you set. They must change it on first sign-in.</p>
        <div class="sheet-actions"><button class="btn primary" data-ok>Done</button></div>`);
      const ok = $('[data-ok]');
      if (ok) ok.onclick = () => closeSheet();
    })());
  };
}

function editRiderSheet(r) {
  const sheet = openSheet(`
    <h3>Edit ${esc(r.full_name)}</h3>
    <div class="field"><span>Full name</span><input id="er-name" type="text" value="${esc(r.full_name || '')}"></div>
    <div class="field"><span>Phone</span><input id="er-phone" type="tel" inputmode="tel" value="${esc(r.phone || '')}"></div>
    <div class="field"><span>Vehicle</span><input id="er-vehicle" type="text" value="${esc(r.vehicle || '')}"></div>
    <div class="field"><span>Plate</span><input id="er-plate" type="text" value="${esc(r.plate || '')}"></div>
    <div class="field"><span>Notes</span><textarea id="er-notes" rows="2">${esc(r.notes || '')}</textarea></div>
    <div class="sheet-actions">
      <button class="btn ghost" data-no>Cancel</button>
      <button class="btn primary" data-yes>Save</button>
    </div>`);
  $('[data-no]', sheet).onclick = () => closeSheet();
  $('[data-yes]', sheet).onclick = () => {
    const body = {
      full_name: $('#er-name', sheet).value.trim(),
      phone: $('#er-phone', sheet).value.trim(),
      vehicle: $('#er-vehicle', sheet).value.trim(),
      plate: $('#er-plate', sheet).value.trim(),
      notes: $('#er-notes', sheet).value.trim(),
    };
    closeSheet();
    fire(run(() => api(`/api/manager/riders/${r.id}`, { method: 'PUT', body }), 'Rider updated'));
  };
}
// ═══════════════════════════════════════════════════════════════════════════════
// 19. MANAGER — rider profile + earnings (§6.7)
// ═══════════════════════════════════════════════════════════════════════════════
const PERIODS = [
  { key: 'today', label: 'Today' },
  { key: '7d', label: '7 days' },
  { key: 'month', label: 'This month' },
  { key: 'all', label: 'All time' },
];
let riderPeriod = 'month';

/**
 * The client states the INTENT ("this month"), never a Date built from its own
 * clock. The server resolves the boundaries in the store's timezone — otherwise
 * a phone whose timezone differs from the store silently shows the wrong money
 * (§R16, the bug this codebase exists to avoid). See resolvePeriod() in
 * services/day.ts.
 */
function periodQuery() {
  return `period=${encodeURIComponent(riderPeriod)}`;
}

function moneyTable(ledger) {
  if (!ledger || !ledger.length) return '<div class="empty">No bookings in this period</div>';
  return `<div class="table-scroll"><table class="money-table">
    <thead><tr>
      <th scope="col">Ref</th><th scope="col">Date</th><th scope="col">Total</th><th scope="col" class="num">Df</th>
      <th scope="col" class="num">Food</th><th scope="col" class="num">Comm%</th><th scope="col" class="num">Comm</th><th scope="col" class="num">Rider</th>
    </tr></thead>
    <tbody>${ledger.map((r) => `
      <tr data-ledger="${r.id}">
        <td>${esc(r.ref)}</td>
        <td>${esc(dateLabel(r.delivered_at || r.created_at))}</td>
        <td>${peso(r.total)}</td>
        <td class="num">${r.delivery_fee != null ? peso(r.delivery_fee) : '—'}</td>
        <td class="num">${r.food_value != null ? peso(r.food_value) : '—'}</td>
        <td class="num">${r.commission_rate != null ? pct(r.commission_rate) : '—'}</td>
        <td class="num">${r.commission_amount != null ? peso(r.commission_amount) : '—'}</td>
        <td class="num"><strong>${r.rider_payout != null ? peso(r.rider_payout) : '—'}</strong></td>
      </tr>`).join('')}
    </tbody>
  </table></div>`;
}

/** CSV downloads need the JWT — fetch as a blob, never a bare <a href>. */
async function downloadCsv(path, filename) {
  try {
    const res = await fetch(path, { headers: { Authorization: `Bearer ${store.token}` } });
    if (!res.ok) throw new Error('Export failed');
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    toast('Downloaded ' + filename, 'ok');
  } catch (err) {
    toast(err.message || 'Export failed', 'err');
  }
}
views['manager/riders/:id'] = {
  title: 'Rider money',
  tab: 'riders',
  async mount(el, loc) {
    const qs = periodQuery();

    const [money, roster] = await Promise.all([
      api(`/api/manager/riders/${loc.id}/money?${qs}`),
      api('/api/manager/riders'),
    ]);
    store.riders = roster;
    const rider = roster.find((r) => Number(r.id) === Number(loc.id));
    if (!rider) { el.innerHTML = emptyBox('🚫', 'Rider not found'); return; }

    const e = money.earnings || {};
    const stats = money.stats || {};
    const lastPayout = (money.payouts || []).find((p) => !p.is_void);

    el.innerHTML = `
      <div class="card">
        <div style="display:flex;gap:11px;align-items:center">
          <span class="avatar" style="width:48px;height:48px;font-size:16px">${esc(initials(rider.full_name))}
            <span class="presence ${rider.online ? 'on' : 'off'}" data-presence="${rider.id}"></span>
          </span>
          <div style="flex:1;min-width:0">
            <div style="font-weight:800;font-size:17px">${esc(rider.full_name)}</div>
            <div style="color:var(--text-3);font-size:12.5px">@${esc(rider.username || '')}${rider.vehicle ? ` · ${esc(rider.vehicle)}` : ''}${rider.plate ? ` · ${esc(rider.plate)}` : ''}</div>
            <div style="font-size:12.5px;color:${rider.online ? 'var(--green)' : 'var(--text-3)'};margin-top:2px">
              ${rider.online ? '🟢 online now' : '⚪ offline'}${lastPayout ? ` · last payout ${esc(dateLabel(lastPayout.created_at))}` : ''}
            </div>
          </div>
        </div>
      </div>

      <div class="stat-grid">
        <button class="stat"><span class="n">${Number(stats.delivered || 0)}</span><span class="l">Delivered</span></button>
        <button class="stat"><span class="n">${peso(e.total_value)}</span><span class="l">Bk value</span></button>
        <button class="stat ongoing"><span class="n">${peso(e.earned)}</span><span class="l">Rider earns</span></button>
        <button class="stat claimed"><span class="n">${peso(e.commission_total)}</span><span class="l">My comm.</span></button>
      </div>

      <div class="owed-banner">
        <div>
          <div class="lbl">⚠ Owed to rider</div>
          <div class="amt">${peso(e.owed)}</div>
          <div class="sub">Earned ${peso(e.earned)} · paid ${peso(e.paid)}</div>
        </div>
        <button class="btn primary small" id="record-payout">Record payout</button>
      </div>

      <div class="chip-row">
        ${PERIODS.map((p) => `<button class="chip${riderPeriod === p.key ? ' active' : ''}" data-period="${p.key}">${esc(p.label)}</button>`).join('')}
      </div>
      ${money.period && money.period.from ? `<div class="range-note">
        Server-resolved in ${esc(store.config.store_timezone || 'store time')}: ${esc(dateTimeLabel(money.period.from))} → ${esc(dateTimeLabel(money.period.to))}
      </div>` : ''}

      <div class="section-title">
        <span>Per-booking money · ${(money.ledger || []).length}</span>
        <button class="btn small ghost" id="export-csv">Export CSV</button>
      </div>
      <div class="card tight">${moneyTable(money.ledger)}</div>

      ${section(`Payout history · ${(money.payouts || []).length}`, (money.payouts || []).length
        ? (money.payouts || []).map((p) => `
            <div class="card tight" style="display:flex;justify-content:space-between;align-items:center;gap:10px">
              <div>
                <div style="font-weight:800" class="money">${peso(p.amount)}${p.is_void ? ' <span style="color:var(--red);font-size:12px">VOID</span>' : ''}</div>
                <div style="font-size:12.5px;color:var(--text-3)">
                  ${esc(p.method || 'CASH')} · ${esc(dateLabel(p.created_at))}${p.reference ? ` · ref ${esc(p.reference)}` : ''}
                </div>
                ${p.note ? `<div style="font-size:12.5px;color:var(--text-2)">“${esc(p.note)}”</div>` : ''}
                ${p.is_void && p.void_reason ? `<div style="font-size:12px;color:var(--red)">voided: ${esc(p.void_reason)}</div>` : ''}
              </div>
              ${p.is_void ? '' : `<button class="btn danger small" data-void="${p.id}">Void</button>`}
            </div>`).join('')
        : '<div class="empty">No payouts recorded yet</div>')}

      ${section('Performance', `<div class="card">
        <div class="kv"><span class="k">Delivered</span><span class="v">${Number(stats.delivered || 0)}</span></div>
        <div class="kv"><span class="k">Declined</span><span class="v">${Number(stats.declined || 0)}</span></div>
        <div class="kv"><span class="k">Cancelled by manager</span><span class="v">${Number(stats.cancelled || 0)}</span></div>
        <div class="kv"><span class="k">Average per job</span><span class="v">${peso(e.avg_per_job)}</span></div>
        <div class="kv"><span class="k">Currently holding</span><span class="v">${Number(stats.active || 0)} job(s)</span></div>
      </div>`)}
    `;

    wireRiderMoney(el, rider, e);
  },
};
function wireRiderMoney(el, rider, earnings) {
  const rp = $('#record-payout', el);
  if (rp) rp.onclick = () => payoutSheet(rider, earnings.owed);

  const csv = $('#export-csv', el);
  if (csv) {
    csv.onclick = () => {
      fire(downloadCsv(`/api/manager/riders/${rider.id}/earnings.csv?${periodQuery()}`, `rider-${rider.id}-earnings.csv`));
    };
  }
  $$('[data-period]', el).forEach((b) => {
    b.onclick = () => {
      riderPeriod = b.getAttribute('data-period');
      haptic(10);
      fire(refreshCurrent());
    };
  });
  $$('[data-ledger]', el).forEach((tr) => {
    tr.onclick = () => { location.hash = `#/manager/bookings/${tr.getAttribute('data-ledger')}`; };
  });
  $$('[data-void]', el).forEach((b) => {
    b.onclick = () => {
      fire((async () => {
        const reason = await promptSheet('Void this payout', {
          label: 'Reason (required)', placeholder: 'e.g. recorded twice',
        });
        if (reason == null) return;
        await run(
          () => api(`/api/manager/payouts/${b.getAttribute('data-void')}/void`, { method: 'POST', body: { reason } }),
          'Payout voided',
        );
      })());
    };
  });
}
// ═══════════════════════════════════════════════════════════════════════════════
// 20. TEAM CHAT — one shared room for both roles (§6.11, §10.2, §10.3)
// ═══════════════════════════════════════════════════════════════════════════════
function chatBodyHtml(body) {
  return esc(body).replace(/@([a-z0-9._-]{3,32})/gi, '<strong>@$1</strong>');
}

function chatMsgHtml(m) {
  const mine = Number(m.sender_id) === Number(store.profile.id);
  if (m.kind === 'BOOKING') {
    return `<div class="booking-card-msg" data-msg="${m.id}">
      <div class="ref">${esc(m.booking_ref || 'Booking')}</div>
      <div class="line">${esc(m.body || '')}</div>
      <div class="line">${esc(m.sender_name)} · ${esc(timeLabel(m.created_at))}</div>
      ${m.booking_status ? `<div style="margin-top:6px">${statusPill(m.booking_status)}</div>` : ''}
      <div class="row">
        ${store.isRider ? `<button class="btn primary small" data-req="${m.booking_id}">Request</button>` : ''}
        <button class="btn small" data-openb="${m.booking_id}">Open job</button>
        ${store.isManager ? `<button class="btn ghost small" data-del="${m.id}">Delete</button>` : ''}
      </div>
    </div>`;
  }
  if (m.kind === 'SYSTEM') {
    return `<div class="msg system" data-msg="${m.id}"><div class="bubble">${esc(m.body || '')}</div></div>`;
  }
  return `<div class="msg${mine ? ' mine' : ''}" data-msg="${m.id}">
    <div class="bubble">
      ${mine ? '' : `<div class="who">${esc(m.sender_name)}${m.sender_role === 'MANAGER' ? ' 👔' : ''}</div>`}
      <div class="body">${m.deleted ? '<em style="color:var(--text-3)">message deleted</em>' : chatBodyHtml(m.body || '')}</div>
      <div class="t">${esc(timeLabel(m.created_at))}</div>
    </div>
  </div>`;
}

function wireChatMessages(scope) {
  const log = $('#chat-log', scope);
  if (!log) return;
  $$('[data-openb]', log).forEach((b) => {
    b.onclick = () => {
      const id = b.getAttribute('data-openb');
      location.hash = store.isManager ? `#/manager/bookings/${id}` : `#/rider/jobs/${id}`;
    };
  });
  $$('[data-req]', log).forEach((b) => {
    b.onclick = () => fire(riderRequestJob(Number(b.getAttribute('data-req'))));
  });
  $$('[data-del]', log).forEach((b) => {
    b.onclick = () => {
      fire((async () => {
        const ok = await confirmSheet('Delete this message?', 'It stays in the transcript as “message deleted”.', 'Delete', true);
        if (!ok) return;
        await run(() => api(`/api/chat/messages/${b.getAttribute('data-del')}`, { method: 'DELETE' }), 'Message deleted');
      })());
    };
  });
}

function appendChatMessage(m) {
  const log = $('#chat-log');
  if (!log) return;
  const id = Number(m.id);
  if (chatState.ids.has(id)) {
    // reconcile an optimistic bubble
    const existing = $(`[data-msg="${id}"]`, log);
    if (existing) {
      existing.outerHTML = chatMsgHtml(m);
      wireChatMessages($('#view'));
    }
    return;
  }
  const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 120;
  log.insertAdjacentHTML('beforeend', chatMsgHtml(m));
  chatState.ids.add(id);
  if (atBottom) scrollChat(true);
  else $('#new-pill').classList.remove('hidden');
  wireChatMessages($('#view'));
}

function scrollChat(force) {
  const log = $('#chat-log');
  if (!log) return;
  if (force) log.scrollTop = log.scrollHeight;
  const pill = $('#new-pill');
  if (pill && force) pill.classList.add('hidden');
}
const chatState = { ids: new Set(), oldest: null, atBottom: true, onlineUsers: new Set() };

function chatSkeleton() {
  return `
    <div class="chat-wrap">
      <div class="chat-header">
        <div class="chat-online">🟢 <span id="chat-online-count">${chatState.onlineUsers.size}</span> online</div>
        <div style="display:flex;gap:6px">
          <button class="btn small ghost" id="chat-people">Team</button>
          ${store.isManager ? '<button class="btn small ghost" id="chat-export">Export</button>' : ''}
        </div>
      </div>
      <div class="chat-log" id="chat-log"></div>
      <button class="new-pill hidden" id="new-pill">↓ New messages</button>
      <div class="composer">
        <textarea id="chat-input" rows="1" maxlength="500" placeholder="Message the team… use @name to mention"></textarea>
        <button class="send" id="chat-send" aria-label="Send">➤</button>
      </div>
    </div>`;
}

async function loadChatMessages(el, older) {
  const log = $('#chat-log', el);
  const before = older && chatState.oldest ? `&before_id=${chatState.oldest}` : '';
  const rows = await api(`/api/chat/messages?limit=50${before}`);
  if (!rows.length) return;
  if (older) {
    const h = log.scrollHeight;
    log.insertAdjacentHTML('afterbegin', rows.map(chatMsgHtml).join(''));
    rows.forEach((m) => chatState.ids.add(Number(m.id)));
    log.scrollTop = log.scrollHeight - h;
  } else {
    chatState.ids = new Set(rows.map((m) => Number(m.id)));
    log.innerHTML = rows.map(chatMsgHtml).join('');
  }
  const minId = Math.min(...rows.map((m) => Number(m.id)));
  chatState.oldest = chatState.oldest ? Math.min(chatState.oldest, minId) : minId;
  store.lastChatId = Math.max(store.lastChatId, ...rows.map((m) => Number(m.id) || 0));
  wireChatMessages(el);
}

async function sendChatMessage(text) {
  const log = $('#chat-log');
  if (!log || !text) return;
  const tmp = 'tmp-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  log.insertAdjacentHTML('beforeend', `
    <div class="msg mine pending" data-msg="${tmp}">
      <div class="bubble"><div class="body">${chatBodyHtml(text)}</div><div class="t">sending…</div></div>
    </div>`);
  scrollChat(true);
  try {
    const m = await api('/api/chat/messages', { method: 'POST', body: { body: text, client_msg_id: tmp } });
    const el = $(`[data-msg="${tmp}"]`, log);
    if (el) el.remove();
    appendChatMessage(m);
    scrollChat(true);
    haptic(10);
  } catch (err) {
    const el = $(`[data-msg="${tmp}"]`, log);
    if (el) { el.classList.remove('pending'); el.classList.add('failed'); }
    toast(err.message || 'Message failed to send', 'err');
    haptic([400, 200, 400]);
  }
}

function chatView(tabKey) {
  return {
    title: 'Team chat',
    tab: 'chat',
    chatMode: true,
    live: false,   // the chat patches itself from SSE — no full repaint
    async mount(el) {
      chatState.ids = new Set();
      chatState.oldest = null;
      el.innerHTML = chatSkeleton();
      const log = $('#chat-log', el);

      log.addEventListener('scroll', () => {
        if (log.scrollTop < 60 && chatState.oldest) fire(loadChatMessages(el, true));
      });
      $('#new-pill', el).onclick = () => scrollChat(true);

      try {
        await loadChatMessages(el, false);
      } catch (err) {
        log.innerHTML = emptyBox('💬', err.message || 'Could not load chat');
      }
      store.unread = 0;
      paintUnread();
      // Reading the room advances this device's cursor, so the badge stays 0
      // until someone actually says something new.
      writeLastChatId(store.lastChatId);
      scrollChat(true);

      api('/api/chat/online').then((list) => {
        chatState.onlineUsers = new Set(list.filter((x) => x.online).map((x) => Number(x.user_id)));
        const c = $('#chat-online-count');
        if (c) c.textContent = String(chatState.onlineUsers.size);
      }).catch(() => {});

      const input = $('#chat-input', el);
      const grow = () => { input.style.height = 'auto'; input.style.height = Math.min(input.scrollHeight, 110) + 'px'; };
      input.oninput = grow;
      input.onkeydown = (e) => {
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); }
      };
      const submit = () => {
        const text = input.value.trim();
        if (!text) return;
        input.value = '';
        grow();
        fire(sendChatMessage(text));
      };
      $('#chat-send', el).onclick = submit;

      $('#chat-people', el).onclick = () => fire(showTeamSheet());
      const exp = $('#chat-export', el);
      if (exp) exp.onclick = () => fire(downloadCsv('/api/chat/export', 'team-chat.txt'));
    },
  };
}

views[`manager/chat`] = chatView('manager');
views[`rider/chat`] = chatView('rider');
async function showTeamSheet() {
  let people = [];
  try { people = await api('/api/chat/participants'); } catch { people = []; }
  const sheet = openSheet(`
    <h3>Team · ${people.length}</h3>
    <div class="pick-list">${people.map((p) => `
      <div class="pick">
        <span class="avatar" style="width:34px;height:34px;font-size:12px">${esc(initials(p.name))}</span>
        <span class="grow">
          <span class="nm">${esc(p.name)}${p.role === 'MANAGER' ? ' 👔' : ''}</span>
          <span class="sub">@${esc(p.handle)} — tap to mention</span>
        </span>
      </div>`).join('') || '<div class="empty">Nobody else yet</div>'}
    </div>
    <div class="sheet-actions"><button class="btn primary" data-ok>Close</button></div>`);
  $('[data-ok]', sheet).onclick = () => closeSheet();
}

// ═══════════════════════════════════════════════════════════════════════════════
// 21. MANAGER — audit history (§6.10.4)
// ═══════════════════════════════════════════════════════════════════════════════
const HISTORY_TYPES = [
  { key: '', label: 'Everything' },
  { key: 'BOOKING', label: 'Bookings' },
  { key: 'PAYOUT', label: 'Payouts' },
  { key: 'RIDER', label: 'Riders' },
  { key: 'SETTING', label: 'Settings' },
  { key: 'DAY', label: 'Days' },
];
let historyFilter = { type: '', q: '', page: 1, rows: [], total: 0 };

function historyRowsHtml(rows) {
  if (!rows.length) return emptyBox('🧾', 'Nothing recorded yet');
  let lastDay = '';
  return rows.map((r) => {
    const dayHeader = r.day !== lastDay ? `<div class="section-title">${esc(r.day || '')}</div>` : '';
    lastDay = r.day;
    return `${dayHeader}
      <div class="card tight">
        <div style="display:flex;justify-content:space-between;gap:10px">
          <div style="min-width:0">
            <div style="font-weight:700;font-size:14px">${esc(r.message || r.type)}</div>
            <div style="font-size:12.5px;color:var(--text-3)">
              ${esc(r.actor_name || 'System')} · ${esc(r.type)}${r.ref ? ` · ${esc(r.ref)}` : ''}
              ${r.from_status && r.to_status ? ` · ${esc(r.from_status)} → ${esc(r.to_status)}` : ''}
            </div>
          </div>
          <div style="text-align:right;white-space:nowrap">
            ${r.amount_delta != null ? `<div class="money" style="font-weight:800;color:${Number(r.amount_delta) < 0 ? 'var(--red)' : 'var(--green)'}">${Number(r.amount_delta) < 0 ? '−' : '+'}${peso(Math.abs(Number(r.amount_delta)))}</div>` : ''}
            <div style="font-size:12px;color:var(--text-3)">${esc(r.time || '')}</div>
          </div>
        </div>
      </div>`;
  }).join('');
}

views['manager/history'] = {
  title: 'History',
  tab: 'history',
  async mount(el) {
    const qs = new URLSearchParams({ page: String(historyFilter.page), page_size: '50' });
    if (historyFilter.type) qs.set('type', historyFilter.type);
    if (historyFilter.q) qs.set('q', historyFilter.q);

    const out = await api(`/api/manager/history?${qs}`);
    if (historyFilter.page === 1) historyFilter.rows = out.rows;
    else historyFilter.rows = [...historyFilter.rows, ...out.rows];
    historyFilter.total = out.total;

    el.innerHTML = `
      <div class="chip-row">
        ${HISTORY_TYPES.map((t) => `<button class="chip${historyFilter.type === t.key ? ' active' : ''}" data-htype="${t.key}">${esc(t.label)}</button>`).join('')}
      </div>
      <div class="field" style="margin-bottom:12px">
        <input id="hq" type="search" placeholder="Search the ledger" value="${esc(historyFilter.q)}">
      </div>
      <div class="section-title">
        <span>${historyFilter.total} record${historyFilter.total === 1 ? '' : 's'}</span>
        <button class="btn small ghost" id="h-csv">Export CSV</button>
      </div>
      ${historyRowsHtml(historyFilter.rows)}
      ${historyFilter.rows.length < historyFilter.total ? '<button class="btn block" id="h-more">Load more</button>' : ''}
    `;

    $$('[data-htype]', el).forEach((b) => {
      b.onclick = () => {
        historyFilter = { type: b.getAttribute('data-htype'), q: historyFilter.q, page: 1, rows: [], total: 0 };
        fire(refreshCurrent());
      };
    });
    const hq = $('#hq', el);
    let t = null;
    hq.oninput = () => {
      clearTimeout(t);
      t = setTimeout(() => {
        historyFilter = { type: historyFilter.type, q: hq.value.trim(), page: 1, rows: [], total: 0 };
        fire(refreshCurrent());
      }, 420);
    };
    const more = $('#h-more', el);
    if (more) more.onclick = () => { historyFilter.page += 1; fire(refreshCurrent()); };

    $('#h-csv', el).onclick = () => {
      const cq = new URLSearchParams();
      if (historyFilter.type) cq.set('type', historyFilter.type);
      if (historyFilter.q) cq.set('q', historyFilter.q);
      fire(downloadCsv(`/api/manager/history.csv?${cq}`, 'booking-history.csv'));
    };
  },
};
// ═══════════════════════════════════════════════════════════════════════════════
// 22. Push subscription (§6.11.4 — only BOOKING cards and @mentions push)
// ═══════════════════════════════════════════════════════════════════════════════
function urlBase64ToUint8Array(base64) {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(b64);
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}

async function enablePush() {
  try {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
      toast('Push is not supported on this device', 'err');
      return;
    }
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') { toast('Notifications were blocked', 'err'); return; }
    if (!store.config.vapid_public_key) { toast('Push is not configured on the server', 'err'); return; }
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(store.config.vapid_public_key),
    });
    const json = sub.toJSON();
    await api('/api/push/subscribe', { method: 'POST', body: { endpoint: json.endpoint, keys: json.keys } });
    toast('Notifications are on', 'ok');
  } catch (err) {
    toast(err.message || 'Could not enable notifications', 'err');
  }
}

async function disablePush() {
  try {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    if (sub) {
      await api('/api/push/unsubscribe', { method: 'POST', body: { endpoint: sub.endpoint } });
      await sub.unsubscribe();
    }
    toast('Notifications are off', 'ok');
  } catch (err) {
    toast(err.message || 'Could not turn notifications off', 'err');
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// 23. MANAGER — settings (§6.8). Every change applies instantly, no redeploy.
// ═══════════════════════════════════════════════════════════════════════════════
const SETTINGS_SPEC = [
  {
    group: 'Commission',
    note: 'Changes apply to NEW bookings only — past earnings are never rewritten.',
    items: [
      { key: 'booking_commission_enabled', type: 'toggle', label: 'Commission enabled' },
      { key: 'commission_rate', type: 'number', label: 'Commission rate (%)', commission: true },
    ],
  },
  {
    group: 'Money display',
    items: [
      { key: 'booking_currency_symbol', type: 'text', label: 'Currency symbol' },
      { key: 'booking_show_rider_earnings', type: 'toggle', label: "Riders can see their own earnings" },
    ],
  },
  {
    group: 'Dispatch rules',
    items: [
      { key: 'booking_max_concurrent', type: 'number', label: 'Max concurrent jobs per rider' },
      { key: 'booking_auto_reject_others_on_approve', type: 'toggle', label: 'Auto-reject other requests on approve' },
    ],
  },
  {
    group: 'Live & presence',
    note: 'A rider is online while their last heartbeat is younger than the TTL.',
    items: [
      { key: 'booking_heartbeat_ms', type: 'number', label: 'Heartbeat every (ms)' },
      { key: 'booking_presence_ttl_s', type: 'number', label: 'Green dot lasts (s)' },
      { key: 'booking_sweep_ms', type: 'number', label: 'Server sweep every (ms)' },
    ],
  },
  {
    group: 'History & locale',
    note: 'The store timezone decides what “today” means for the dispatch day.',
    items: [
      { key: 'store_timezone', type: 'text', label: 'Store timezone', placeholder: 'Asia/Manila' },
      { key: 'booking_history_page_size', type: 'number', label: 'History rows per page' },
      { key: 'day_cutoff_hour', type: 'number', label: 'Day cutoff hour (0–23)' },
      { key: 'auto_rollover', type: 'toggle', label: 'Roll the day over at the cutoff' },
    ],
  },
  {
    group: 'Privacy',
    items: [
      { key: 'booking_open_jobs_show_address', type: 'toggle', label: 'Show address on unassigned jobs' },
    ],
  },
  {
    group: 'Notifications',
    items: [
      { key: 'notify_new_job', type: 'toggle', label: 'New job on the board' },
      { key: 'notify_request_received', type: 'toggle', label: 'A rider requests a job' },
      { key: 'notify_request_approved', type: 'toggle', label: 'Request approved' },
      { key: 'notify_assigned', type: 'toggle', label: 'A job was assigned to you' },
      { key: 'notify_job_status', type: 'toggle', label: 'Job status changed' },
      { key: 'notify_payout', type: 'toggle', label: 'Payout recorded' },
    ],
  },
  {
    group: 'Chat push',
    note: 'Plain chatter is never pushed — only these two exceptions.',
    items: [
      { key: 'push_chat_enabled', type: 'toggle', label: 'Chat push master switch' },
      { key: 'push_chat_booking_cards', type: 'toggle', label: 'Push BOOKING cards' },
      { key: 'push_chat_mentions', type: 'toggle', label: 'Push @mentions of me' },
    ],
  },
  {
    group: 'Store',
    items: [{ key: 'store_label', type: 'text', label: 'Store name in the header' }],
  },
];
/**
 * Client-side mirror of validateSetting() in services/settings.ts. Settings
 * commit on BLUR, so a stray tap could otherwise persist a half-typed value
 * ("1" while the manager meant "15") — on commission_rate that is a money bug.
 * The server validates too; this only avoids a pointless round-trip and lets
 * the field visibly revert.
 */
function validateSettingInput(key, value) {
  const ranges = {
    commission_rate: [0, 100],
    booking_max_concurrent: [1, 50],
    booking_heartbeat_ms: [5000, 300000],
    booking_presence_ttl_s: [10, 3600],
    booking_sweep_ms: [5000, 600000],
    booking_history_page_size: [5, 200],
    day_cutoff_hour: [0, 23],
  };
  const range = ranges[key];
  if (range) {
    const n = Number(value);
    if (String(value).trim() === '' || !Number.isFinite(n)) return 'Enter a number';
    if (n < range[0] || n > range[1]) return `Must be between ${range[0]} and ${range[1]}`;
    return null;
  }
  if (key === 'store_timezone') {
    const v = String(value).trim();
    if (!v) return 'Enter a timezone, e.g. Asia/Manila';
    try { new Intl.DateTimeFormat('en-CA', { timeZone: v }); }
    catch { return `"${v}" is not a valid IANA timezone`; }
    return null;
  }
  if (key === 'booking_currency_symbol') {
    if (!String(value).trim()) return 'Enter a currency symbol';
    if (String(value).length > 4) return 'Keep the symbol short (4 characters max)';
    return null;
  }
  if (String(value).length > 64) return 'Keep it under 64 characters';
  return null;
}

function settingRow(item, settings) {
  const raw = settings[item.key] != null ? String(settings[item.key]) : '';
  if (item.type === 'toggle') {
    const on = raw === '1' || raw === 'true';
    return `<label class="kv" style="align-items:center;cursor:pointer">
      <span class="k">${esc(item.label)}</span>
      <input type="checkbox" data-set-toggle="${item.key}" ${on ? 'checked' : ''}
             style="width:22px;height:22px;flex:0 0 auto">
    </label>`;
  }
  return `<label class="kv" style="align-items:center">
    <span class="k">${esc(item.label)}</span>
    <input data-set-input="${item.key}" data-set-type="${item.type}" data-set-orig="${esc(raw)}"
           type="text" ${item.type === 'number' ? 'inputmode="numeric"' : ''}
           aria-label="${esc(item.label)}"
           value="${esc(raw)}" placeholder="${esc(item.placeholder || '')}"
           style="width:46%;text-align:right;background:var(--bg-2);border:1px solid var(--line);
                  border-radius:9px;padding:9px 11px;color:var(--text);font:inherit">
  </label>`;
}

views['manager/settings'] = {
  title: 'Settings',
  tab: 'settings',
  live: false,
  async mount(el) {
    const cfg = await api('/api/config');
    store.config = cfg;
    const settings = cfg.settings || {};

    el.innerHTML = `
      <div class="card tight">
        <div class="kv"><span class="k">Commission now</span><span class="v">${peso(cfg.commission_rate)} per ${peso(1000)} booking</span></div>
        <div class="kv"><span class="k">Rider sees</span><span class="v">${peso(1000 - cfg.commission_rate * 10)} per ${peso(1000)} booking</span></div>
      </div>

      ${SETTINGS_SPEC.map((g) => `
        ${section(g.group, `<div class="card tight">
          ${g.note ? `<div style="font-size:12.5px;color:var(--text-3);margin-bottom:6px">${esc(g.note)}</div>` : ''}
          ${g.items.map((it) => settingRow(it, settings)).join('')}
        </div>`)}
      `).join('')}

      ${section('Notifications on this device', `<div class="card tight">
        <div class="kv"><span class="k">Push supported</span><span class="v">${('PushManager' in window) ? 'yes' : 'no'}</span></div>
        <div class="kv"><span class="k">Server push configured</span><span class="v">${cfg.push_enabled ? 'yes' : 'no'}</span></div>
        <div class="kv"><span class="k">Permission</span><span class="v">${('Notification' in window) ? Notification.permission : 'n/a'}</span></div>
        <div style="display:flex;gap:8px;margin-top:12px">
          <button class="btn primary small" id="push-on">Enable notifications</button>
          <button class="btn ghost small" id="push-off">Turn off</button>
        </div>
      </div>`)}

      ${section('Alerts', alertPrefsHtml())}

      ${section('Display', `<div class="card tight">
        <label class="kv" style="align-items:center;cursor:pointer">
          <span class="k">Sound on this device</span>
          <input type="checkbox" id="pref-sound" ${store.sound ? 'checked' : ''} style="width:22px;height:22px">
        </label>
        <div class="section-title" style="margin-top:14px">Appearance</div>
        <div class="theme-picker" role="group" aria-label="Colour theme">
          ${['dark', 'light', 'system'].map((t) => `
            <button class="chip${(store.theme || 'dark') === t ? ' active' : ''}" data-theme-set="${t}"
                    aria-pressed="${(store.theme || 'dark') === t}">${t[0].toUpperCase() + t.slice(1)}</button>`).join('')}
        </div>
        <div class="range-note">
          Riders work nights and daylight. “System” follows this phone’s
          ${prefersLight() ? 'light' : 'dark'} setting and updates as it changes.
        </div>
      </div>`)}

      ${section('App', `<div class="card tight">
        <div class="kv"><span class="k">Version</span><span class="v">${esc(cfg.version || '—')}</span></div>
        <div class="kv"><span class="k">Store</span><span class="v">${esc(cfg.store_label || '—')}</span></div>
        <div class="kv"><span class="k">Server timezone</span><span class="v">${esc(cfg.store_timezone || '—')}</span></div>
        ${cfg.today_ref ? `<div class="kv"><span class="k">Right now, “today” is</span><span class="v">${esc(cfg.today_ref)}</span></div>` : ''}
        ${cfg.day_preview ? `<div class="range-note">${esc(cfg.day_preview)}</div>` : ''}
        <button class="btn ghost block small" id="check-update" style="margin-top:12px">Check for an update</button>
      </div>`)}

      ${section('Danger zone', `<div class="card tight">
        <div style="font-size:13px;color:var(--text-2)">
          There is no hard-delete in this app. Bookings are archived, never removed, and past
          earnings are never rewritten. Destructive database work is deliberately not exposed here.
        </div>
      </div>`)}

      <button class="btn ghost block" id="logout-2" style="margin-top:6px">Sign out</button>
    `;

    // ── setting writers ────────────────────────────────────────────────────────
    $$('[data-set-toggle]', el).forEach((c) => {
      c.onchange = () => {
        const key = c.getAttribute('data-set-toggle');
        fire(run(
          () => api(`/api/manager/settings/${key}`, { method: 'PUT', body: { value: c.checked ? '1' : '0' } }),
          'Setting saved',
        ).then(() => refreshConfig().catch(() => {})));
      };
    });
    $$('[data-set-input]', el).forEach((i) => {
      const key = i.getAttribute('data-set-input');
      const revert = (msg) => {
        i.value = i.getAttribute('data-set-orig') || '';   // never leave a bad value on screen
        i.style.borderColor = 'var(--red)';
        toast(msg, 'err');
        setTimeout(() => { i.style.borderColor = ''; }, 1600);
      };
      const commit = () => {
        const value = i.value.trim();
        const original = i.getAttribute('data-set-orig') || '';
        if (value === original) return;                       // nothing typed → no write
        const bad = validateSettingInput(key, value);
        if (bad) { revert(bad); return; }
        const call = key === 'commission_rate'
          ? api('/api/manager/commission', { method: 'POST', body: { rate: Number(value) } })
          : api(`/api/manager/settings/${key}`, { method: 'PUT', body: { value } });
        fire(run(() => call, 'Setting saved').then(() => {
          i.setAttribute('data-set-orig', value);             // the new baseline for a later revert
          refreshConfig().catch(() => {});
        }).catch(() => { revert('Not saved — the value was rejected'); }));
      };
      i.onblur = commit;
      i.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); i.blur(); } };
      i.oninput = () => { i.style.borderColor = ''; };
    });

    $('#push-on', el).onclick = () => fire(enablePush());
    $('#push-off', el).onclick = () => fire(disablePush());
    const sound = $('#pref-sound', el);
    sound.onchange = () => {
      store.sound = sound.checked;
      localStorage.setItem('bk_sound', store.sound ? '1' : '0');
      if (store.sound) chime('ok');
      toast(store.sound ? 'Sound on' : 'Sound off', 'ok');
    };
    bindAlertPrefs(el);
    $('#check-update', el).onclick = () => fire(checkForUpdate(true));
    $$('[data-theme-set]', el).forEach((b) => {
      b.onclick = () => {
        haptic(10);
        setTheme(b.getAttribute('data-theme-set'));
        // repaint just this group so the pressed state stays truthful
        $$('[data-theme-set]', el).forEach((x) => {
          const on = x.getAttribute('data-theme-set') === store.theme;
          x.classList.toggle('active', on);
          x.setAttribute('aria-pressed', String(on));
        });
      };
    });
    $('#logout-2', el).onclick = () => logout();
  },
};
// ═══════════════════════════════════════════════════════════════════════════════
// 24. MANAGER — own profile (§6.8)
// ═══════════════════════════════════════════════════════════════════════════════
function commissionKwHtml(c) {
  return `
    <div class="kv"><span class="k">Accrued</span><span class="v money">${peso(c.accrued)}</span></div>
    <div class="kv"><span class="k">Paid out to riders</span><span class="v money">${peso(c.paid)}</span></div>
    <div class="kv total"><span class="k">Unpaid (still held)</span><span class="v money">${peso(c.unpaid)}</span></div>
    <div class="kv"><span class="k">Delivered jobs</span><span class="v">${Number(c.jobs || 0)}</span></div>`;
}

views['manager/profile'] = {
  title: 'My profile',
  tab: 'profile',
  async mount(el) {
    const monthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString();
    const [me, all, month, sessions] = await Promise.all([
      api('/api/me'),
      api('/api/manager/commission'),
      api(`/api/manager/commission?from=${encodeURIComponent(monthStart)}`),
      api('/api/sessions').catch(() => []),
    ]);
    store.profile = Object.assign({}, store.profile, me);
    store.save();
    const topRiders = (all.by_rider || []).slice(0, 8);

    el.innerHTML = `
      <div class="card">
        <div style="display:flex;gap:12px;align-items:center">
          <span class="avatar" style="width:52px;height:52px;font-size:18px">${esc(initials(me.full_name))}</span>
          <div>
            <div style="font-weight:800;font-size:18px">${esc(me.full_name)}</div>
            <div style="color:var(--text-3);font-size:13px">@${esc(me.username)} · ${esc(me.role)}</div>
          </div>
        </div>
      </div>

      ${section('This month', `<div class="card tight">${commissionKwHtml(month)}</div>`)}
      ${section('All time', `<div class="card tight">${commissionKwHtml(all)}</div>`)}

      ${topRiders.length ? section('Commission by rider', `<div class="card tight">
        ${topRiders.map((r) => `<div class="kv">
            <span class="k">${esc(r.full_name || 'Rider')} <span style="color:var(--text-3)">· ${Number(r.jobs)} jobs</span></span>
            <span class="v">${peso(r.accrued)} accrued</span>
          </div>`).join('')}
      </div>`) : ''}

      ${section('Security', `<div class="card tight">
        <button class="btn block small" id="chg-pw" style="margin-bottom:10px">Change my password</button>
        <div style="font-size:12.5px;color:var(--text-3);margin-bottom:6px">Active sessions · ${(sessions || []).length}</div>
        ${(sessions || []).slice(0, 6).map((s) => `<div class="kv">
            <span class="k">Session #${s.id}</span>
            <span class="v" style="font-size:12.5px">${esc(dateTimeLabel(s.created_at))}</span>
          </div>`).join('')}
        <button class="btn danger block small" id="revoke" style="margin-top:10px">Sign out all other devices</button>
      </div>`)}

      ${section('Preferences', `<div class="card tight">
        <label class="kv" style="align-items:center;cursor:pointer">
          <span class="k">Sound alerts</span>
          <input type="checkbox" id="pf-sound" ${store.sound ? 'checked' : ''} style="width:22px;height:22px">
        </label>
        <label class="kv" style="align-items:center;cursor:pointer">
          <span class="k">Vibration</span>
          <input type="checkbox" id="pf-haptic" ${localStorage.getItem('bk_haptic') !== '0' ? 'checked' : ''} style="width:22px;height:22px">
        </label>
      </div>`)}

      ${section('Alerts', alertPrefsHtml())}

      ${section('About', `<div class="card tight">
        <div class="kv"><span class="k">App version</span><span class="v">${esc(store.config.version || '—')}</span></div>
        <div class="kv"><span class="k">Server</span><span class="v" id="health-line">checking…</span></div>
        <div class="kv"><span class="k">Riders online</span><span class="v">${store.online.size}</span></div>
      </div>`)}

      <button class="btn ghost block" id="pf-logout" style="margin-top:6px">Sign out</button>
    `;

    $('#chg-pw', el).onclick = () => fire(changePasswordSheet());
    $('#revoke', el).onclick = () => fire((async () => {
      const ok = await confirmSheet('Sign out other devices?', 'Every session except this one is revoked.', 'Sign out others', true);
      if (!ok) return;
      await run(
        () => api('/api/sessions/revoke-all', { method: 'POST', body: { keep_refresh: store.refreshToken } }),
        'Other sessions signed out',
      );
    }));
    $('#pf-sound', el).onchange = (e) => {
      store.sound = e.target.checked;
      localStorage.setItem('bk_sound', store.sound ? '1' : '0');
    };
    $('#pf-haptic', el).onchange = (e) => {
      localStorage.setItem('bk_haptic', e.target.checked ? '1' : '0');
      if (e.target.checked) haptic([10]);
    };
    bindAlertPrefs(el);
    $('#pf-logout', el).onclick = () => logout();

    fetch('/health').then((r) => r.json()).then((h) => {
      const line = $('#health-line');
      if (line) line.textContent = `${h.ok ? 'ok' : 'down'} · ${h.sse_clients} live · push ${h.push ? 'on' : 'off'}`;
    }).catch(() => {
      const line = $('#health-line');
      if (line) line.textContent = 'unreachable';
    });
  },
};
function changePasswordSheet() {
  const sheet = openSheet(`
    <h3>Change password</h3>
    <div class="field"><span>Current password</span><input id="cp-old" type="password" autocomplete="current-password"></div>
    <div class="field"><span>New password</span><input id="cp-new" type="password" minlength="8" autocomplete="new-password" placeholder="at least 8 characters"></div>
    <div class="field"><span>Confirm new password</span><input id="cp-conf" type="password" minlength="8" autocomplete="new-password"></div>
    <div class="form-error hidden" data-err></div>
    <div class="sheet-actions">
      <button class="btn ghost" data-no>Cancel</button>
      <button class="btn primary" data-yes>Save password</button>
    </div>`);
  $('[data-no]', sheet).onclick = () => closeSheet();
  $('[data-yes]', sheet).onclick = () => {
    const oldPw = $('#cp-old', sheet).value;
    const nw = $('#cp-new', sheet).value;
    const cf = $('#cp-conf', sheet).value;
    const err = $('[data-err]', sheet);
    const fail = (m) => { err.textContent = m; err.classList.remove('hidden'); };
    if (nw.length < 8) { fail('New password must be at least 8 characters'); return; }
    if (nw !== cf) { fail('The two passwords do not match'); return; }
    closeSheet();
    fire(run(
      () => api('/api/change-password', { method: 'POST', body: { current_password: oldPw, new_password: nw } }),
      'Password changed',
    ));
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// 25. MANAGER — the "More" hub
// ═══════════════════════════════════════════════════════════════════════════════
const MORE_LINKS = [
  { href: '#/manager/new', icon: '＋', label: 'New booking', note: 'Paste a Messenger booking' },
  { href: '#/manager/requests', icon: '🔔', label: 'Requests', note: 'Waiting on your approval' },
  { href: '#/manager/riders', icon: '🏍', label: 'Riders', note: 'Roster, money and payouts' },
  { href: '#/manager/history', icon: '🧾', label: 'History', note: 'The full audit ledger' },
  { href: '#/manager/days', icon: '📅', label: 'Dispatch days', note: 'Close, open, reopen' },
  { href: '#/manager/settings', icon: '⚙️', label: 'Settings', note: 'Commission, presence, alerts' },
  { href: '#/manager/profile', icon: '👔', label: 'My profile', note: 'My commission and security' },
];

views['manager/more'] = {
  title: 'More',
  tab: 'more',
  live: false,
  async mount(el) {
    el.innerHTML = MORE_LINKS.map((l) => `
      <button class="card tight clickable" data-href="${l.href}" style="width:100%;text-align:left;display:flex;gap:12px;align-items:center">
        <span style="font-size:22px">${l.icon}</span>
        <span style="flex:1">
          <span style="display:block;font-weight:700">${esc(l.label)}</span>
          <span style="display:block;font-size:12.5px;color:var(--text-3)">${esc(l.note)}</span>
        </span>
        <span style="color:var(--text-3)">›</span>
      </button>`).join('') +
      `<div class="card tight" style="text-align:center;color:var(--text-3);font-size:12.5px">
        Postre Booking ${esc(store.config.version || '')} · ${esc(store.config.store_label || '')}
      </div>`;

    $$('[data-href]', el).forEach((b) => {
      b.onclick = () => { haptic(10); location.hash = b.getAttribute('data-href'); };
    });
  },
};
// ═══════════════════════════════════════════════════════════════════════════════
// 26. MANAGER — dispatch days (§9.8)
// ═══════════════════════════════════════════════════════════════════════════════
views['manager/days'] = {
  title: 'Dispatch days',
  tab: 'days',
  async mount(el) {
    const days = await api('/api/manager/days?limit=30');
    const open = days.find((d) => d.status === 'OPEN');

    el.innerHTML = `
      <div class="card">
        ${open ? `
          <div class="kv"><span class="k">Open day</span><span class="v">${esc(open.date_ref)}</span></div>
          <div class="kv"><span class="k">Opened at</span><span class="v">${esc(dateTimeLabel(open.opened_at))}</span></div>
          <p style="font-size:13px;color:var(--text-2);margin-top:8px">
            Closing freezes this day's totals forever. A day with active bookings cannot be closed.
          </p>
          <button class="btn danger block" id="close-day" style="margin-top:10px">Close ${esc(open.date_ref)}</button>`
        : '<div class="empty">No day is open right now</div>'}
      </div>
      <div class="section-title">History</div>
      <div id="day-list">
        ${days.map((d) => `
          <div class="card tight">
            <div style="display:flex;justify-content:space-between;align-items:center;gap:10px">
              <div>
                <div style="font-weight:800">${esc(d.date_ref)}</div>
                <div style="font-size:12.5px;color:var(--text-3)">
                  ${esc(d.status)}${d.closed_at ? ` · closed ${esc(dateTimeLabel(d.closed_at))}` : ''}
                  ${d.totals_snapshot ? ' · totals frozen' : ''}
                </div>
              </div>
              <div style="display:flex;gap:6px">
                ${d.status === 'OPEN' ? '' : `<button class="btn ghost small" data-day="${d.id}">Open</button>`}
                ${d.status === 'CLOSED' ? `<button class="btn ghost small" data-reopen="${d.id}">Reopen</button>` : ''}
              </div>
            </div>
          </div>`).join('') || emptyBox('📅', 'No dispatch days yet')}
      </div>
      <p style="color:var(--text-3);font-size:12.5px;text-align:center;margin-top:14px">
        Days roll over automatically at the cutoff hour — see Settings.
      </p>
    `;

    const close = $('#close-day', el);
    if (close) {
      close.onclick = () => {
        fire((async () => {
          const ok = await confirmSheet(
            `Close ${open.date_ref}?`,
            'This freezes the day forever. Only a day closed in the last 2 hours can be reopened.',
            'Close day', true,
          );
          if (!ok) return;
          await run(
            () => api(`/api/manager/days/${open.id}/close`, { method: 'POST', body: { confirm: 'CLOSE' } }),
            'Day closed',
          );
        })());
      };
    }
    $$('[data-day]', el).forEach((b) => {
      b.onclick = () => fire((async () => {
        const day = days.find((d) => Number(d.id) === Number(b.getAttribute('data-day')));
        const ok = await confirmSheet(`Open ${day.date_ref}?`, 'The board becomes this day.', 'Open day');
        if (!ok) return;
        await run(
          () => api('/api/manager/days/open', { method: 'POST', body: { date_ref: day.date_ref } }),
          'Day opened',
        );
      })());
    });
    $$('[data-reopen]', el).forEach((b) => {
      b.onclick = () => fire((async () => {
        const day = days.find((d) => Number(d.id) === Number(b.getAttribute('data-reopen')));
        const ok = await confirmSheet(
          `Reopen ${day.date_ref}?`,
          'Reopening changes an already-reported figure, so it is written to the audit ledger.',
          'Reopen', true,
        );
        if (!ok) return;
        await run(() => api(`/api/manager/days/${day.id}/reopen`, { method: 'POST' }), 'Day reopened');
      })());
    });
  },
};
// ═══════════════════════════════════════════════════════════════════════════════
// 27. RIDER — helpers + home (§10.3)
// ═══════════════════════════════════════════════════════════════════════════════
function riderPrimary(b) {
  if (b.status === 'ASSIGNED') return { label: '✅ Accept job', act: 'accept', cls: 'success' };
  if (b.status === 'ACCEPTED') return { label: '📦 Mark picked up', act: 'pickup', cls: 'primary' };
  if (b.status === 'PICKED_UP') return { label: '🎉 Mark delivered', act: 'deliver', cls: 'primary' };
  return null;
}

function riderAction(id, act, label) {
  // The rider lifecycle is queued rather than refused: a rider on a moving bike
  // on mobile data must be able to tap "Delivered" and trust it lands.
  const attempt = () => api(`/api/rider/jobs/${id}/${act}`, { method: 'POST' });
  return (async () => {
    if (!navigator.onLine) {
      if (queueRiderAction(id, act, label)) {
        toast('Offline — queued, it will send when you reconnect', 'err');
        haptic([200, 100, 200]);
      }
      return;
    }
    try {
      await run(attempt, label);
    } catch (err) {
      // A network failure mid-flight is the case run() cannot recover: queue it.
      if (err && !err.status && queueRiderAction(id, act, label)) {
        toast('No connection — queued, it will send when you reconnect', 'err');
        haptic([200, 100, 200]);
        return;
      }
      throw err;
    }
  })();
}

function riderDecline(id, ref) {
  return (async () => {
    const reason = await promptSheet(`Decline ${ref}`, {
      label: 'Reason (the manager sees it)', placeholder: 'e.g. too far from my area',
    });
    if (reason == null) return;
    await run(() => api(`/api/rider/jobs/${id}/decline`, { method: 'POST', body: { reason } }), 'Job declined');
  })();
}

/** Rider requests an open job. One live claim per rider (server-enforced). */
async function riderRequestJob(id) {
  const note = await promptSheet('Request this job', {
    label: 'Note for the manager (optional)', required: false, placeholder: 'e.g. I am 5 minutes away',
  });
  if (note == null) return;
  const bk = findBooking(id);
  await run(
    () => api(`/api/rider/jobs/${id}/request`, { method: 'POST', body: { note, ref: bk ? bk.ref : undefined } }),
    'Request sent',
  );
}

function riderJobActions(b) {
  const p = riderPrimary(b);
  if (!p) return `<div class="bk-actions"><button class="btn primary small" data-rjob="${b.id}">Open job</button></div>`;
  return `<div class="bk-actions">
      <button class="btn ${p.cls} small" data-act="${p.act}" data-id="${b.id}">${p.label}</button>
      ${b.nav ? `<button class="btn small maps" data-nav-app="${b.id}" aria-label="Navigate to the drop-off pin">🗺️</button>` : ''}
      <button class="btn ghost small" data-rjob="${b.id}">Details</button>
    </div>`;
}

function riderWireCards(el) {
  $$('[data-rjob]', el).forEach((b) => {
    b.onclick = () => { haptic(10); location.hash = `#/rider/jobs/${b.getAttribute('data-rjob')}`; };
  });
  $$('[data-act]', el).forEach((b) => {
    b.onclick = () => {
      const id = Number(b.getAttribute('data-id'));
      const act = b.getAttribute('data-act');
      const label = act === 'accept' ? 'Job accepted' : (act === 'pickup' ? 'Picked up' : 'Delivered — commission accrued');
      fire(riderAction(id, act, label));
    };
  });
  $$('[data-nav-app]', el).forEach((b) => {
    b.onclick = () => {
      const bk = findBooking(b.getAttribute('data-nav-app'));
      if (bk) openNav(bk.waze_app, bk.waze_https);
    };
  });
}

/** Section wrapped in a scroll anchor, so the stat strip can jump to it. */
function sec(id, title, body) {
  return `<div id="${id}">${section(title, body)}</div>`;
}

/** The open board as it appears on the rider Dashboard. */
function openSection(open) {
  return open.length
    ? open.map((b) => bkCard(b, {
      actions: `<div class="bk-actions">
          <button class="btn primary small" data-request="${b.id}">Request this job</button>
        </div>`,
    })).join('')
    : emptyBox('🔓', 'No open jobs right now — the next booking will appear here');
}

views['rider/home'] = {
  title: 'Dashboard',
  tab: 'home',
  async mount(el) {
    const home = await api('/api/rider/home');
    store.home = home;
    indexBookings([home.ongoing, home.claimed, home.closed, home.open]);

    const earnings = home.earnings;
    const reqs = home.requests || [];
    const ongoing = home.ongoing || [];
    const claimed = home.claimed || [];
    const open = home.open || [];
    const mine = ongoing.length + claimed.length;
    // A rider with nothing on them has nothing to do but pick up work, so the
    // open board leads; otherwise the job in hand comes first.
    const openFirst = mine === 0;

    el.innerHTML = `
      ${earnings ? `<div class="owed-banner" style="background:linear-gradient(135deg,rgba(61,220,132,.14),rgba(61,220,132,.04));border-color:rgba(61,220,132,.4)">
        <div>
          <div class="lbl" style="color:var(--green)">💰 My earnings</div>
          <div class="amt" style="color:var(--text)">${peso(earnings.owed)}</div>
          <div class="sub">owed · ${peso(earnings.earned)} earned all time</div>
        </div>
        <button class="btn ghost small" id="go-earnings">Details</button>
      </div>` : ''}

      ${reqs.length ? `<div id="sec-waiting">${section(`Waiting on the manager · ${reqs.length}`, reqs.map((r) => `
        <div class="req-card">
          <div class="req-top"><div class="req-name">You requested a job</div>
            ${r.note ? `<div class="req-note">“${esc(r.note)}”</div>` : ''}</div>
          <div class="req-actions">
            <button class="btn ghost small" data-withdraw="${r.id}">Withdraw request</button>
          </div>
        </div>`).join(''))}</div>` : ''}

      <div class="stat-grid" style="grid-template-columns:repeat(3,1fr)">
        <button class="stat ongoing" data-scroll="sec-mine"><span class="n">${mine}</span><span class="l">On you</span></button>
        <button class="stat open" data-scroll="sec-open"><span class="n">${open.length}</span><span class="l">Open jobs</span></button>
        <button class="stat claimed" data-scroll="sec-waiting"><span class="n">${reqs.length}</span><span class="l">Waiting</span></button>
      </div>

      ${openFirst
        ? sec('sec-open', `Open jobs · ${open.length}`, openSection(open))
          + sec('sec-mine', `My jobs · ${mine}`, mine
            ? [...ongoing, ...claimed].map((b) => bkCard(b, { actions: riderJobActions(b) })).join('')
            : emptyBox('🛵', 'No job on you right now — pick one from the open board'))
        : sec('sec-mine', `My jobs · ${mine}`, mine
            ? [...ongoing, ...claimed].map((b) => bkCard(b, { actions: riderJobActions(b) })).join('')
            : emptyBox('🛵', 'No job on you right now — pick one from the open board'))
          + sec('sec-open', `Open jobs · ${open.length}`, openSection(open))}
    `;

    riderWireCards(el);
    const ge = $('#go-earnings', el);
    if (ge) ge.onclick = () => { location.hash = '#/rider/profile'; };

    $$('[data-request]', el).forEach((b) => {
      b.onclick = () => fire(riderRequestJob(Number(b.getAttribute('data-request'))));
    });
    $$('[data-scroll]', el).forEach((b) => {
      b.onclick = () => {
        const target = $('#' + b.getAttribute('data-scroll'), el);
        if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
      };
    });
    $$('[data-withdraw]', el).forEach((b) => {
      b.onclick = () => fire((async () => {
        const ok = await confirmSheet('Withdraw this request?', 'The manager will no longer see it.', 'Withdraw');
        if (!ok) return;
        await run(
          () => api(`/api/rider/requests/${b.getAttribute('data-withdraw')}/withdraw`, { method: 'POST' }),
          'Request withdrawn',
        );
      })());
    });
  },
};
// ═══════════════════════════════════════════════════════════════════════════════
// 28. RIDER — the open board
//
// The standalone "Open" screen was removed: the rider Dashboard (views['rider/home'])
// now carries the open board as its own section, so a separate tab showing the same
// cards only made riders hunt for work in two places. The route still resolves
// (deep links and older bookmarks don't 404 into a blank screen) by scrolling the
// dashboard's open section into view.
// ═══════════════════════════════════════════════════════════════════════════════
views['rider/open'] = {
  title: 'Open jobs',
  tab: 'home',
  async mount() { location.hash = '#/rider/home'; },
};

// ═══════════════════════════════════════════════════════════════════════════════
// 29. RIDER — job detail: 🗺️ NAVIGATE is the biggest thing on the screen (§10.6.7)
// ═══════════════════════════════════════════════════════════════════════════════
views['rider/jobs/:id'] = {
  title: (loc) => `Job #${loc.id}`,
  tab: 'home',
  async mount(el, loc) {
    const b = await api(`/api/rider/jobs/${loc.id}`);
    store.bkIndex[Number(b.id)] = b;
    const p = riderPrimary(b);

    el.innerHTML = `
      <div class="card">
        <div class="bk-top">
          <span class="bk-ref">${esc(b.ref)}</span>
          ${statusPill(b.status)}
        </div>
        <div class="bk-sub">${esc(b.customer_name || 'Customer')}</div>
        <div class="bk-meta">
          <span>${esc(dateTimeLabel(b.created_at))}</span>
          <span>Df ${peso(b.delivery_fee || 0)}</span>
          ${b.priority === 'HIGH' ? '<span>🔥 HIGH</span>' : ''}
        </div>
      </div>

      ${b.nav
        ? `<button class="nav-cta" id="nav-app">🗺️ NAVIGATE</button>
           <button class="btn maps" id="nav-maps">Open in Google Maps</button>`
        : `<div class="no-pin">📍 No drop-off pin — read the details below</div>`}

      ${p ? `<button class="btn ${p.cls} block" id="main-act" style="margin-bottom:9px">${p.label}</button>` : ''}
      ${(b.status === 'ASSIGNED') ? '<button class="btn danger block" id="decline">Decline this job</button>' : ''}

      <div class="section-title">My earnings on this job</div>
      <div class="card">
        <div class="kv"><span class="k">Customer paid</span><span class="v">${peso(b.total)}</span></div>
        <div class="kv"><span class="k">Delivery fee</span><span class="v">${peso(b.delivery_fee || 0)}</span></div>
        <div class="kv total"><span class="k">You earn</span><span class="v">${b.rider_payout != null ? peso(b.rider_payout) : '—'}</span></div>
        ${b.status === 'DELIVERED' ? '' : '<div style="font-size:12.5px;color:var(--text-3);margin-top:6px">Your payout is fixed the moment you mark it delivered.</div>'}
      </div>

      ${b.customer_phone ? `<a class="btn block" href="tel:${esc(b.customer_phone)}" style="margin-bottom:12px">📞 Call ${esc(b.customer_phone)}</a>` : ''}

      ${section('The order, exactly as pasted', `<div class="details-box">${esc(b.details_text || '(no details)')}</div>`)}

      ${section('Timeline', `<div class="card">${timelineHtml(b.events)}</div>`)}
    `;

    const on = (sel, fn) => { const n = $(sel, el); if (n) n.onclick = fn; };
    on('#nav-app', () => openNav(b.waze_app, b.waze_https));
    on('#nav-maps', () => openMaps(b.google_maps));
    if (p) {
      on('#main-act', () => {
        const label = p.act === 'accept' ? 'Job accepted' : (p.act === 'pickup' ? 'Picked up' : 'Delivered — commission accrued');
        fire(riderAction(b.id, p.act, label));
      });
    }
    on('#decline', () => fire(riderDecline(b.id, b.ref)));
  },
};
// ═══════════════════════════════════════════════════════════════════════════════
// 30. RIDER — own history + money (§6.10.5)
// ═══════════════════════════════════════════════════════════════════════════════
let riderHistoryAll = false;

function earningsKw(e) {
  return `
    <div class="kv"><span class="k">EARNED</span><span class="v money">${peso(e.earned)}</span></div>
    <div class="kv"><span class="k">PAID to you</span><span class="v money">${peso(e.paid)}</span></div>
    <div class="kv total"><span class="k">OWED to you</span><span class="v money">${peso(e.owed)}</span></div>
    <div class="kv"><span class="k">Delivered jobs</span><span class="v">${Number(e.delivered || 0)} · avg ${peso(e.avg_per_job)}</span></div>`;
}

function riderHistoryRows(bookings) {
  if (!bookings.length) return emptyBox('🧾', 'Nothing here yet');
  return bookings.map((b) => {
    const m = statusMeta(b.status);
    const reason = b.exclusion_reason || b.cancel_reason;
    const money = b.status === 'DELIVERED'
      ? `<div class="money" style="font-weight:800;color:var(--green)">+${peso(b.rider_payout)}</div>`
      : (b.status === 'CANCELLED' ? '<div class="money" style="color:var(--red)">cancelled</div>' : '');
    return `<div class="card tight" data-hj="${b.id}">
      <div style="display:flex;justify-content:space-between;gap:10px">
        <div style="min-width:0">
          <div style="font-weight:800">${esc(b.ref)} <span style="color:var(--text-3);font-weight:400;font-size:12.5px">· ${esc(b.day || dateLabel(b.created_at))}</span></div>
          <div style="font-size:12.5px;color:var(--text-3)">${esc(b.customer_name || 'Customer')} · ${esc(m.label)}</div>
          ${reason ? `<div style="font-size:12.5px;color:var(--amber);margin-top:3px">“${esc(reason)}”</div>` : ''}
        </div>
        <div style="text-align:right;white-space:nowrap">
          ${money}
          <div style="font-size:12.5px;color:var(--text-3)">total ${peso(b.total)}</div>
        </div>
      </div>
    </div>`;
  }).join('');
}

views['rider/history'] = {
  title: 'My history',
  tab: 'history',
  async mount(el) {
    const out = await api(`/api/rider/history${riderHistoryAll ? '?all_time=1' : ''}`);
    const e = out.earnings || {};

    el.innerHTML = `
      <div class="chip-row">
        <button class="chip${riderHistoryAll ? '' : ' active'}" data-ha="0">Today</button>
        <button class="chip${riderHistoryAll ? ' active' : ''}" data-ha="1">All time</button>
      </div>
      <div class="card">${earningsKw(e)}
        <button class="btn primary block small" id="req-payout" style="margin-top:10px">Request a payout</button>
      </div>
      <div class="section-title">
        <span>Jobs · ${(out.bookings || []).length}</span>
        <button class="btn small ghost" id="rh-csv">Export CSV</button>
      </div>
      ${riderHistoryRows(out.bookings || [])}
    `;

    $$('[data-ha]', el).forEach((b) => {
      b.onclick = () => {
        riderHistoryAll = b.getAttribute('data-ha') === '1';
        haptic(10);
        fire(refreshCurrent());
      };
    });
    $$('[data-hj]', el).forEach((c) => {
      c.onclick = () => { location.hash = `#/rider/jobs/${c.getAttribute('data-hj')}`; };
    });
    $('#req-payout', el).onclick = () => requestPayoutSheet(e.owed);
    $('#rh-csv', el).onclick = () => fire(downloadCsv('/api/rider/history.csv', 'my-history.csv'));
  },
};

function requestPayoutSheet(owed) {
  const sheet = openSheet(`
    <h3>Request a payout</h3>
    <div class="kv"><span class="k">Owed to you right now</span><span class="v money">${peso(owed)}</span></div>
    <p style="font-size:12.5px;color:var(--text-3);margin:8px 0 0">
      This sends the manager a request. It does not move money — the manager records the payout.
    </p>
    <div class="field" style="margin-top:12px"><span>Amount (₱)</span>
      <input id="rq-amt" type="text" inputmode="decimal" value="${Number(owed || 0)}"></div>
    <div class="field"><span>Note (optional)</span><input id="rq-note" type="text" placeholder="e.g. please settle today"></div>
    <div class="form-error hidden" data-err></div>
    <div class="sheet-actions">
      <button class="btn ghost" data-no>Cancel</button>
      <button class="btn primary" data-yes>Send request</button>
    </div>`);
  $('[data-no]', sheet).onclick = () => closeSheet();
  $('[data-yes]', sheet).onclick = () => {
    const amount = Math.round(Number(String($('#rq-amt', sheet).value).replace(/[^\d.-]/g, '')));
    if (!Number.isFinite(amount) || amount <= 0) {
      const e = $('[data-err]', sheet);
      e.textContent = 'Amount must be a positive number';
      e.classList.remove('hidden');
      return;
    }
    const note = $('#rq-note', sheet).value.trim();
    closeSheet();
    fire(run(
      () => api('/api/rider/payouts/request', { method: 'POST', body: { amount, note } }),
      'Payout requested',
    ));
  };
}
// ═══════════════════════════════════════════════════════════════════════════════
// 31. RIDER — own profile. No other rider's data, no manager commission column.
// ═══════════════════════════════════════════════════════════════════════════════
views['rider/profile'] = {
  title: 'My profile',
  tab: 'profile',
  async mount(el) {
    const [me, earnings, payouts] = await Promise.all([
      api('/api/me'),
      api('/api/rider/earnings'),
      api('/api/rider/payouts'),
    ]);
    store.profile = Object.assign({}, store.profile, me);
    store.save();
    const rider = me.rider || store.profile.rider || {};
    const showEarnings = store.config.show_rider_earnings !== false;

    el.innerHTML = `
      <div class="card">
        <div style="display:flex;gap:12px;align-items:center">
          <span class="avatar" style="width:52px;height:52px;font-size:18px">${esc(initials(me.full_name))}</span>
          <div>
            <div style="font-weight:800;font-size:18px">${esc(me.full_name)}</div>
            <div style="color:var(--text-3);font-size:13px">
              @${esc(me.username)}${rider.vehicle ? ` · ${esc(rider.vehicle)}` : ''}${rider.plate ? ` · ${esc(rider.plate)}` : ''}
            </div>
            ${rider.phone ? `<div style="color:var(--text-3);font-size:13px">${esc(rider.phone)}</div>` : ''}
          </div>
        </div>
      </div>

      ${showEarnings ? section('My money', `<div class="card">${earningsKw(earnings)}
        <button class="btn primary block small" id="req-payout" style="margin-top:10px">Request a payout</button>
      </div>`) : section('My money', '<div class="card" style="color:var(--text-3);font-size:13.5px">Earnings are hidden by the manager.</div>')}

      ${showEarnings ? section(`Payout history · ${(payouts || []).length}`, (payouts || []).length
        ? (payouts || []).map((p) => `
            <div class="card tight" style="display:flex;justify-content:space-between;gap:10px">
              <div>
                <div style="font-weight:800" class="money">${peso(p.amount)}${p.is_void ? ' <span style="color:var(--red);font-size:12px">VOID</span>' : ''}</div>
                <div style="font-size:12.5px;color:var(--text-3)">${esc(p.method || 'CASH')} · ${esc(dateLabel(p.created_at))}</div>
              </div>
              ${p.note ? `<div style="font-size:12.5px;color:var(--text-2);text-align:right">“${esc(p.note)}”</div>` : ''}
            </div>`).join('')
        : '<div class="empty">No payouts yet</div>') : ''}

      ${section('Settings', `<div class="card tight">
        <button class="btn block small" id="chg-pw" style="margin-bottom:10px">Change my password</button>
        <div class="kv"><span class="k">Notifications permission</span><span class="v">${('Notification' in window) ? Notification.permission : 'n/a'}</span></div>
        <div style="display:flex;gap:8px;margin-top:10px">
          <button class="btn primary small" id="push-on">Turn on</button>
          <button class="btn ghost small" id="push-off">Turn off</button>
        </div>
        <label class="kv" style="align-items:center;cursor:pointer;margin-top:10px">
          <span class="k">Sound alerts</span>
          <input type="checkbox" id="pf-sound" ${store.sound ? 'checked' : ''} style="width:22px;height:22px">
        </label>
        <div class="section-title" style="margin-top:14px">Appearance</div>
        <div class="theme-picker" role="group" aria-label="Colour theme">
          ${['dark', 'light', 'system'].map((t) => `
            <button class="chip${(store.theme || 'dark') === t ? ' active' : ''}" data-theme-set="${t}"
                    aria-pressed="${(store.theme || 'dark') === t}">${t[0].toUpperCase() + t.slice(1)}</button>`).join('')}
        </div>
      </div>`)}

      ${section('Alerts', alertPrefsHtml())}

      ${section('About', `<div class="card tight">
        <div class="kv"><span class="k">App version</span><span class="v">${esc(store.config.version || '—')}</span></div>
        <div class="kv"><span class="k">Store</span><span class="v">${esc(store.config.store_label || '—')}</span></div>
        <div class="kv"><span class="k">Max jobs at once</span><span class="v">${Number(store.config.max_concurrent || 1)}</span></div>
        <button class="btn ghost block small" id="check-update" style="margin-top:12px">Check for an update</button>
      </div>`)}

      <button class="btn ghost block" id="pf-logout" style="margin-top:6px">Sign out</button>
    `;

    const rp = $('#req-payout', el);
    if (rp) rp.onclick = () => requestPayoutSheet(earnings.owed);
    $('#chg-pw', el).onclick = () => fire(changePasswordSheet());
    $('#push-on', el).onclick = () => fire(enablePush());
    $('#push-off', el).onclick = () => fire(disablePush());
    $('#pf-sound', el).onchange = (e) => {
      store.sound = e.target.checked;
      localStorage.setItem('bk_sound', store.sound ? '1' : '0');
    };
    bindAlertPrefs(el);
    $('#check-update', el).onclick = () => fire(checkForUpdate(true));
    $$('[data-theme-set]', el).forEach((b) => {
      b.onclick = () => {
        haptic(10);
        setTheme(b.getAttribute('data-theme-set'));
        $$('[data-theme-set]', el).forEach((x) => {
          const on = x.getAttribute('data-theme-set') === store.theme;
          x.classList.toggle('active', on);
          x.setAttribute('aria-pressed', String(on));
        });
      };
    });
    $('#pf-logout', el).onclick = () => logout();
  },
};
// ═══════════════════════════════════════════════════════════════════════════════
// 32. boot — config, session screens, heartbeat, PWA
// ═══════════════════════════════════════════════════════════════════════════════
async function refreshConfig() {
  store.config = await api('/api/config');
  if (store.config.store_label) document.title = `${store.config.store_label} Booking`;
  // The store name belongs in the BRAND slot, not the title slot: #topbar-title
  // is overwritten by the router with the current view's name, so writing here
  // was a no-op (the old guard could never pass — textContent is never empty).
  const brand = $('#topbar-brand');
  if (brand && store.config.store_label) brand.textContent = store.config.store_label;
  return store.config;
}

async function checkForUpdate(manual) {
  try {
    const reg = await navigator.serviceWorker.getRegistration().catch(() => null);
    if (reg) await reg.update();
    const rel = await api('/api/release').catch(() => null);
    const label = rel && rel.build_no ? `build ${rel.build_no}` : `v${store.config.version || '?'}`;
    toast(manual ? `You are on ${label}` : `Update check — ${label}`, 'ok');
  } catch (err) {
    if (manual) toast(err.message || 'Could not check for an update', 'err');
  }
}

function showOnly(id) {
  ['#splash', '#login', '#pw-change', '#app'].forEach((sel) => $(sel).classList.toggle('hidden', sel !== id));
}

function showApp() { showOnly('#app'); }
function showLogin() {
  showOnly('#login');
  stopHeartbeat();
  disconnectSSE();
}
function showPasswordChange() { showOnly('#pw-change'); }

async function logout(silent) {
  if (!silent && store.refreshToken) {
    try {
      await api('/api/logout', { method: 'POST', body: { refresh: store.refreshToken } });
    } catch { /* logging out anyway */ }
  }
  if (store.isRider) fire(goOffline().catch(() => {}));
  store.clear();
  stopHeartbeat();
  disconnectSSE();
  setLoginRole('MANAGER');
  const err = $('#login-error');
  if (err) err.classList.add('hidden');
  showLogin();
  if (!silent) toast('Signed out', 'ok');
}

/** After any successful auth: config, screen, live channel, presence. */
async function afterAuth() {
  await refreshConfig().catch(() => {});
  if (store.profile && store.profile.must_change_password) { showPasswordChange(); return; }
  connectSSE();
  startHeartbeat();
  paintOffline();
  refreshPendingReqs();
  refreshChatUnread();     // badge the messages missed while this device was away
  if (store.isRider) flushOutbox();   // anything queued while offline goes out now
  const loc = parseHash();
  if (!loc || loc.role !== store.role) {
    location.hash = DEFAULT_ROUTE[store.role] || DEFAULT_ROUTE.MANAGER;
  }
  await router();
}

// ── presence heartbeat (riders only, §4.5) ────────────────────────────────────
let hbTimer = null;

function heartbeatOnce() {
  if (!store.token || !store.isRider || !navigator.onLine) return Promise.resolve();
  return api('/api/heartbeat', {
    method: 'POST',
    body: { instance_id: store.instanceId, platform: 'web', app_version: store.config.version },
  }).catch(() => {});
}

function goOffline() {
  if (!store.token || !store.isRider) return Promise.resolve();
  return api('/api/heartbeat/offline', {
    method: 'POST',
    body: { instance_id: store.instanceId },
  }).catch(() => {});
}

function startHeartbeat() {
  stopHeartbeat();
  if (!store.isRider) return;
  fire(heartbeatOnce());
  const ms = Math.max(Number(store.config.heartbeat_ms || 20000), 5000);
  hbTimer = setInterval(() => { fire(heartbeatOnce()); }, ms);
}

function stopHeartbeat() {
  if (hbTimer) clearInterval(hbTimer);
  hbTimer = null;
}

document.addEventListener('visibilitychange', () => {
  if (!store.isRider || !store.token) return;
  if (document.visibilityState === 'hidden') fire(goOffline());
  else { fire(heartbeatOnce()); connectSSE(); }
});

window.addEventListener('online', () => {
  toast('Back online', 'ok');
  if (store.token) { connectSSE(); fire(heartbeatOnce()); fire(refreshCurrent()); }
});
window.addEventListener('offline', () => { toast("You're offline — reads are cached", 'err'); setLive(false); });
// ═══════════════════════════════════════════════════════════════════════════════
// 33. login / password-change wiring (§7.2) — the two roles never share a screen
// ═══════════════════════════════════════════════════════════════════════════════
let loginRole = 'MANAGER';

function setLoginRole(role) {
  loginRole = role === 'RIDER' ? 'RIDER' : 'MANAGER';
  const m = $('#tab-manager');
  const r = $('#tab-rider');
  if (!m || !r) return;
  m.classList.toggle('active', loginRole === 'MANAGER');
  r.classList.toggle('active', loginRole === 'RIDER');
  m.setAttribute('aria-selected', String(loginRole === 'MANAGER'));
  r.setAttribute('aria-selected', String(loginRole === 'RIDER'));
  const btn = $('#login-btn');
  if (btn) btn.textContent = loginRole === 'MANAGER' ? 'Sign in as Manager' : 'Sign in as Rider';
  const u = $('#login-username');
  if (u) u.placeholder = loginRole === 'MANAGER' ? 'e.g. manager' : 'e.g. jose';
}

function loginError(msg) {
  const err = $('#login-error');
  if (!err) return;
  if (msg) { err.textContent = msg; err.classList.remove('hidden'); }
  else err.classList.add('hidden');
}

function wireLogin() {
  const m = $('#tab-manager');
  const r = $('#tab-rider');
  if (m) m.onclick = () => { haptic(10); setLoginRole('MANAGER'); loginError(''); };
  if (r) r.onclick = () => { haptic(10); setLoginRole('RIDER'); loginError(''); };

  const form = $('#login-form');
  if (form) {
    form.onsubmit = (e) => {
      e.preventDefault();
      fire((async () => {
        loginError('');
        const username = $('#login-username').value.trim();
        const password = $('#login-password').value;
        if (!username || !password) { loginError('Username and password are required'); return; }
        const btn = $('#login-btn');
        btn.disabled = true;
        try {
          const out = await api(`/api/login/${loginRole === 'MANAGER' ? 'manager' : 'rider'}`, {
            method: 'POST',
            body: { username, password },
          });
          store.token = out.token;
          store.refreshToken = out.refresh;
          store.profile = out.profile;
          store.save();
          $('#login-password').value = '';
          haptic(10);
          chime('ok');
          await afterAuth();
        } catch (err) {
          loginError(err.message || 'Sign in failed');
          haptic([400, 200, 400]);
        } finally {
          btn.disabled = false;
        }
      })());
    };
  }

  const pwForm = $('#pw-form');
  if (pwForm) {
    pwForm.onsubmit = (e) => {
      e.preventDefault();
      fire((async () => {
        const err = $('#pw-error');
        err.classList.add('hidden');
        const nw = $('#pw-new').value;
        const cf = $('#pw-confirm').value;
        if (nw.length < 8) { err.textContent = 'Password must be at least 8 characters'; err.classList.remove('hidden'); return; }
        if (nw !== cf) { err.textContent = 'The two passwords do not match'; err.classList.remove('hidden'); return; }
        try {
          await api('/api/change-password', { method: 'POST', body: { new_password: nw } });
          store.profile.must_change_password = false;
          store.save();
          toast('Password set', 'ok');
          $('#pw-new').value = '';
          $('#pw-confirm').value = '';
          await afterAuth();
        } catch (e2) {
          err.textContent = e2.message || 'Could not save the password';
          err.classList.remove('hidden');
        }
      })());
    };
  }

  const logoutBtn = $('#btn-logout');
  if (logoutBtn) logoutBtn.onclick = () => fire(logout());
}

// ── service worker: push + notification clicks (§8.2) ─────────────────────────
function wireServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => { /* offline shell is optional */ });
  });
  navigator.serviceWorker.addEventListener('message', (e) => {
    const d = e.data || {};
    if (d.type === 'navigate' && d.url) {
      const target = String(d.url).replace(/^#?\/?/, '');
      location.hash = `#/${target}`;
    }
    if (d.type === 'chat' || d.type === 'job') { chime('newjob'); haptic([200, 100, 200]); }
  });
}

/**
 * Offline is a first-class state, not just a refusal: a persistent banner says
 * what is happening and reconnecting drains the rider-action outbox (§10.5).
 */
function paintOffline() {
  const off = !navigator.onLine;
  const banner = $('#offline-banner');
  if (banner) {
    const pending = readOutbox().length;
    banner.textContent = off
      ? (pending
        ? `Offline — ${pending} update${pending === 1 ? '' : 's'} waiting to send`
        : 'Offline — you can still read; actions will send when you reconnect')
      : '';
    banner.classList.toggle('hidden', !off);
  }
  paintOutbox();
}

function wireOffline() {
  window.addEventListener('offline', () => { paintOffline(); toast('You are offline', 'err'); });
  window.addEventListener('online', () => {
    paintOffline();
    toast('Back online', 'ok');
    refreshPendingReqs();
    flushOutbox();
  });
  paintOffline();
}

// ═══════════════════════════════════════════════════════════════════════════════
// 34. init
// ═══════════════════════════════════════════════════════════════════════════════
async function init() {
  applyTheme();
  watchSystemTheme();
  setLoginRole('MANAGER');
  wireLogin();
  wireServiceWorker();
  wireOffline();

  // a tap anywhere unlocks WebAudio on mobile
  document.addEventListener('touchstart', unlockAudio, { once: true });
  document.addEventListener('click', unlockAudio, { once: true });

  if (store.token && store.profile) {
    try {
      const me = await api('/api/me');
      store.profile = Object.assign({}, store.profile, me);
      store.save();
      await afterAuth();
      return;
    } catch {
      store.clear();
    }
  }
  showLogin();
}

init().catch(() => {
  store.clear();
  showLogin();
});


































