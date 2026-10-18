import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import {act,button,load,mount,native,theme,ui,wrap,deferred} from './helpers/render.mjs';
const {StaffApiError}=load('services/staff-client.ts');
const blocks={...ui,Screen:wrap,Card:wrap,ScreenHeader:props=>React.createElement('h1',null,props.title),TextField:wrap};
const job={id:'job',version:2,status:'assigned',category:'mixed_waste',location:{latitude:24,longitude:67},assigned_crew_id:'A',route_position:0,held:false,locked:false,illustrative:false};
function preview(patch={}){return{id:'preview',job_ids:['job'],expires_at:new Date(Date.now()+120000).toISOString(),dispatchable:true,plan_id:null,termination_reason:'complete',travel_label:'Driving times',routes:[{crew_id:'A',duration_minutes:6,travel_minutes:1,stops:[{job_id:'job',position:0,priority:'routine',travel_minutes:1,service_minutes:5,completion_minutes:6}]}],unassigned:[],exclusions:[],reassignments:[],...patch};}
function dispatchSetup(calculate=async()=>preview(),submit=async()=>{},prepare,reconcile){
 const state={data:{crews:[{id:'A',name:'Crew A',available:true,location_recorded_at:null},{id:'B',name:'Crew B',available:true,location_recorded_at:null}],jobs:[job],pending:[],currentPlan:{plan:null}},loading:false,error:'',refresh:async()=>{}};
 const requests=[],prepared=[],reconciled=[];let read,planReads=0;
 const api={crews:async()=>state.data.crews,jobs:async()=>state.data.jobs,currentPlan:async()=>{planReads++;return state.data.currentPlan;},compute:(ids,jobIds)=>{requests.push({crew_ids:ids,job_ids:jobIds});return calculate(ids,jobIds);}};
 state.refresh=async()=>{state.data=await read();};
 const {LiveDispatch}=load('components/admin/live-dispatch.tsx',{
  'expo-router':{Link:({href,children})=>React.createElement('a',{href},children)},
  'react-native':native,'@/components/ui':blocks,'@/components/account/account-button':{AccountButton:wrap},'@/theme':theme,
  '@/hooks/use-staff-data':{useStaffData:callback=>{read=callback;return state;}},'@/services/staff':{staffApi:api},
  '@/services/pending-staff':{pendingStaff:async()=>state.data?.pending??[],prepareStaff:async(kind,id)=>{prepared.push({kind,id});return prepare?prepare(kind,id):{command_id:'stable',kind,resource_id:id};},submitStaff:submit,reconcileDispatchConflict:async command=>{reconciled.push(command);const result=await reconcile?.(command);state.data.pending=[];return result;}},
  '@/services/staff-client':{StaffApiError},
  '@/components/route/pending-actions':{PendingActions:wrap},'@/components/route/route-map':{RouteMap:wrap},
 });
 return{state,requests,prepared,reconciled,planReads:()=>planReads,view:mount(LiveDispatch,{})};
}
test('compute is read-only; selection changes invalidate the preview and only approval dispatches',async()=>{
 const app=dispatchSetup();const {view}=app;
 try{
  await view.render();assert.equal(button(view.container,'Compute routes').disabled,true);
  await act(()=>button(view.container,'Crew A').click());await act(()=>button(view.container,'Job job').click());await act(async()=>button(view.container,'Compute routes').click());
  assert.deepEqual(app.requests,[{crew_ids:['A'],job_ids:['job']}]);assert.equal(app.prepared.length,0);assert.match(view.container.textContent,/6 min total/);assert.match(view.container.textContent,/1 min travel · 5 min service/);
  assert.equal(view.container.textContent.includes('Return to start'),false);assert.equal(view.container.textContent.includes('Max stops'),false);
  await act(()=>button(view.container,'Crew B').click());assert.equal(view.container.textContent.includes('Route preview'),false);
  await act(async()=>button(view.container,'Compute routes').click());await act(async()=>button(view.container,'Approve and dispatch').click());
  assert.deepEqual(app.prepared,[{kind:'dispatch',id:'preview'}]);assert.equal(view.container.textContent.includes('Route preview'),false);
 }finally{await view.close();}
});
test('expired and partial previews cannot dispatch and exclusions remain prominent',async()=>{
 for(const value of [preview({expires_at:new Date(Date.now()-1000).toISOString()}),preview({dispatchable:false,termination_reason:'travel_data_unavailable',unassigned:[{job_id:'missing',reason:'travel_data_unavailable'}]})]){
  const {view}=dispatchSetup(async()=>value);
  try{await view.render();await act(()=>button(view.container,'Crew A').click());await act(()=>button(view.container,'Job job').click());await act(async()=>button(view.container,'Compute routes').click());assert.equal(button(view.container,'Approve and dispatch').disabled,true);assert.match(view.container.textContent,/Dispatch unavailable/);}
  finally{await view.close();}
 }
});
test('pending dispatch blocks competing approvals; access failures hide an existing preview',async()=>{
 const app=dispatchSetup();const {view,state}=app;
 try{
  await view.render();await act(()=>button(view.container,'Crew A').click());await act(()=>button(view.container,'Job job').click());await act(async()=>button(view.container,'Compute routes').click());
  state.data.pending=[{kind:'dispatch'}];await view.render();assert.equal(button(view.container,'Compute routes').disabled,true);assert.equal(button(view.container,'Approve and dispatch').disabled,true);
  state.data=null;state.error='Access denied';await view.render();assert.equal(view.container.textContent.includes('Route preview'),false);assert.match(view.container.textContent,/Access denied/);
 }finally{await view.close();}
});
test('selection locks during compute; late responses after unmount do not dispatch',async()=>{
 const pending=deferred();const app=dispatchSetup(()=>pending.promise);const {view}=app;
 await view.render();await act(()=>button(view.container,'Crew A').click());await act(()=>button(view.container,'Job job').click());await act(()=>button(view.container,'Compute routes').click());
 assert.equal(button(view.container,'Crew B').disabled,true);await view.close();await act(async()=>pending.resolve(preview()));assert.deepEqual(app.prepared,[]);
});
test('crew starts in server order, captures evidence, and removes a stop only after confirmed completion',async()=>{
 let camera;const prepared=[];const mapped=[];
 const first={...job};const second={...job,id:'second',route_position:1};
 const state={data:{jobs:[first,second],pending:[]},loading:false,error:'',refresh:async()=>{}};
 const {LiveCrewRoute}=load('components/route/live-crew-route.tsx',{
  'react-native':{Linking:{openURL:async()=>{}}},'expo-image':{Image:wrap},'@/components/ui':blocks,
  '@/components/account/account-button':{AccountButton:wrap},'@/components/report/camera-step':{CameraStep:props=>{camera=props;return null;}},
  '@/components/route/route-map':{RouteMap:props=>{mapped.push(props.stops);return null;}},'@/components/route/pending-actions':{PendingActions:wrap},
  '@/hooks/use-crew-location':{useCrewLocation:()=>({message:'GPS shared',refresh:async()=>{}})},'@/hooks/use-staff-data':{useStaffData:()=>state},'@/services/staff':{staffApi:{}},
  '@/services/pending-staff':{pendingStaff:async()=>[],prepareStaff:async(kind,value,uri)=>{prepared.push({kind,version:value.version,uri});return{kind};},submitStaff:async command=>{
   if(command.kind==='start'){first.status='in_progress';first.version++;}else state.data.jobs=[second];
  }},
 });
 const view=mount(LiveCrewRoute,{});
 try{
  await view.render();const starts=[...view.container.querySelectorAll('button')].filter(button=>button.textContent==='Start stop');assert.equal(starts[0].disabled,false);assert.equal(starts[1].disabled,true);
  await act(async()=>starts[0].click());assert.deepEqual(prepared[0],{kind:'start',version:2,uri:undefined});
  await act(()=>button(view.container,'Take cleanup photo').click());await act(()=>camera.onCapture('file:///cleanup.jpg'));
  assert.match(view.container.textContent,/Review cleanup evidence/);assert.equal(mapped.at(-1).length,2);
  await act(async()=>button(view.container,'Submit cleanup photo').click());
  assert.deepEqual(prepared[1],{kind:'completion',version:3,uri:'file:///cleanup.jpg'});assert.equal(mapped.at(-1).length,1);assert.match(view.container.textContent,/Cleanup confirmed/);
  assert.equal(view.container.textContent.includes('Mark not cleaned'),false);assert.equal(button(view.container,'Start stop').disabled,false);
 }finally{await view.close();}
});

test('dispatch refreshes the authoritative plan including preserved fixed work',async()=>{
 const app=dispatchSetup(undefined,async()=>{
  app.state.data.currentPlan={plan:{id:'saved-plan',stale:false,travel_estimates_label:'Frozen road times',assignments:[{job_id:'fixed-job',crew_id:'B',position:0,travel_minutes:2,service_minutes:3}]}};
  app.state.data.jobs.push({...job,id:'fixed-job',assigned_crew_id:'B',status:'in_progress',locked:true});
 });const {view}=app;
 try{
  await view.render();await act(async()=>button(view.container,'Refresh fleet and current plan').click());assert.equal(app.planReads(),1);assert.match(view.container.textContent,/No dispatched plan yet/);
  await act(()=>button(view.container,'Crew A').click());await act(()=>button(view.container,'Job job').click());await act(async()=>button(view.container,'Compute routes').click());await act(async()=>button(view.container,'Approve and dispatch').click());
  assert.equal(app.planReads(),2);assert.match(view.container.textContent,/saved-plan/);assert.match(view.container.textContent,/Crew B · stop 1/);assert.match(view.container.textContent,/2 min travel · 3 min service · in progress · fixed/);
 }finally{await view.close();}
});


test('explicit job selection includes every existing selected-crew assignment and leaves other crews alone',async()=>{
 const app=dispatchSetup();const {view,state}=app;
 state.data.jobs.push({...job,id:'second',route_position:1},{...job,id:'foreign',assigned_crew_id:'B',held:true,illustrative:true});
 try{
  await view.render();await act(()=>button(view.container,'Crew A').click());
  assert.equal(button(view.container,'Job foreign').disabled,true);
  await act(()=>button(view.container,'Job job').click());
  assert.equal(button(view.container,'Compute routes').disabled,true);
  assert.match(view.container.textContent,/Include every unfinished job/);
  assert.match(view.container.textContent,/Illustrative demo job/);assert.match(view.container.textContent,/Real report job/);assert.match(view.container.textContent,/Assigned crew: Crew B · held/);
  await act(()=>button(view.container,'Job second').click());assert.equal(button(view.container,'Compute routes').disabled,false);
  await act(()=>button(view.container,'Crew B').click());assert.equal(button(view.container,'Compute routes').disabled,true);
  await act(()=>button(view.container,'Job foreign').click());assert.equal(button(view.container,'Compute routes').disabled,false);
  await act(()=>button(view.container,'Crew B').click());assert.equal(button(view.container,'Compute routes').disabled,true);
  assert.match(view.container.textContent,/belongs to an unselected crew/);
  await act(()=>button(view.container,'Job foreign').click());assert.equal(button(view.container,'Compute routes').disabled,false);
  assert.deepEqual(app.requests,[]);assert.deepEqual(app.prepared,[]);
 }finally{await view.close();}
});

test('the job picker caps scope at 25 and can explicitly clear it',async()=>{
 const app=dispatchSetup();const {view,state}=app;
 state.data.jobs.push(...Array.from({length:26},(_,i)=>({...job,id:`free-${i}`,assigned_crew_id:null})));
 try{
  await view.render();await act(()=>button(view.container,'Crew A').click());await act(()=>button(view.container,'Job job').click());
  for(let i=0;i<24;i++)await act(()=>button(view.container,`Job free-${i}`).click());
  assert.match(view.container.textContent,/Selected job scope · 25\/25/);
  assert.equal(button(view.container,'Job free-24').disabled,true);
  await act(()=>button(view.container,'Clear job selection').click());
  assert.equal(button(view.container,'Compute routes').disabled,true);assert.match(view.container.textContent,/Select at least one job/);
  assert.equal(button(view.container,'Job free-24').disabled,false);
 }finally{await view.close();}
});

test('job scope changes invalidate the preview and stale selected jobs block dispatch',async()=>{
 const app=dispatchSetup();const {view,state}=app;
 try{
  await view.render();await act(()=>button(view.container,'Crew A').click());await act(()=>button(view.container,'Job job').click());
  await act(async()=>button(view.container,'Compute routes').click());assert.equal(button(view.container,'Approve and dispatch').disabled,false);
  state.data.jobs=[];await view.render();assert.equal(button(view.container,'Approve and dispatch').disabled,true);
  assert.match(view.container.textContent,/selected job is no longer active/);
  await act(()=>button(view.container,'Clear job selection').click());assert.equal(view.container.textContent.includes('Route preview'),false);
 }finally{await view.close();}
});

test('missing, expanded or inconsistent backend scopes fail closed with no fallback or dispatch',async()=>{
 const bad=[preview({job_ids:undefined}),preview({job_ids:null}),preview({job_ids:['foreign']}),preview({routes:[{crew_id:'A',stops:[{job_id:'foreign'}]}]}),preview({routes:[]})];
 for(const response of bad){
  const app=dispatchSetup(async()=>response);const {view}=app;
  try{
   await view.render();await act(()=>button(view.container,'Crew A').click());await act(()=>button(view.container,'Job job').click());
   await act(async()=>button(view.container,'Compute routes').click());
   assert.match(view.container.textContent,/backend did not confirm the selected job scope/);
   assert.equal(view.container.textContent.includes('Route preview'),false);assert.equal(app.requests.length,1);assert.deepEqual(app.prepared,[]);
  }finally{await view.close();}
 }
});

test('unmount during durable dispatch preparation does not submit or refresh a departed screen',async()=>{
 const preparation=deferred();let submits=0;
 const app=dispatchSetup(undefined,async()=>{submits++;},()=>preparation.promise);const {view}=app;
 await view.render();await act(()=>button(view.container,'Crew A').click());await act(()=>button(view.container,'Job job').click());
 await act(async()=>button(view.container,'Compute routes').click());
 await act(()=>button(view.container,'Approve and dispatch').click());
 await view.close();await act(async()=>preparation.resolve({command_id:'stable'}));
 assert.equal(app.prepared.length,1);assert.equal(submits,0);assert.equal(app.planReads(),0);
});


test('a definitive dispatch conflict removes the old preview, keeps scope and requires a fresh explicit approval',async()=>{
 let calculations=0,submits=0;
 const app=dispatchSetup(async()=>preview({id:calculations++?'fresh-preview':'old-preview'}),async command=>{
  submits++;
  if(submits===1){app.state.data.pending=[{...command,rejected:true,recomputeRequired:true}];throw new StaffApiError(409);}
 });const {view}=app;
 try{
  await view.render();await act(()=>button(view.container,'Crew A').click());await act(()=>button(view.container,'Job job').click());
  await act(async()=>button(view.container,'Compute routes').click());
  await act(async()=>button(view.container,'Approve and dispatch').click());
  assert.equal(view.container.textContent.includes('Route preview'),false);
  assert.equal(button(view.container,'Crew A').dataset.selected,'true');assert.equal(button(view.container,'Job job').dataset.selected,'true');
  assert.equal(app.reconciled[0].resource_id,'old-preview');assert.equal(app.planReads(),1);assert.equal(app.requests.length,1);assert.equal(app.prepared.length,1);
  assert.equal(button(view.container,'Compute routes').disabled,false);
  await act(async()=>button(view.container,'Compute routes').click());assert.equal(app.prepared.length,1);
  await act(async()=>button(view.container,'Approve and dispatch').click());
  assert.deepEqual(app.prepared,[{kind:'dispatch',id:'old-preview'},{kind:'dispatch',id:'fresh-preview'}]);assert.equal(submits,2);
 }finally{await view.close();}
});

test('an unreadable conflicting preview remains flagged and blocks competing calculations',async()=>{
 const app=dispatchSetup(undefined,async command=>{app.state.data.pending=[{...command,rejected:true,recomputeRequired:true}];throw new StaffApiError(409);},undefined,async()=>{throw Error('read failed');});const {view}=app;
 try{
  await view.render();await act(()=>button(view.container,'Crew A').click());await act(()=>button(view.container,'Job job').click());await act(async()=>button(view.container,'Compute routes').click());
  await act(async()=>button(view.container,'Approve and dispatch').click());
  assert.equal(view.container.textContent.includes('Route preview'),false);assert.equal(button(view.container,'Compute routes').disabled,true);
  assert.match(view.container.textContent,/Use Refresh routing state/);assert.equal(app.state.data.pending[0].recomputeRequired,true);
  assert.equal(app.requests.length,1);assert.equal(app.prepared.length,1);
 }finally{await view.close();}
});

test('an unknown dispatch failure retains the original preview and durable command for recovery',async()=>{
 const app=dispatchSetup(undefined,async command=>{app.state.data.pending=[command];throw Error('response lost');});const {view}=app;
 try{
  await view.render();await act(()=>button(view.container,'Crew A').click());await act(()=>button(view.container,'Job job').click());await act(async()=>button(view.container,'Compute routes').click());
  await act(async()=>button(view.container,'Approve and dispatch').click());
  assert.match(view.container.textContent,/Route preview/);assert.equal(button(view.container,'Compute routes').disabled,true);
  assert.equal(app.reconciled.length,0);assert.equal(app.state.data.pending[0].resource_id,'preview');assert.equal(app.state.data.pending[0].recomputeRequired,undefined);
 }finally{await view.close();}
});
