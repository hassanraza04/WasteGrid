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
  'expo-crypto':{randomUUID:()=>`command-${++next}`},'expo-file-system':{Directory,File,Paths:{document:'file:///documents'}},
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
