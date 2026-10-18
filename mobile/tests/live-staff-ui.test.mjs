import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import {act,button,load,mount,native,theme,ui,wrap,deferred} from './helpers/render.mjs';
const blocks={...ui,Screen:wrap,Card:wrap,ScreenHeader:props=>React.createElement('h1',null,props.title),TextField:wrap};
const job={id:'job',version:2,status:'assigned',category:'mixed_waste',location:{latitude:24,longitude:67},assigned_crew_id:'A',route_position:0};
function preview(patch={}){return{id:'preview',expires_at:new Date(Date.now()+120000).toISOString(),dispatchable:true,plan_id:null,termination_reason:'complete',travel_label:'Driving times',routes:[{crew_id:'A',duration_minutes:6,travel_minutes:1,stops:[{job_id:'job',position:0,priority:'routine',travel_minutes:1,service_minutes:5,completion_minutes:6}]}],unassigned:[],exclusions:[],reassignments:[],...patch};}
function dispatchSetup(calculate=async()=>preview(),submit=async()=>{}){
 const state={data:{crews:[{id:'A',name:'Crew A',available:true,location_recorded_at:null},{id:'B',name:'Crew B',available:true,location_recorded_at:null}],jobs:[job],pending:[],currentPlan:{plan:null}},loading:false,error:'',refresh:async()=>{}};
 const requests=[],prepared=[];let read,planReads=0;
 const api={crews:async()=>state.data.crews,jobs:async()=>state.data.jobs,currentPlan:async()=>{planReads++;return state.data.currentPlan;},compute:ids=>{requests.push(ids);return calculate();}};
 state.refresh=async()=>{state.data=await read();};
 const {LiveDispatch}=load('components/admin/live-dispatch.tsx',{
  'react-native':native,'@/components/ui':blocks,'@/components/account/account-button':{AccountButton:wrap},'@/theme':theme,
  '@/hooks/use-staff-data':{useStaffData:callback=>{read=callback;return state;}},'@/services/staff':{staffApi:api},
  '@/services/pending-staff':{pendingStaff:async()=>[],prepareStaff:async(kind,id)=>{prepared.push({kind,id});return{command_id:'stable'};},submitStaff:submit},
  '@/components/route/pending-actions':{PendingActions:wrap},'@/components/route/route-map':{RouteMap:wrap},
 });
 return{state,requests,prepared,planReads:()=>planReads,view:mount(LiveDispatch,{})};
}
test('compute is read-only; selection changes invalidate the preview and only approval dispatches',async()=>{
 const app=dispatchSetup();const {view}=app;
 try{
  await view.render();assert.equal(button(view.container,'Compute routes').disabled,true);
  await act(()=>button(view.container,'Crew A').click());await act(async()=>button(view.container,'Compute routes').click());
  assert.deepEqual(app.requests,[['A']]);assert.equal(app.prepared.length,0);assert.match(view.container.textContent,/6 min total/);assert.match(view.container.textContent,/1 min travel · 5 min service/);
  assert.equal(view.container.textContent.includes('Return to start'),false);assert.equal(view.container.textContent.includes('Max stops'),false);
  await act(()=>button(view.container,'Crew B').click());assert.equal(view.container.textContent.includes('Route preview'),false);
  await act(async()=>button(view.container,'Compute routes').click());await act(async()=>button(view.container,'Approve and dispatch').click());
  assert.deepEqual(app.prepared,[{kind:'dispatch',id:'preview'}]);assert.equal(view.container.textContent.includes('Route preview'),false);
 }finally{await view.close();}
});
test('expired and partial previews cannot dispatch and exclusions remain prominent',async()=>{
 for(const value of [preview({expires_at:new Date(Date.now()-1000).toISOString()}),preview({dispatchable:false,termination_reason:'travel_data_unavailable',unassigned:[{job_id:'missing',reason:'travel_data_unavailable'}]})]){
  const {view}=dispatchSetup(async()=>value);
  try{await view.render();await act(()=>button(view.container,'Crew A').click());await act(async()=>button(view.container,'Compute routes').click());assert.equal(button(view.container,'Approve and dispatch').disabled,true);assert.match(view.container.textContent,/Dispatch unavailable/);}
  finally{await view.close();}
 }
});
test('pending dispatch blocks competing approvals; access failures hide an existing preview',async()=>{
 const app=dispatchSetup();const {view,state}=app;
 try{
  await view.render();await act(()=>button(view.container,'Crew A').click());await act(async()=>button(view.container,'Compute routes').click());
  state.data.pending=[{kind:'dispatch'}];await view.render();assert.equal(button(view.container,'Compute routes').disabled,true);assert.equal(button(view.container,'Approve and dispatch').disabled,true);
  state.data=null;state.error='Access denied';await view.render();assert.equal(view.container.textContent.includes('Route preview'),false);assert.match(view.container.textContent,/Access denied/);
 }finally{await view.close();}
});
test('selection locks during compute; late responses after unmount do not dispatch',async()=>{
 const pending=deferred();const app=dispatchSetup(()=>pending.promise);const {view}=app;
 await view.render();await act(()=>button(view.container,'Crew A').click());await act(()=>button(view.container,'Compute routes').click());
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
  await act(()=>button(view.container,'Crew A').click());await act(async()=>button(view.container,'Compute routes').click());await act(async()=>button(view.container,'Approve and dispatch').click());
  assert.equal(app.planReads(),2);assert.match(view.container.textContent,/saved-plan/);assert.match(view.container.textContent,/Crew B · stop 1/);assert.match(view.container.textContent,/2 min travel · 3 min service · in progress · fixed/);
 }finally{await view.close();}
});
