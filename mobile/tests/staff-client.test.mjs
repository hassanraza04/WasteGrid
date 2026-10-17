import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deferred, load } from './helpers/render.mjs';
const { StaffClient, StaffApiError } = load('services/staff-client.ts');
const { recoverOrSend } = load('services/staff-commands.ts');
function setup(respond) {
 const calls = []; let current = true;
 const api = new StaffClient(() => 'https://api.example', async () => ({token:'jwt', identity:{userId:'owner',role:'crew',crewId:'crew'}, isCurrent:() => current}), async (...args) => {calls.push(args); return respond(...args);});
 return {api,calls,logout:() => {current=false;}};
}
test('staff reads paginate active jobs and use staff auth rather than resident credentials', async () => {
 const {api,calls} = setup(url => Response.json(url.endsWith('offset=0') ? Array.from({length:100},(_,i)=>({id:String(i)})) : [{id:'last'}]));
 assert.equal((await api.jobs()).length,101);
 assert.equal(calls.length,2);
 assert.match(calls[0][0],/active_only=true&limit=100&offset=0/);
 assert.equal(calls[1][1].headers.Authorization,'Bearer jwt');
 assert.equal(calls[0][1].redirect,'error'); assert.ok(calls[0][1].signal);
});
test('logout while a response is decoded prevents private data being returned', async () => {
 const body=deferred(), started=deferred();
 const {api,logout} = setup(() => ({ok:true,json:() => {started.resolve();return body.promise;}}));
 const pending=api.crews();await started.promise;logout();body.resolve([{id:'private'}]);
 await assert.rejects(pending,/account changed/);
});
test('compute accepts only crew IDs; denied, stale and disabled responses are controlled', async () => {
 const {api,calls} = setup(() => Response.json({id:'preview'}));
 await api.compute(['a','b']);assert.deepEqual(JSON.parse(calls[0][1].body),{crew_ids:['a','b']});
 for(const status of [401,403,409,413,415,422,503]) {
  const {api} = setup(() => new Response('private server details',{status}));
  await assert.rejects(api.crews(),error => error instanceof StaffApiError && error.status===status && !error.message.includes('private server'));
 }
});
const command={kind:'completion',resource_id:'job',command_id:'stable',expected_version:7,crewId:'crew',ownerId:'owner',apiUrl:'https://api.example',photoUri:'file:///saved/cleanup.jpg'};
test('a lost completion response recovers the same audit command without another upload', async () => {
 let accepted=false,posts=0;
 const {api}=setup((url,init) => {
  if(init.method==='POST'){posts++;accepted=true;throw Error('response lost');}
  return Response.json({job:{id:'job',assigned_crew_id:'crew',status:accepted?'completed':'in_progress'},events:accepted?[{command_id:'stable',kind:'job.completed'}]:[]});
 });
 const photo=new Blob(['immutable bytes'],{type:'image/jpeg'});
 await assert.rejects(recoverOrSend(command,api,photo),/response lost/);
 assert.equal((await recoverOrSend(command,api,photo)).status,'completed');assert.equal(posts,1);
});
test('completion submits immutable identity/version/bytes and does not mistake another completion for its own', async () => {
 const {api,calls}=setup((url,init) => init.method==='POST'?Response.json({id:'job'}):Response.json({job:{id:'job',assigned_crew_id:'crew'},events:[{command_id:'someone-else',kind:'job.completed'}]}));
 await recoverOrSend(command,api,new Blob(['cleanup'],{type:'image/jpeg'}));
 const body=calls[1][1].body;
 assert.equal(body.get('command_id'),'stable');assert.equal(body.get('expected_version'),'7');assert.equal(await body.get('photo').text(),'cleanup');
 assert.equal(body.get('photo').type,'image/jpeg');
});
test('start/recheck release recover by audit ID; crew ownership changes prevent uploads', async () => {
 const {api,calls}=setup(() => Response.json({job:{id:'job',status:'unassigned'},events:[{command_id:'stable',kind:'job.changed'}]}));
 await recoverOrSend({...command,kind:'release',reason:'Reviewed'},api);assert.equal(calls.length,1);
 const other=setup(() => Response.json({job:{id:'job',assigned_crew_id:'other'},events:[]}));
 await assert.rejects(recoverOrSend(command,other.api,new Blob()),/no longer assigned/);assert.equal(other.calls.length,1);
});
test('dispatch retries use one command and recover an applied preview without redispatch', async () => {
 let plan=null, posts=0;
 const {api,calls}=setup((url,init)=>{
  if(init.method==='POST'){posts++;assert.deepEqual(JSON.parse(init.body),{command_id:'stable'});plan='plan';throw Error('lost');}
  return Response.json({id:'preview',plan_id:plan});
 });
 const dispatch={...command,kind:'dispatch',resource_id:'preview'};
 await assert.rejects(recoverOrSend(dispatch,api),/lost/);
 assert.deepEqual(await recoverOrSend(dispatch,api),{plan_id:'plan'});assert.equal(posts,1);assert.equal(calls.length,3);
});
