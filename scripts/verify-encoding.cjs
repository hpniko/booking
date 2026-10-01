/**
 * scripts/verify-encoding.cjs — fail if a source file contains mojibake.
 *
 * How it happened: a bulk edit read public/app.js with PowerShell's
 * `Get-Content -Raw`, which decodes as CP1252 rather than UTF-8, then wrote the
 * result back as UTF-8. Every emoji became two-to-four Latin-1 characters and
 * the icons rendered as unreadable symbols. The file remained valid UTF-8 the
 * whole time, so `node --check` passed and nothing else complained — it was
 * only visible on a screen.
 *
 * This is that missing check. A double-encoded sequence always begins with a
 * Latin-1 lead byte in U+00C2..U+00F4 followed by that byte's continuation
 * bytes, which decodes back to a real character. Genuine prose does not.
 *
 * Run: node scripts/verify-encoding.cjs   (no dependencies, no DB)
 */
const fs = require('node:fs');
const path = require('node:path');

const FILES = [
  'public/app.js',
  'public/index.html',
  'public/style.css',
  'public/sw.js',
  'src/server.ts',
];

const CP1252_HIGH = {
  0x20AC: 0x80, 0x0081: 0x81, 0x201A: 0x82, 0x0192: 0x83, 0x201E: 0x84,
  0x2026: 0x85, 0x2020: 0x86, 0x2021: 0x87, 0x02C6: 0x88, 0x2030: 0x89,
  0x0160: 0x8A, 0x2039: 0x8B, 0x0152: 0x8C, 0x008D: 0x8D, 0x017D: 0x8E,
  0x008F: 0x8F, 0x0090: 0x90, 0x2018: 0x91, 0x2019: 0x92, 0x201C: 0x93,
  0x201D: 0x94, 0x2022: 0x95, 0x2013: 0x96, 0x2014: 0x97, 0x02DC: 0x98,
  0x2122: 0x99, 0x0161: 0x9A, 0x203A: 0x9B, 0x0153: 0x9C, 0x009D: 0x9D,
  0x017E: 0x9E, 0x0178: 0x9F,
};
const toByte = (cp) => (cp <= 0xFF ? cp : (CP1252_HIGH[cp] !== undefined ? CP1252_HIGH[cp] : -1));

/** Count mojibake sequences the same way repair-encoding.cjs detects them. */
function countMojibake(text) {
  const chars = [...text];
  let hits = 0;
  for (let i = 0; i < chars.length; i += 1) {
    const lead = toByte(chars[i].codePointAt(0));
    const len = (lead >= 0xC2 && lead <= 0xDF) ? 2
              : (lead >= 0xE0 && lead <= 0xEF) ? 3
              : (lead >= 0xF0 && lead <= 0xF4) ? 4
              : 0;
    if (!len || i + len > chars.length) continue;
    const bytes = [];
    let ok = true;
    for (let k = 0; k < len; k += 1) {
      const b = toByte(chars[i + k].codePointAt(0));
      if (b < 0) { ok = false; break; }
      bytes.push(b);
    }
    if (!ok) continue;
    const decoded = Buffer.from(bytes).toString('utf8');
    if ([...decoded].length === 1 && decoded !== '\uFFFD') { hits += 1; i += len - 1; }
  }
  return hits;
}

let failed = 0;
for (const rel of FILES) {
  const file = path.join(__dirname, '..', rel);
  if (!fs.existsSync(file)) continue;
  const text = fs.readFileSync(file, 'utf8');
  const bad = countMojibake(text);
  const fffd = (text.match(/\uFFFD/g) || []).length;
  const emoji = [...text].filter((c) => c.codePointAt(0) > 0x1F000).length;
  if (bad || fffd) {
    failed += 1;
    console.log(`  FAIL ${rel} — ${bad} mojibake sequence(s)${fffd ? `, ${fffd} replacement char(s)` : ''}`);
    console.log('       Icons will render as garbage. Repair with:');
    console.log(`         node scripts/repair-encoding.cjs ${rel}`);
  } else {
    console.log(`  ok   ${rel} — clean UTF-8 (${emoji} emoji)`);
  }
}

console.log(failed
  ? `\n${failed} file(s) have encoding damage.\n`
  : '\nencoding intact — no mojibake in any served file.\n');
process.exit(failed ? 1 : 0);