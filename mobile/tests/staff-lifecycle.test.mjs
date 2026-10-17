import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import {act,load,mount,deferred} from './helpers/render.mjs';
import {authSdk} from './helpers/auth-sdk.mjs';

test('staff credentials come from the real SDK, expire on logout and reject resident sessions',async()=>{
 const app=authSdk();let session;
 try{
  app.backend(()=>Response.json({user_id:'crew',role:'crew',crew_id:'crew-id'}));
  session=app.reload();const login=session.signIn('crew@example.test','password');(await app.waitForRequest()).resolve(app.response('crew@example.test'));await login;
  const credentials=await session.staffCredentials();assert.equal(credentials.identity.crewId,'crew-id');assert.equal(credentials.isCurrent(),true);assert.ok(credentials.token);
  const logout=session.signOut();assert.equal(credentials.isCurrent(),false);await logout;await assert.rejects(session.staffCredentials(),/verified staff/);
  app.backend(()=>new Response(null,{status:403}));const resident=session.signIn('resident@example.test','password');(await app.waitForRequest(2)).resolve(app.response('resident@example.test'));await resident;await assert.rejects(session.staffCredentials(),/verified staff/);
 }finally{await app.close();}
});
test('staff polling ignores late accounts, prevents overlapping reads and pauses while backgrounded',async()=>{
 let owner={userId:'A'},onState,result;const state={currentState:'active',addEventListener:(_event,fn)=>{onState=fn;return{remove(){onState=undefined}}}};
 const requests=[];
 const {useStaffData}=load('hooks/use-staff-data.ts',{
  'react-native':{AppState:state},'expo-router':{useFocusEffect:callback=>React.useEffect(callback,[callback])},
  '@/auth/session':{getSession:()=>owner,useSession:()=>owner},
 });
 const read=()=>{const request=deferred();requests.push(request);return request.promise;};
 function Probe(){result=useStaffData(read);return null;}
 const view=mount(Probe,{});
 try{
  await view.render();assert.equal(requests.length,1);await act(async()=>result.refresh());assert.equal(requests.length,1);
  owner={userId:'B'};await view.render();assert.equal(requests.length,2);
  await act(async()=>requests[0].resolve('A private'));assert.equal(result.data,null);
  await act(async()=>requests[1].resolve('B private'));assert.equal(result.data,'B private');
  state.currentState='background';await act(async()=>result.refresh());assert.equal(requests.length,2);
  state.currentState='active';await act(()=>onState('active'));assert.equal(requests.length,3);await act(async()=>requests[2].resolve('B new'));assert.equal(result.data,'B new');
 }finally{await view.close();}
});
test('crew GPS uses observed timestamps, prevents overlaps and never publishes after backgrounding or blur',async()=>{
 const owner={userId:'A',role:'crew',crewId:'crew'};let onState,result;const observations=[],posts=[];
 const state={currentState:'active',addEventListener:(_event,fn)=>{onState=fn;return{remove(){onState=undefined}}}};
 const {useCrewLocation}=load('hooks/use-crew-location.ts',{
  'react-native':{AppState:state},'expo-router':{useFocusEffect:callback=>React.useEffect(callback,[callback])},
  'expo-location':{Accuracy:{High:4},requestForegroundPermissionsAsync:async()=>({status:'granted'}),getCurrentPositionAsync:()=>{const pending=deferred();observations.push(pending);return pending.promise;}},
  '@/auth/session':{getSession:()=>owner,useSession:()=>owner},'@/services/staff':{staffApi:{location:async(...args)=>{posts.push(args);}}},
 });
 function Probe(){result=useCrewLocation();return null;}
 const view=mount(Probe,{});const observed={timestamp:1700000000000,coords:{latitude:24,longitude:67}};
 try{
  await view.render();assert.equal(observations.length,1);await act(async()=>result.refresh());assert.equal(observations.length,1);
  state.currentState='background';await act(async()=>observations[0].resolve(observed));assert.equal(posts.length,0);
  state.currentState='active';await act(()=>onState('active'));await act(async()=>observations[1].resolve(observed));assert.deepEqual(posts,[[observed.coords,new Date(observed.timestamp).toISOString()]]);
  await act(async()=>{void result.refresh();await Promise.resolve();});assert.equal(observations.length,3);await view.close();await act(async()=>observations[2].resolve(observed));assert.equal(posts.length,1);
 }finally{observations.forEach(pending=>pending.resolve(observed));if(view.container.isConnected)await view.close();}
});
test('denied GPS permissions show a recoverable message without sending location',async()=>{
 const owner={userId:'A',role:'crew'};let result,calls=0;
 const {useCrewLocation}=load('hooks/use-crew-location.ts',{
  'react-native':{AppState:{currentState:'active',addEventListener:()=>({remove(){}})}},'expo-router':{useFocusEffect:callback=>React.useEffect(callback,[callback])},
  'expo-location':{requestForegroundPermissionsAsync:async()=>({status:'denied'})},'@/auth/session':{getSession:()=>owner,useSession:()=>owner},'@/services/staff':{staffApi:{location:async()=>{calls++;}}},
 });
 function Probe(){result=useCrewLocation();return null;}
 const view=mount(Probe,{});try{await view.render();assert.match(result.message,/Allow foreground/);assert.equal(calls,0);}finally{await view.close();}
});

test('a mutation refresh queued behind an old read fetches the new server state',async()=>{
 const owner={userId:'A'};let result;const requests=[];
 const {useStaffData}=load('hooks/use-staff-data.ts',{
  'react-native':{AppState:{currentState:'active',addEventListener:()=>({remove(){}})}},
  'expo-router':{useFocusEffect:callback=>React.useEffect(callback,[callback])},'@/auth/session':{getSession:()=>owner,useSession:()=>owner},
 });
 const read=()=>{const request=deferred();requests.push(request);return request.promise;};
 function Probe(){result=useStaffData(read);return null;}
 const view=mount(Probe,{});
 try{await view.render();await act(async()=>result.refresh());assert.equal(requests.length,1);
  await act(async()=>requests[0].resolve('old snapshot'));assert.equal(requests.length,2);assert.equal(result.loading,true);
  await act(async()=>requests[1].resolve('after mutation'));assert.equal(result.data,'after mutation');assert.equal(result.loading,false);
 }finally{await view.close();}
});
