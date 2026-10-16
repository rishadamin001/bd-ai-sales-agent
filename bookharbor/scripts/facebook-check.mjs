import {readFile} from 'node:fs/promises';
const base='https://bookharbor-mis465.bookharbor-mis465.workers.dev';
const {ADMIN_KEY}=JSON.parse(await readFile('work/demo-access.json','utf8'));
const login=await fetch(base+'/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:ADMIN_KEY})});
if(!login.ok) throw Error('Owner login failed: '+login.status);
const headers={Cookie:login.headers.get('set-cookie').split(';')[0],Origin:base};
const action=process.argv[2] || 'status';
const requests=action==='subscribe' ? [['/api/facebook/subscription','POST']] : action==='check' ? [['/api/facebook/webhook-check','POST'],['/api/facebook/subscription','GET']] : [['/api/health','GET'],['/api/status','GET'],['/api/dashboard','GET']];
for(const [path,method] of requests){
  const response=await fetch(base+path,{method,headers});
  const body=await response.json();
  console.log(JSON.stringify({path,status:response.status,result:path==='/api/dashboard' ? {facebookEvents:body.events?.filter(e=>e.id.startsWith('fb:')).map(({status,error,created,engine})=>({status,error,created,engine}))} : body}));
}
