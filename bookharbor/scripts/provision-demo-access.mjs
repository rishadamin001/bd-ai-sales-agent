import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';

// Secrets stay in ignored local work/ and go to Wrangler over stdin, never argv.
await mkdir('work', { recursive: true });
let secrets;
try { secrets = JSON.parse(await readFile('work/demo-access.json', 'utf8')); }
catch (e) {
  if (e.code !== 'ENOENT') throw e;
  secrets = { ADMIN_KEY: randomBytes(24).toString('base64url'), FB_VERIFY_TOKEN: randomBytes(24).toString('base64url') };
  await writeFile('work/demo-access.json', JSON.stringify(secrets), { mode: 0o600 });
}
const result = spawnSync(process.execPath, ['node_modules/wrangler/bin/wrangler.js', 'secret', 'bulk'], { input: JSON.stringify(secrets), encoding: 'utf8', windowsHide: true });
if (result.status !== 0) { console.error('Secret upload failed. Retry after checking Cloudflare authorization.'); process.exit(1); }
await writeFile('work/OWNER-ACCESS.txt', `PRIVATE — do not upload or share this file.\n\nWebsite dashboard password:\n${secrets.ADMIN_KEY}\n\nMeta webhook verify token:\n${secrets.FB_VERIFY_TOKEN}\n\nThese are project-only credentials, not your Cloudflare or Facebook password.\n`, { mode: 0o600 });
console.log('Dashboard password and webhook verify token stored in Cloudflare. Your private copy is work/OWNER-ACCESS.txt (excluded from Git).');
