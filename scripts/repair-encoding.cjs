/**
 * scripts/repair-encoding.cjs — undo UTF-8 double-encoding, selectively.
 *
 * What happened: a bulk edit read public/app.js with PowerShell's
 * `Get-Content -Raw` (which decodes as CP1252, not UTF-8) and wrote it back as
 * UTF-8. Every multi-byte character became two-to-four Latin-1 characters —
 * "🍰" turned into "ð©”" and the icons rendered as unreadable symbols. The file
 * stayed valid UTF-8 throughout, so nothing complained and `node --check` passed.
 *
 * The file is now a MIX: characters written before that edit are mojibake,
 * characters written after it (via a UTF-8-safe tool) are fine. So a blanket
 * decode would corrupt the good half. This repairs only the sequences that are
 * actually broken, identified structurally:
 *
 *   A double-encoded sequence always STARTS with a Latin-1 lead byte in
 *   U+00C2..U+00F4, and its length follows from that byte (2, 3 or 4 chars).
 *   Real prose never has "â", "Ã" or "ð" followed by that exact tail. Each
 *   candidate run is decoded and only accepted if it yields a valid, non-U+FFFD
 *   character — otherwise it is left untouched.
 *
 * Writes <file>.repaired and never overwrites the original.
 * Usage: node scripts/repair-encoding.cjs public/app.js
 */
const fs = require('node:fs');

const target = process.argv[2];
if (!target) {
  console.error('usage: node scripts/repair-encoding.cjs <file>');
  process.exit(1);
}

// Bytes 0x80-0x9F decoded as CP1252 become these, not the C1 controls.
const CP1252_HIGH = {
  0x20AC: 0x80, 0x0081: 0x81, 0x201A: 0x82, 0x0192: 0x83, 0x201E: 0x84,
  0x2026: 0x85, 0x2020: 0x86, 0x2021: 0x87, 0x02C6: 0x88, 0x2030: 0x89,
  0x0160: 0x8A, 0x2039: 0x8B, 0x0152: 0x8C, 0x008D: 0x8D, 0x017D: 0x8E,
  0x008F: 0x8F, 0x0090: 0x90, 0x2018: 0x91, 0x2019: 0x92, 0x201C: 0x93,
  0x201D: 0x94, 0x2022: 0x95, 0x2013: 0x96, 0x2014: 0x97, 0x02DC: 0x98,
  0x2122: 0x99, 0x0161: 0x9A, 0x203A: 0x9B, 0x0153: 0x9C, 0x009D: 0x9D,
  0x017E: 0x9E, 0x0178: 0x9F,
};

function toByte(cp) {
  if (cp <= 0xFF) return cp;
  return CP1252_HIGH[cp] !== undefined ? CP1252_HIGH[cp] : -1;
}

const text = fs.readFileSync(target, 'utf8');
const chars = [...text];
const out = [];
let repaired = 0;
let i = 0;

while (i < chars.length) {
  const lead = chars[i].codePointAt(0);
  const leadByte = toByte(lead);
  const len = (leadByte >= 0xC2 && leadByte <= 0xDF) ? 2
            : (leadByte >= 0xE0 && leadByte <= 0xEF) ? 3
            : (leadByte >= 0xF0 && leadByte <= 0xF4) ? 4
            : 0;

  if (!len || i + len > chars.length) { out.push(chars[i]); i += 1; continue; }

  const bytes = [];
  let ok = true;
  for (let k = 0; k < len; k += 1) {
    const b = toByte(chars[i + k].codePointAt(0));
    if (b < 0) { ok = false; break; }
    bytes.push(b);
  }
  if (!ok) { out.push(chars[i]); i += 1; continue; }

  const decoded = Buffer.from(bytes).toString('utf8');
  // Accept only if it round-trips to a single real character (no U+FFFD).
  if ([...decoded].length === 1 && decoded !== '\uFFFD') {
    out.push(decoded);
    repaired += 1;
    i += len;
  } else {
    out.push(chars[i]);
    i += 1;
  }
}

const result = out.join('');
const outPath = `${target}.repaired`;
fs.writeFileSync(outPath, result, 'utf8');

const countEmoji = (s) => [...s].filter((c) => c.codePointAt(0) > 0x1F000).length;
console.log(`wrote ${outPath}`);
console.log(`  sequences repaired : ${repaired}`);
console.log(`  emoji codepoints   : ${countEmoji(text)} -> ${countEmoji(result)}`);
console.log(`  U+FFFD in result   : ${(result.match(/\uFFFD/g) || []).length} (must be 0)`);