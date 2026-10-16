import { readFile } from 'node:fs/promises';
const base = process.argv[2];
if (!base || new URL(base).hostname !== 'bookharbor-mis465.bookharbor-mis465.workers.dev') throw Error('Expected assignment hostname');
const { ADMIN_KEY, FB_VERIFY_TOKEN } = JSON.parse(await readFile('work/demo-access.json','utf8'));
const login = await fetch(base+'/api/login',{method:'POST',headers:{'Content-Type':'application/json',Origin:base},body:JSON.stringify({password:ADMIN_KEY})});
if(!login.ok)throw Error('Login failed: '+login.status);
const cookie=login.headers.get('set-cookie').split(';')[0];
async function api(path,body){const r=await fetch(base+'/api/'+path,{method:body?'POST':'GET',headers:{Cookie:cookie,Origin:base,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});const b=await r.json();if(!r.ok)throw Error(path+': '+r.status);return b;}
console.log('Live status:',JSON.stringify(await api('status')));
const conversation_id='demo:'+crypto.randomUUID();
for(const text of ['Do you have the adventure about Bilbo?','order Hobbit','2','blue','Demo Reader','01700000000','House 1, Road 2, Mirpur, Dhaka','CONFIRM']){
 const r=await api('chat',{id:'web:'+crypto.randomUUID(),conversation_id,text});
 console.log(JSON.stringify({input:text,reply:r.reply,engine:r.engine,orderId:r.orderId}));
 if(text==='CONFIRM'&&!r.orderId)throw Error('Order was not saved');
}
const verification=await fetch(base+'/webhook?'+new URLSearchParams({'hub.mode':'subscribe','hub.verify_token':FB_VERIFY_TOKEN,'hub.challenge':'test-challenge'}));
if(await verification.text()!=='test-challenge')throw Error('Webhook verification failed');
console.log('Webhook challenge passed. Actual Meta send/receive still requires Page secrets and subscription.');
