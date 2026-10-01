/**
 * scripts/verify-frontend.cjs — prove public/app.js actually EVALUATES.
 *
 * `node --check` only parses; it cannot see that the file throws the moment it
 * runs. That distinction cost us a release: `store` called loadNotifyPrefs()
 * at module scope while `const NOTIFY_KEY` was declared thousands of
 * characters further down, so the const was still in its temporal dead zone and
 * app.js died before init() ran. Every device that fetched a fresh copy showed
 * an endless splash; `node --check` passed the whole time.
 *
 * This stubs just enough DOM to evaluate the file, and runs it in TWO hostile
 * environments a real rider will hit:
 *   1. a normal browser
 *   2. localStorage throwing, as Android Chrome does when site data is blocked
 *
 * Run: node scripts/verify-frontend.cjs   (no dependencies, no DB)
 */
const path = require('node:path');
const vm = require('node:vm');

/** Defaults to public/app.js; pass a path to check another copy (e.g. one
 *  extracted from a published image) against the same boot conditions. */
const FILE = path.resolve(process.argv[2] || path.join(__dirname, '..', 'public', 'app.js'));

function stubDom() {
  const el = () => ({
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    style: {}, dataset: {},
    setAttribute() {}, getAttribute() { return null; }, removeAttribute() {},
    addEventListener() {}, appendChild() {}, remove() {}, focus() {}, click() {},
    textContent: '', innerHTML: '', value: '', checked: false,
    querySelector() { return null; }, querySelectorAll() { return []; },
    scrollIntoView() {}, insertAdjacentHTML() {}, cloneNode() { return el(); },
  });
  const document = {
    getElementById: () => el(), querySelector: () => el(), querySelectorAll: () => [],
    createElement: () => el(), addEventListener() {}, body: el(),
    documentElement: el(), title: '',
  };
  const window = {
    matchMedia: () => ({ matches: false, addEventListener() {}, addListener() {} }),
    addEventListener() {}, removeEventListener() {},
    location: { hash: '', reload() {} },
    matchMedia: () => ({ matches: false, addEventListener() {}, addListener() {} }),
  };
  return {
    document,
    window,
    navigator: { onLine: true, vibrate() {}, serviceWorker: undefined },
    location: { hash: '', reload() {} },
    console,
    setTimeout: () => 0, clearTimeout: () => {}, setInterval: () => 0, clearInterval: () => {},
    fetch: () => new Promise(() => {}),           // never resolves; we never get there
    localStorage: undefined,
    AudioContext: undefined, EventSource: undefined, Notification: undefined,
    Intl, JSON, Math, Date, Object, Array, String, Number, Boolean, Set, Map,
    Promise, Error, isNaN, parseInt, parseFloat, encodeURIComponent, decodeURIComponent,
  };
}

/** Evaluate app.js under `mutate(sandbox)` and report what happened. */
function runCase(name, mutate) {
  const sandbox = stubDom();
  mutate(sandbox);
  const ctx = vm.createContext(sandbox);
  try {
    new vm.Script(`
      (function(globalThis){ ${''}
      var __window = globalThis;
      ${require('node:fs').readFileSync(FILE, 'utf8')}
      })(globalThis);
    `, { filename: FILE }).runInContext(ctx);
    console.log(`  ok   ${name}`);
    return true;
  } catch (err) {
    console.log(`  FAIL ${name}`);
    console.log(`       ${err.name}: ${err.message}`);
    return false;
  }
}

// A plain Map-backed storage, like a browser with cookies allowed.
function normalStorage(store) {
  store.set = new Map();
  return {
    getItem: (k) => (store.set.has(k) ? store.set.get(k) : null),
    setItem: (k, v) => store.set.set(k, String(v)),
    removeItem: (k) => store.set.delete(k),
    clear: () => store.set.clear(),
  };
}

// Android Chrome with "Block cookies and site data" on: accessing the property
// itself throws a SecurityError. That is the behaviour reproduced here.
function hostileStorage() {
  return new Proxy({}, {
    get() { throw new Error("SecurityError: Failed to read the 'localStorage' property from 'Window': Access is denied for this document."); },
  });
}

let failed = 0;
console.log('\npublic/app.js — module evaluation');

if (!runCase('evaluates in a normal browser', (s) => { s.localStorage = normalStorage(s.store = {}); })) failed++;
if (!runCase('evaluates when localStorage throws (Android Chrome, site data blocked)', (s) => { s.localStorage = hostileStorage(); })) failed++;

console.log(failed
  ? `\n${failed} case(s) failed — the app would crash on load.\n`
  : '\nfrontend boot OK — app.js evaluates, including with storage blocked.\n');
process.exit(failed ? 1 : 0);