import { readFile } from 'node:fs/promises';
const base='https://bookharbor-mis465.bookharbor-mis465.workers.dev';
const {ADMIN_KEY}=JSON.parse(await readFile('work/demo-access.json','utf8'));
const login=await fetch(base+'/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:ADMIN_KEY})});
if(!login.ok)throw Error('Login failed');
const r=await fetch(base+'/api/ai-check',{method:'POST',headers:{Cookie:login.headers.get('set-cookie').split(';')[0],Origin:base,'Content-Type':'application/json'},body:'{}'});
console.log(await r.text());
