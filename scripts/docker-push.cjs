/**
 * scripts/docker-push.cjs — build, tag and push the production image.
 *
 *   node scripts/docker-push.cjs            # tag by git SHA + latest
 *   DOCKER_REPO=me/other node scripts/docker-push.cjs
 *
 * Why SHA tags: Render caches public images, so re-using a mutable tag (or
 * over-writing an existing one) can hand you a stale build. A SHA tag is
 * immutable and self-documenting — the tag tells you exactly which commit is
 * running in production. `latest` is pushed too, purely as a convenience alias;
 * deploy the SHA tag on Render, never `latest`.
 */
const { execFileSync, execSync } = require('child_process');

const REPO = process.env.DOCKER_REPO || 'martincajurao/booking';

function run(cmd, args, opts = {}) {
  process.stdout.write(`\n> ${cmd} ${args.join(' ')}\n`);
  return execFileSync(cmd, args, { stdio: 'inherit', shell: process.platform === 'win32', ...opts });
}

const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();

// Refuse to ship something that isn't committed: the SHA tag must mean
// something, and an uncommitted change would be invisible in the registry.
const dirty = execSync('git status --porcelain', { encoding: 'utf8' }).trim();
if (dirty) {
  console.error('\n✗ Working tree is not clean — commit (or stash) first.');
  console.error('  A SHA tag must identify real, committed code.\n');
  process.exit(1);
}

const sha = git('rev-parse', '--short', 'HEAD');
const subject = git('log', '-1', '--pretty=%s');
const shaTag = `${REPO}:${sha}`;
const latestTag = `${REPO}:latest`;

console.log(`\nPostre Booking → ${REPO}`);
console.log(`  commit  ${sha}  ${subject}`);
console.log(`  tag     ${shaTag}`);

run('docker', ['build', '-t', shaTag, '-t', latestTag, '.']);

console.log('\n→ pushing');
run('docker', ['push', shaTag]);
run('docker', ['push', latestTag]);

const size = execFileSync('docker', ['image', 'inspect', shaTag, '--format', '{{.Size}}'], {
  encoding: 'utf8',
}).trim();
console.log(`\n✓ pushed ${shaTag}  (${(Number(size) / 1048576).toFixed(0)} MB)`);
console.log('\nNext: Render → your service → Settings → Deploy → Image, set:');
console.log(`  ${shaTag}`);
console.log('(not :latest — Render caches public images and may serve a stale one)');
console.log('then Manual Deploy.\n');