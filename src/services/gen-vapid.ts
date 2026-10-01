/**
 * src/services/gen-vapid.ts — generate OUR OWN VAPID key pair (§0.1, §15.1 step 3).
 *
 *   npm run gen:vapid          → print the keys
 *   npm run gen:vapid -- --write   → also write them into .env
 *
 * IMPORTANT (§0.1): do NOT reuse Messenger-bot's VAPID keys. A shared pair means
 * both apps' subscriptions are visible to each other's server, which is exactly
 * the cross-app leakage the whole boundary exists to prevent.
 *
 * Existing keys in .env are never overwritten unless --write is passed.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

function loadWebPush(): any {
  try { return require('web-push'); }
  catch {
    console.error('[gen:vapid] web-push is not installed. Run: npm install web-push');
    process.exit(1);
  }
}

function main() {
  const webPush = loadWebPush();
  const write = process.argv.includes('--write');
  const subject = process.env.BK_VAPID_SUBJECT || 'mailto:admin@example.com';

  const { publicKey, privateKey } = webPush.generateVAPIDKeys();

  console.log('');
  console.log('  VAPID keys generated for THIS app (never share with Messenger-bot)');
  console.log('  ────────────────────────────────────────────────────────────────');
  console.log(`  BK_VAPID_PUBLIC_KEY=${publicKey}`);
  console.log(`  BK_VAPID_PRIVATE_KEY=${privateKey}`);
  console.log(`  BK_VAPID_SUBJECT=${subject}`);
  console.log('');

  const envPath = resolve(process.cwd(), '.env');
  if (!write) {
    console.log('  Not written. Re-run with --write to save into .env:');
    console.log('    npm run gen:vapid -- --write');
    console.log('');
    return;
  }
  if (!existsSync(envPath)) {
    console.error(`  [gen:vapid] ${envPath} not found — copy .env.example to .env first.`);
    process.exit(1);
  }

  let text = readFileSync(envPath, 'utf8');
  const set = (key: string, value: string) => {
    const line = `${key}=${value}`;
    const re = new RegExp(`^${key}=.*$`, 'm');
    text = re.test(text) ? text.replace(re, line) : `${text.replace(/\s*$/, '')}\n${line}\n`;
  };

  // PUBLIC_KEY is safe to replace freely; ask before clobbering a private key,
  // because changing it invalidates every existing push subscription.
  const hadPrivate = /^BK_VAPID_PRIVATE_KEY=\s*\S+/m.test(text);
  if (hadPrivate && !process.argv.includes('--force')) {
    console.error('  [gen:vapid] BK_VAPID_PRIVATE_KEY is already set.');
    console.error('  Replacing it invalidates every device subscription.');
    console.error('  Re-run with --force if that is what you want.');
    process.exit(1);
  }

  set('BK_VAPID_PUBLIC_KEY', publicKey);
  set('BK_VAPID_PRIVATE_KEY', privateKey);
  set('BK_VAPID_SUBJECT', subject);
  writeFileSync(envPath, text, 'utf8');

  console.log(`  Wrote the three BK_VAPID_* keys into ${envPath}`);
  console.log('  Restart the dev server for push to switch on.');
  console.log('');
}

main();
