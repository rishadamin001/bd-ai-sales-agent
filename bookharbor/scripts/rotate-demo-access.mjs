import {randomBytes} from 'node:crypto';
import {readFile,writeFile} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
const key=process.argv[2];
if(!['ADMIN_KEY','FB_VERIFY_TOKEN'].includes(key)) throw Error('Choose ADMIN_KEY or FB_VERIFY_TOKEN');
const saved=JSON.parse(await readFile('work/demo-access.json','utf8'));
const value=randomBytes(32).toString('base64url');
// Keep a recovery copy before upload; neither file is tracked by Git.
await writeFile('work/pending-rotation.json',JSON.stringify({[key]:value}),{mode:0o600});
const result=spawnSync(process.execPath,['node_modules/wrangler/bin/wrangler.js','secret','bulk'],{input:JSON.stringify({[key]:value}),encoding:'utf8',windowsHide:true,env:{...process.env,CLOUDFLARE_ACCOUNT_ID:'bfd0afa1d5021b7538f589b10180d31a'}});
if(result.status!==0) throw Error('Upload failed; private recovery file retained. Check Cloudflare login.');
saved[key]=value;
await writeFile('work/demo-access.json',JSON.stringify(saved),{mode:0o600});
await writeFile('work/OWNER-ACCESS.txt',`PRIVATE — do not share or upload.\n\nWebsite dashboard password:\n${saved.ADMIN_KEY}\n\nMeta webhook verify token:\n${saved.FB_VERIFY_TOKEN}\n`,{mode:0o600});
console.log(key+' rotated in Cloudflare and private OWNER-ACCESS.txt updated. Values are not printed.');
