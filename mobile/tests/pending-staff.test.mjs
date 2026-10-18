import { test } from 'node:test';
import assert from 'node:assert/strict';
import { load, deferred } from './helpers/render.mjs';
const transport = load('services/staff-client.ts');
const commands = load('services/staff-commands.ts');
function setup() {
 const files = new Map([['file:///camera/cleanup.jpg','original bytes']]);
 let owner={userId:'owner',role:'crew',crewId:'crew'}, next=0, respond=() => Response.json({job:{id:'job',assigned_crew_id:'crew',status:'in_progress'},events:[]});
 const faults={};
 const uri=parts => parts.map(part=>typeof part==='string'?part:part.uri).join('/');
 class File extends Blob {
  constructor(...parts){const path=uri(parts);super([files.get(path)??''],{type:path.endsWith('.jpg')?'image/jpeg':''});this.uri=path;}
  get exists(){return files.has(this.uri);} get extension(){return '.'+this.uri.split('.').at(-1);}
  copy(destination){files.set(destination.uri,files.get(this.uri));}
  async write(value){if(faults.write)return faults.write(this,value);files.set(this.uri,value);}
  async move(destination){if(faults.move)throw Error('move interrupted');assert.equal(files.has(destination.uri),false);files.set(destination.uri,files.get(this.uri));files.delete(this.uri);this.uri=destination.uri;}
  async text(){return files.get(this.uri);}
  delete(){files.delete(this.uri);}
 }
 class Directory {constructor(...parts){this.uri=uri(parts);}create(){}list(){return [...files.keys()].filter(key=>key.startsWith(this.uri+'/')).map(key=>new File(key));}}
 process.env.EXPO_PUBLIC_API_BASE_URL='https://api.example';
 const api=new transport.StaffClient(()=>process.env.EXPO_PUBLIC_API_BASE_URL,async()=>{const identity=owner;return{token:'jwt',identity,isCurrent:()=>identity===owner}},(...args)=>respond(...args));
 const reload=()=>load('services/pending-staff.ts',{
  '@/utils/secure-random':{randomUUID:()=>`command-${++next}`},'expo-file-system':{Directory,File,Paths:{document:'file:///documents'}},
  'react-native':{Platform:{OS:'android'}},'@/auth/session':{getSession:()=>owner},'./staff':{staffApi:api},'./staff-client':transport,'./staff-commands':commands,
 });
 return{service:reload(),reload,files,faults,api,respond:value=>{respond=value},session:value=>{owner=value}};
}
const job={id:'job',version:7,status:'in_progress',assigned_crew_id:'crew'};
test('completion bytes and identity survive restart and retries; duplicate prepares share a command',async()=>{
 const app=setup();let posts=0,accepted=false;
 const [a,b]=await Promise.all([app.service.prepareStaff('completion',job,'file:///camera/cleanup.jpg'),app.service.prepareStaff('completion',job,'file:///camera/cleanup.jpg')]);
 assert.equal(a.command_id,b.command_id);assert.notEqual(a.photoUri,'file:///camera/cleanup.jpg');
 app.files.set('file:///camera/cleanup.jpg','changed camera cache');
 app.respond(async(_url,init)=>{
  if(init.method==='POST'){posts++;assert.equal(await init.body.get('photo').text(),'original bytes');accepted=true;throw Error('lost response');}
  return Response.json({job:{...job,status:accepted?'completed':'in_progress'},events:accepted?[{kind:'job.completed',command_id:a.command_id}]:[]});
 });
 await assert.rejects(app.service.submitStaff(a),/lost response/);
 const restarted=app.reload(),[saved]=await restarted.pendingStaff();assert.equal(saved.command_id,a.command_id);assert.equal(saved.expected_version,7);
 await restarted.submitStaff(saved);assert.equal(posts,1);assert.deepEqual(await restarted.pendingStaff(),[]);assert.equal(app.files.has(a.photoUri),false);
});
test('account isolation applies to listing, retries and discard',async()=>{
 const app=setup();const command=await app.service.prepareStaff('completion',job,'file:///camera/cleanup.jpg');
 app.session({userId:'someone-else',role:'crew',crewId:'crew'});
 assert.deepEqual(await app.service.pendingStaff(),[]);
 await assert.rejects(app.service.submitStaff(command),/account that saved/);
 await assert.rejects(app.service.discardRejectedStaff({...command,rejected:true}),/account that saved/);
 assert.equal(app.files.has(command.photoUri),true);
});
test('definitive rejection is durable and discard verifies the audit record before removing evidence',async()=>{
 const app=setup();const command=await app.service.prepareStaff('completion',job,'file:///camera/cleanup.jpg');
 app.respond((_url,init)=>init.method==='POST'?new Response(null,{status:413}):Response.json({job,events:[]}));
 await assert.rejects(app.service.submitStaff(command),transport.StaffApiError);
 const restarted=app.reload(),[saved]=await restarted.pendingStaff();assert.equal(saved.rejected,true);
 app.respond(()=>Response.json({job,events:[{command_id:command.command_id,kind:'job.completed'}]}));
 await assert.rejects(restarted.discardRejectedStaff(saved),/server accepted/);assert.equal(app.files.has(saved.photoUri),true);
 app.respond(()=>Response.json({job,events:[]}));await restarted.discardRejectedStaff(saved);assert.deepEqual(await restarted.pendingStaff(),[]);
});
test('interrupted publication preserves committed metadata and other corrupt files do not hide it',async()=>{
 const app=setup();const command=await app.service.prepareStaff('completion',job,'file:///camera/cleanup.jpg');
 app.respond((_url,init)=>init.method==='POST'?new Response(null,{status:422}):Response.json({job,events:[]}));
 app.faults.move=true;await assert.rejects(app.service.submitStaff(command),/move interrupted/);
 app.files.set('file:///documents/wastegrid-staff/broken.9.json','{');
 assert.deepEqual(await app.reload().pendingStaff(),[command]);assert.equal(app.files.has(command.photoUri),true);
});
test('anonymous/different-environment records cannot be reused and uncertain actions cannot be discarded',async()=>{
 const app=setup();const command=await app.service.prepareStaff('start',job);
 await assert.rejects(app.service.discardRejectedStaff(command),/Only a rejected/);
 process.env.EXPO_PUBLIC_API_BASE_URL='https://different.example';assert.deepEqual(await app.service.pendingStaff(),[]);
 await assert.rejects(app.service.submitStaff(command),/account that saved/);
});
test('two concurrent retries share one upload',async()=>{
 const app=setup();const command=await app.service.prepareStaff('completion',job,'file:///camera/cleanup.jpg');
 const gate=deferred();let posts=0;
 app.respond((_url,init)=>{if(init.method==='POST'){posts++;return gate.promise;}return Response.json({job,events:[]});});
 const first=app.service.submitStaff(command),second=app.service.submitStaff(command);assert.equal(first,second);
 gate.resolve(Response.json({...job,status:'completed'}));await first;assert.equal(posts,1);
});
test('a replacement account cannot borrow an in-flight action promise',async()=>{
 const app=setup();const command=await app.service.prepareStaff('completion',job,'file:///camera/cleanup.jpg');
 const started=deferred(),reply=deferred();
 app.respond((_url,init)=>{if(init.method==='POST'){started.resolve();return reply.promise;}return Response.json({job,events:[]});});
 const first=app.service.submitStaff(command);const settled=first.catch(()=>{});
 try{
  await started.promise;app.session({userId:'B',role:'crew',crewId:'crew'});
  await assert.rejects(app.service.submitStaff(command),/account that saved/);
 }finally{reply.resolve(Response.json({...job,status:'completed'}));await settled;}
 assert.equal(app.files.has(command.photoUri),true);assert.deepEqual(await app.service.pendingStaff(),[]);
});

test('a definite dispatch 409 is terminal across restart even for the original command object',async()=>{
 const app=setup();app.session({userId:'owner',role:'admin'});
 const command=await app.service.prepareStaff('dispatch','old-preview');let posts=0;
 app.respond((_url,init)=>{if(init.method==='POST'){posts++;return new Response(null,{status:409});}return Response.json({id:'old-preview',plan_id:null});});
 await assert.rejects(app.service.submitStaff(command),error=>error instanceof transport.StaffApiError&&error.status===409);
 assert.equal(command.recomputeRequired,undefined);
 const restarted=app.reload(),[saved]=await restarted.pendingStaff();
 assert.equal(saved.rejected,true);assert.equal(saved.recomputeRequired,true);assert.equal(saved.resource_id,'old-preview');assert.equal(saved.command_id,command.command_id);
 await assert.rejects(restarted.submitStaff(command),/compute a new preview/);
 await assert.rejects(restarted.submitStaff(saved),/compute a new preview/);
 await assert.rejects(restarted.prepareStaff('dispatch','old-preview'),/compute a new preview/);
 await assert.rejects(restarted.discardRejectedStaff(saved),/Refresh routing state/);
 assert.equal(posts,1);
 const requests=[];app.respond((url,init)=>{requests.push({url,method:init.method??'GET'});return Response.json(url.endsWith('/plans/current')?{plan:null}:{id:'old-preview',plan_id:null});});
 assert.deepEqual(await restarted.reconcileDispatchConflict(command),{plan_id:null});
 assert.deepEqual(await restarted.pendingStaff(),[]);assert.ok(requests.every(request=>request.method==='GET'));assert.equal(requests.length,2);
 const tombstones=[...app.files].filter(([uri])=>uri.endsWith('.json')).map(([,text])=>JSON.parse(text));
 assert.equal(tombstones.length,1);assert.equal(tombstones[0].reconciled,true);
 const again=app.reload();await assert.rejects(again.submitStaff(command),/compute a new preview/);
 await assert.rejects(again.prepareStaff('dispatch','old-preview'),/compute a new preview/);
 const fresh=await again.prepareStaff('dispatch','fresh-preview');assert.notEqual(fresh.command_id,command.command_id);assert.equal(fresh.resource_id,'fresh-preview');
 assert.equal(posts,1);
});

test('failed conflict reconciliation preserves the visible action and its terminal state',async()=>{
 const app=setup();app.session({userId:'owner',role:'admin'});
 const command=await app.service.prepareStaff('dispatch','preview');let posts=0;
 app.respond((_url,init)=>{if(init.method==='POST'){posts++;return new Response(null,{status:409});}return Response.json({plan_id:null});});
 await assert.rejects(app.service.submitStaff(command));
 app.respond(url=>url.endsWith('/plans/current')?new Response(null,{status:503}):Response.json({plan_id:null}));
 await assert.rejects(app.service.reconcileDispatchConflict(command),transport.StaffApiError);
 const restarted=app.reload(),[saved]=await restarted.pendingStaff();assert.equal(saved.recomputeRequired,true);assert.notEqual(saved.reconciled,true);
 await assert.rejects(restarted.submitStaff(command),/compute a new preview/);assert.equal(posts,1);
});

test('conflict reconciliation observes another organiser dispatch without claiming our command succeeded',async()=>{
 const app=setup();app.session({userId:'owner',role:'admin'});
 const command=await app.service.prepareStaff('dispatch','preview');let posts=0;
 app.respond((_url,init)=>{if(init.method==='POST'){posts++;return new Response(null,{status:409});}return Response.json({plan_id:null});});
 await assert.rejects(app.service.submitStaff(command));
 app.respond(url=>Response.json(url.endsWith('/plans/current')?{plan:{id:'another-organiser-plan'}}:{plan_id:'another-organiser-plan'}));
 assert.deepEqual(await app.service.reconcileDispatchConflict(command),{plan_id:'another-organiser-plan'});
 assert.deepEqual(await app.service.pendingStaff(),[]);
 const saved=[...app.files].filter(([uri])=>uri.endsWith('.json')).map(([,text])=>JSON.parse(text))[0];
 assert.equal(saved.reconciled,true);assert.equal(saved.rejected,true);assert.equal(saved.command_id,command.command_id);assert.equal(saved.accepted,undefined);
 assert.equal(posts,1);
});

test('reconciliation reauthorises after GET and never retires another accounts action',async()=>{
 const app=setup();app.session({userId:'owner',role:'admin'});
 const command=await app.service.prepareStaff('dispatch','preview');
 app.respond((_url,init)=>init.method==='POST'?new Response(null,{status:409}):Response.json({plan_id:null}));
 await assert.rejects(app.service.submitStaff(command));
 const reading=deferred(),reply=deferred();let gets=0;
 app.respond(()=>{gets++;if(gets===2)reading.resolve();return reply.promise;});
 const pending=app.service.reconcileDispatchConflict(command);const settled=pending.catch(()=>{});
 await reading.promise;app.session({userId:'different',role:'admin'});reply.resolve(Response.json({plan_id:null,plan:null}));
 await assert.rejects(pending,/account changed|account that saved/);await settled;
 app.session({userId:'owner',role:'admin'});const [saved]=await app.reload().pendingStaff();assert.equal(saved.recomputeRequired,true);assert.notEqual(saved.reconciled,true);
});

test('lost dispatch acknowledgement recovers the observed plan without a second POST',async()=>{
 const app=setup();app.session({userId:'owner',role:'admin'});
 const command=await app.service.prepareStaff('dispatch','preview');let posts=0,accepted=false;
 app.respond((_url,init)=>{if(init.method==='POST'){posts++;assert.deepEqual(JSON.parse(init.body),{command_id:command.command_id});accepted=true;throw Error('lost acknowledgement');}return Response.json({plan_id:accepted?'accepted-plan':null});});
 await assert.rejects(app.service.submitStaff(command),/lost acknowledgement/);
 const restarted=app.reload(),[saved]=await restarted.pendingStaff();assert.notEqual(saved.recomputeRequired,true);assert.equal(saved.dispatchAttemptPending,false);assert.notEqual(saved.rejected,true);assert.equal(saved.resource_id,command.resource_id);assert.equal(saved.command_id,command.command_id);
 await assert.rejects(restarted.reconcileDispatchConflict(saved),/Only a rejected or interrupted dispatch/);
 assert.deepEqual(await restarted.submitStaff(saved),{plan_id:'accepted-plan'});assert.equal(posts,1);assert.deepEqual(await restarted.pendingStaff(),[]);
});

test('dispatch network and 5xx failures retry immutable preview and command identities',async()=>{
 for(const failure of ['network','server']){
  const app=setup();app.session({userId:'owner',role:'admin'});
  const command=await app.service.prepareStaff('dispatch','preview');let posts=0;const payloads=[];
  app.respond((_url,init)=>{if(init.method==='POST'){posts++;payloads.push(JSON.parse(init.body));if(posts===1){if(failure==='network')throw Error('network unavailable');return new Response(null,{status:503});}return Response.json({plan_id:'accepted-plan'});}return Response.json({plan_id:null});});
  await assert.rejects(app.service.submitStaff(command));
  const restarted=app.reload(),[saved]=await restarted.pendingStaff();assert.notEqual(saved.recomputeRequired,true);assert.equal(saved.dispatchAttemptPending,false);assert.notEqual(saved.rejected,true);assert.equal(saved.resource_id,command.resource_id);
  await restarted.submitStaff(saved);assert.equal(posts,2);assert.deepEqual(payloads,[{command_id:command.command_id},{command_id:command.command_id}]);
 }
});

test('non-dispatch 409 keeps the existing recovery and discard contract',async()=>{
 const app=setup();const command=await app.service.prepareStaff('start',job);let posts=0;
 app.respond((_url,init)=>{if(init.method==='PATCH'){posts++;return new Response(null,{status:409});}return Response.json({job,events:[]});});
 await assert.rejects(app.service.submitStaff(command));
 const [saved]=await app.reload().pendingStaff();assert.equal(saved.rejected,true);assert.equal(saved.recomputeRequired,undefined);
 await assert.rejects(app.service.submitStaff(saved));assert.equal(posts,2);
});

test('legacy rejected dispatch records require recomputation after restart without changing uncertain records',async()=>{
 const app=setup();app.session({userId:'owner',role:'admin'});
 const legacy=await app.service.prepareStaff('dispatch','legacy-preview');
 for(const [uri,text] of app.files){if(uri.endsWith('.json')){const record=JSON.parse(text);if(record.command_id===legacy.command_id)app.files.set(uri,JSON.stringify({...record,rejected:true}));}}
 const uncertain=await app.service.prepareStaff('dispatch','uncertain-preview');
 const restarted=app.reload(),pending=await restarted.pendingStaff();
 assert.equal(pending.find(command=>command.command_id===legacy.command_id).recomputeRequired,true);
 assert.equal(pending.find(command=>command.command_id===uncertain.command_id).recomputeRequired,undefined);
 let calls=0;app.respond(url=>{calls++;return Response.json(url.endsWith('/plans/current')?{plan:null}:{plan_id:null});});
 await assert.rejects(restarted.submitStaff(legacy),/compute a new preview/);assert.equal(calls,0);
 await restarted.reconcileDispatchConflict(legacy);assert.equal(calls,2);
 assert.deepEqual((await app.reload().pendingStaff()).map(command=>command.command_id),[uncertain.command_id]);
});

test('a stale command object cannot submit when its durable journal is missing or corrupt',async()=>{
 for(const corrupt of [false,true]){
  const app=setup();app.session({userId:'owner',role:'admin'});
  const command=await app.service.prepareStaff('dispatch','preview');
  for(const [uri] of app.files){if(uri.endsWith('.json')){if(corrupt)app.files.set(uri,'{');else app.files.delete(uri);}}
  let requests=0;app.respond(()=>{requests++;return Response.json({plan_id:null});});
  await assert.rejects(app.reload().submitStaff(command),/saved action is unavailable/);assert.equal(requests,0);
 }
});

test('dispatch keeps its definite HTTP 409 classification if rejection metadata cannot publish',async()=>{
 const app=setup();app.session({userId:'owner',role:'admin'});
 const command=await app.service.prepareStaff('dispatch','preview');
 app.respond((_url,init)=>{if(init.method==='POST'){app.faults.move=true;return new Response(null,{status:409});}return Response.json({plan_id:null});});
 await assert.rejects(app.service.submitStaff(command),error=>error instanceof transport.StaffApiError&&error.status===409);
 assert.equal((await app.reload().pendingStaff())[0].command_id,command.command_id);
});

test('a dispatch must publish its durable attempt barrier before sending POST',async()=>{
 for(const fault of ['write','rename']){
 const app=setup();app.session({userId:'owner',role:'admin'});
 const command=await app.service.prepareStaff('dispatch','preview');let posts=0;
 app.respond((_url,init)=>{if(init.method==='POST'){posts++;return Response.json({plan_id:'plan'});}return Response.json({plan_id:null});});
 if(fault==='write')app.faults.write=()=>{throw Error('write interrupted');};else app.faults.move=true;
 await assert.rejects(app.service.submitStaff(command),/interrupted/);assert.equal(posts,0);
 const [saved]=await app.reload().pendingStaff();assert.equal(saved.dispatchAttemptPending,undefined);assert.equal(saved.command_id,command.command_id);
 }
});

test('failed 409 checkpoint stays non-POST-able after restart and the in-process latch can persist later',async()=>{
 for(const fault of ['write','rename']){
 const app=setup();app.session({userId:'owner',role:'admin'});
 const command=await app.service.prepareStaff('dispatch','preview');let posts=0;
 app.respond((_url,init)=>{if(init.method==='POST'){
  posts++;
  const [stored]=[...app.files].filter(([uri])=>uri.endsWith('.json')).map(([,value])=>JSON.parse(value));
  assert.equal(stored.dispatchAttemptPending,true);
  if(fault==='write')app.faults.write=()=>{throw Error('write interrupted');};else app.faults.move=true;return new Response(null,{status:409});
 }return Response.json({plan_id:null});});
 await assert.rejects(app.service.submitStaff(command),error=>error instanceof transport.StaffApiError&&error.status===409);
 const [latched]=await app.service.pendingStaff();assert.equal(latched.recomputeRequired,true);assert.equal(latched.rejected,true);
 await assert.rejects(app.service.submitStaff(command),/compute a new preview/);assert.equal(posts,1);
 const restarted=app.reload(),[unknown]=await restarted.pendingStaff();
 assert.equal(unknown.dispatchAttemptPending,true);assert.notEqual(unknown.recomputeRequired,true);assert.notEqual(unknown.rejected,true);
 const reads=[];app.respond((url,init)=>{reads.push(init.method??'GET');return Response.json(url.endsWith('/plans/current')?{plan:null}:{plan_id:null});});
 await assert.rejects(restarted.submitStaff(command),/confirmation is still unknown/);
 await assert.rejects(restarted.prepareStaff('dispatch','preview'),/confirmation is still unknown/);
 await assert.rejects(restarted.discardRejectedStaff({...unknown,rejected:true}),/Refresh routing state/);
 assert.ok(reads.every(method=>method==='GET'));assert.equal((await restarted.pendingStaff()).length,1);assert.equal(posts,1);
 app.respond(url=>url.endsWith('/plans/current')?Response.json({plan:null}):new Response(null,{status:404}));
 await assert.rejects(restarted.submitStaff(command),/confirmation is still unknown/);assert.equal((await restarted.pendingStaff()).length,1);
 app.faults.move=false;delete app.faults.write;
 app.respond(url=>url.endsWith('/plans/current')?Response.json({plan:null}):new Response(null,{status:503}));
 await assert.rejects(app.service.reconcileDispatchConflict(command),transport.StaffApiError);
 const repaired=app.reload(),[known]=await repaired.pendingStaff();
 assert.equal(known.recomputeRequired,true);assert.equal(known.rejected,true);assert.equal(known.dispatchAttemptPending,false);
 app.respond(url=>url.endsWith('/plans/current')?Response.json({plan:null}):new Response(null,{status:404}));
 assert.deepEqual(await repaired.reconcileDispatchConflict(command),{plan_id:null});assert.deepEqual(await repaired.pendingStaff(),[]);
 await assert.rejects(app.reload().submitStaff(command),/compute a new preview/);assert.equal(posts,1);
 }
});

test('failed unknown-outcome checkpoint can only inspect GETs and recover an observed plan',async()=>{
 for(const accepted of [false,true]){
  const app=setup();app.session({userId:'owner',role:'admin'});
  const command=await app.service.prepareStaff('dispatch','preview');let posts=0;
  app.respond((_url,init)=>{if(init.method==='POST'){posts++;app.faults.move=true;throw Error('lost acknowledgement');}return Response.json({plan_id:null});});
  await assert.rejects(app.service.submitStaff(command),/lost acknowledgement/);
  const restarted=app.reload(),[saved]=await restarted.pendingStaff();assert.equal(saved.dispatchAttemptPending,true);assert.notEqual(saved.recomputeRequired,true);
  app.faults.move=false;const reads=[];
  app.respond((url,init)=>{reads.push(init.method??'GET');return Response.json(url.endsWith('/plans/current')?{plan:accepted?{id:'observed-plan'}:null}:{plan_id:accepted?'observed-plan':null});});
  if(accepted){assert.deepEqual(await restarted.submitStaff(command),{plan_id:'observed-plan'});assert.deepEqual(await restarted.pendingStaff(),[]);}
  else{await assert.rejects(restarted.submitStaff(command),/confirmation is still unknown/);assert.equal((await restarted.pendingStaff()).length,1);}
  assert.ok(reads.every(method=>method==='GET'));assert.equal(posts,1);
 }
});

test('a pruned terminal preview retires only after successfully reading current routing state',async()=>{
 for(const failure of [null,401,403,503,'network']){
  const app=setup();app.session({userId:'owner',role:'admin'});
  const command=await app.service.prepareStaff('dispatch','preview');let posts=0;
  app.respond((_url,init)=>{if(init.method==='POST'){posts++;return new Response(null,{status:409});}return Response.json({plan_id:null});});
  await assert.rejects(app.service.submitStaff(command));
  const methods=[];app.respond((url,init)=>{
   methods.push(init.method??'GET');
   if(!url.endsWith('/plans/current'))return new Response(null,{status:404});
   if(failure==='network')throw Error('network unavailable');
   return failure===null?Response.json({plan:null}):new Response(null,{status:failure});
  });
  const restarted=app.reload();
  if(failure===null){assert.deepEqual(await restarted.reconcileDispatchConflict(command),{plan_id:null});assert.deepEqual(await restarted.pendingStaff(),[]);}
  else{await assert.rejects(restarted.reconcileDispatchConflict(command));assert.equal((await restarted.pendingStaff()).length,1);}
  assert.ok(methods.every(method=>method==='GET'));assert.equal(posts,1);
 }
});

test('the transport recovery helper never POSTs an interrupted barrier unless it observes an accepted plan',async()=>{
 const app=setup();app.session({userId:'owner',role:'admin'});
 const command=await app.service.prepareStaff('dispatch','preview');let posts=0,accepted=false;
 app.respond((_url,init)=>{if(init.method==='POST')posts++;return Response.json({plan_id:accepted?'observed-plan':null});});
 await assert.rejects(commands.recoverOrSend({...command,dispatchAttemptPending:true},app.api),/confirmation is still unknown/);assert.equal(posts,0);
 accepted=true;assert.deepEqual(await commands.recoverOrSend({...command,dispatchAttemptPending:true},app.api),{plan_id:'observed-plan'});assert.equal(posts,0);
});

test('a new attempt clears an earlier validation rejection before publishing its unknown barrier',async()=>{
 const app=setup();app.session({userId:'owner',role:'admin'});
 const command=await app.service.prepareStaff('dispatch','preview');let posts=0;
 app.respond((_url,init)=>{
  if(init.method!=='POST')return Response.json({plan_id:null});
  posts++;
  if(posts===1)return new Response(null,{status:422});
  const [stored]=[...app.files].filter(([uri])=>uri.endsWith('.json')).map(([,value])=>JSON.parse(value));
  assert.equal(stored.dispatchAttemptPending,true);assert.equal(stored.rejected,false);assert.equal(stored.recomputeRequired,false);
  app.faults.move=true;throw Error('network interrupted');
 });
 await assert.rejects(app.service.submitStaff(command));
 const [rejected]=await app.service.pendingStaff();assert.equal(rejected.rejected,true);assert.equal(rejected.recomputeRequired,false);
 await assert.rejects(app.service.submitStaff(rejected),/network interrupted/);
 const [unknown]=await app.reload().pendingStaff();assert.equal(unknown.dispatchAttemptPending,true);assert.equal(unknown.rejected,false);assert.equal(unknown.recomputeRequired,false);
 app.respond(()=>Response.json({plan_id:null,plan:null}));
 await assert.rejects(app.reload().submitStaff(command),/confirmation is still unknown/);assert.equal(posts,2);
});

test('preview authorization or availability failures never retire a rejected dispatch even when current state is readable',async()=>{
 for(const failure of [401,403,503,'network']){
  const app=setup();app.session({userId:'owner',role:'admin'});
  const command=await app.service.prepareStaff('dispatch','preview');let posts=0;
  app.respond((_url,init)=>{if(init.method==='POST'){posts++;return new Response(null,{status:409});}return Response.json({plan_id:null});});
  await assert.rejects(app.service.submitStaff(command));
  app.respond(url=>{
   if(url.endsWith('/plans/current'))return Response.json({plan:null});
   if(failure==='network')throw Error('preview unavailable');
   return new Response(null,{status:failure});
  });
  const restarted=app.reload();await assert.rejects(restarted.reconcileDispatchConflict(command));
  const [saved]=await restarted.pendingStaff();assert.equal(saved.recomputeRequired,true);assert.notEqual(saved.reconciled,true);assert.equal(posts,1);
 }
});

test('a safely checkpointed network retry clears the earlier rejection and cannot be discarded',async()=>{
 const app=setup();app.session({userId:'owner',role:'admin'});
 const command=await app.service.prepareStaff('dispatch','preview');let posts=0;
 app.respond((_url,init)=>{
  if(init.method!=='POST')return Response.json({plan_id:null});
  if(++posts===1)return new Response(null,{status:422});
  throw Error('network interrupted');
 });
 await assert.rejects(app.service.submitStaff(command));
 const [rejected]=await app.service.pendingStaff();assert.equal(rejected.rejected,true);
 await assert.rejects(app.service.submitStaff(rejected),/network interrupted/);
 const restarted=app.reload(),[uncertain]=await restarted.pendingStaff();assert.equal(uncertain.dispatchAttemptPending,false);assert.equal(uncertain.rejected,false);assert.equal(uncertain.recomputeRequired,false);
 await assert.rejects(restarted.discardRejectedStaff(uncertain),/Only a rejected submission/);assert.equal(posts,2);
});

test('photo-free completion persists one immutable command before HTTP and recovers a lost acknowledgement',async()=>{
 const app=setup();let posts=0,accepted=false;
 const [first,duplicate]=await Promise.all([app.service.prepareStaff('completion',job),app.service.prepareStaff('completion',job)]);
 assert.equal(first.command_id,duplicate.command_id);assert.equal(first.photoUri,undefined);
 assert.deepEqual([...app.files.keys()].filter(uri=>uri.startsWith('file:///documents/')&&!uri.endsWith('.json')),[]);
 app.respond((_url,init)=>{
  if(init.method==='POST'){
   posts++;const persisted=[...app.files].filter(([uri])=>uri.endsWith('.json')).map(([,value])=>JSON.parse(value));
   assert.equal(persisted[0].command_id,first.command_id);assert.equal(persisted[0].expected_version,7);assert.equal(persisted[0].photoUri,undefined);
   assert.deepEqual([...init.body.keys()],['command_id','expected_version']);assert.equal(init.body.get('photo'),null);
   accepted=true;throw Error('lost completion acknowledgement');
  }
  return Response.json({job:{...job,status:accepted?'completed':'in_progress'},events:accepted?[{kind:'job.completed',command_id:first.command_id}]:[]});
 });
 await assert.rejects(app.service.submitStaff(first),/lost completion acknowledgement/);
 const restarted=app.reload(),[saved]=await restarted.pendingStaff();assert.equal(saved.command_id,first.command_id);assert.equal(saved.expected_version,7);assert.equal(saved.photoUri,undefined);
 await restarted.submitStaff(saved);assert.equal(posts,1);assert.deepEqual(await restarted.pendingStaff(),[]);
});

test('the first saved photo choice cannot be upgraded or downgraded during completion retry',async()=>{
 for(const withPhoto of [false,true]){
  const app=setup();
  const first=await app.service.prepareStaff('completion',job,withPhoto?'file:///camera/cleanup.jpg':undefined);
  const second=await app.service.prepareStaff('completion',job,withPhoto?undefined:'file:///camera/cleanup.jpg');
  assert.equal(second.command_id,first.command_id);assert.equal(second.photoUri,first.photoUri);
  app.respond((_url,init)=>{
   if(init.method==='POST'){assert.equal(init.body.has('photo'),withPhoto);return Response.json({...job,status:'completed'});}
   return Response.json({job,events:[]});
  });
  await app.reload().submitStaff({...first,photoUri:withPhoto?undefined:'file:///camera/cleanup.jpg'});
 }
});

test('a missing saved completion photo stays pending and never becomes a photo-free POST',async()=>{
 const app=setup();const command=await app.service.prepareStaff('completion',job,'file:///camera/cleanup.jpg');
 app.files.delete(command.photoUri);let posts=0;
 app.respond((_url,init)=>{if(init.method==='POST')posts++;return Response.json({job,events:[]});});
 await assert.rejects(app.reload().submitStaff({...command,photoUri:undefined}),/saved cleanup photo is unavailable/);
 const [saved]=await app.reload().pendingStaff();assert.equal(saved.photoUri,command.photoUri);assert.equal(posts,0);
 app.respond(()=>Response.json({job:{...job,status:'completed'},events:[{kind:'job.completed',command_id:command.command_id}]}));
 await app.service.submitStaff(command);assert.equal(posts,0);assert.deepEqual(await app.service.pendingStaff(),[]);
});

test('an invalid supplied photo cannot be silently interpreted as no-photo completion',async()=>{
 for(const uri of ['', '  ', 'file:///missing.jpg', 'file:///empty.jpg', 'file:///invalid.gif']){
  const app=setup();app.files.set('file:///empty.jpg','');app.files.set('file:///invalid.gif','invalid format');let requests=0;
  app.respond(()=>{requests++;return Response.json({job,events:[]});});
  await assert.rejects(app.service.prepareStaff('completion',job,uri),/valid cleanup photo|JPEG, PNG or WebP/);
  assert.deepEqual(await app.service.pendingStaff(),[]);assert.equal(requests,0);
 }
});

test('photo-free completion keeps its owner and version through restart and cannot borrow another account',async()=>{
 const app=setup();const command=await app.service.prepareStaff('completion',job);let posts=0;
 app.session({userId:'other',role:'crew',crewId:'crew'});const restarted=app.reload();
 assert.deepEqual(await restarted.pendingStaff(),[]);await assert.rejects(restarted.submitStaff(command),/account that saved/);
 app.session({userId:'owner',role:'crew',crewId:'crew'});
 app.respond((_url,init)=>{
  if(init.method==='POST'){posts++;assert.equal(init.body.get('expected_version'),'7');assert.equal(init.body.get('command_id'),command.command_id);assert.equal(init.body.has('photo'),false);return Response.json({...job,status:'completed'});}
  return Response.json({job,events:[{kind:'job.completed',command_id:'someone-else'}]});
 });
 await restarted.submitStaff(command);assert.equal(posts,1);assert.deepEqual(await restarted.pendingStaff(),[]);
});
