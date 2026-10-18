import { test } from 'node:test';
import assert from 'node:assert/strict';
import { act, button, deferred, load, mount, ui, wrap } from './helpers/render.mjs';

const dispatch={command_id:'saved-command',kind:'dispatch',resource_id:'old-preview',ownerId:'organizer',apiUrl:'https://api.example',rejected:true,recomputeRequired:true};
function setup(command=dispatch,reconcile=async()=>({plan_id:null}),refresh=async()=>{}){
 const reads=[],posts=[],discards=[];let refreshes=0;
 const {PendingActions}=load('components/route/pending-actions.tsx',{
  '@/components/ui':{...ui,Card:wrap},
  '@/services/pending-staff':{
   reconcileDispatchConflict:async value=>{reads.push(value);return reconcile(value);},
   submitStaff:async value=>{posts.push(value);},discardRejectedStaff:async value=>{discards.push(value);},
  },
 });
 const view=mount(PendingActions,{commands:[command],refresh:async()=>{refreshes++;await refresh();}});
 return{view,reads,posts,discards,refreshes:()=>refreshes};
}

test('a conflicting saved dispatch offers read-only refresh rather than recovery or discard',async()=>{
 const app=setup();const {view}=app;
 try{
  await view.render();assert.equal(view.container.textContent.includes('Recover dispatch'),false);assert.equal(view.container.textContent.includes('Discard rejected action'),false);
  assert.match(view.container.textContent,/Another organiser may already have dispatched/);
  await act(async()=>button(view.container,'Refresh routing state').click());
  assert.deepEqual(app.reads,[dispatch]);assert.equal(app.refreshes(),1);assert.deepEqual(app.posts,[]);assert.deepEqual(app.discards,[]);
 }finally{await view.close();}
});

test('a failed conflict read keeps the action flagged and retry only repeats reconciliation',async()=>{
 let attempts=0;const app=setup(dispatch,async()=>{if(!attempts++)throw Error('Read unavailable');return{plan_id:'someone-else-plan'};});const {view}=app;
 try{
  await view.render();await act(async()=>button(view.container,'Refresh routing state').click());assert.match(view.container.textContent,/Read unavailable/);
  assert.equal(button(view.container,'Refresh routing state').disabled,false);assert.equal(view.container.textContent.includes('Recover dispatch'),false);
  await act(async()=>button(view.container,'Refresh routing state').click());
  assert.equal(app.reads.length,2);assert.equal(app.refreshes(),2);assert.equal(app.posts.length,0);assert.equal(app.discards.length,0);
 }finally{await view.close();}
});

test('uncertain dispatches retain recovery and rejected crew actions retain explicit discard',async()=>{
 const uncertain=setup({...dispatch,rejected:undefined,recomputeRequired:undefined});
 try{await uncertain.view.render();await act(async()=>button(uncertain.view.container,'Recover dispatch').click());assert.equal(uncertain.posts.length,1);assert.equal(uncertain.reads.length,0);}
 finally{await uncertain.view.close();}
 const crew=setup({...dispatch,kind:'start',recomputeRequired:undefined});
 try{await crew.view.render();await act(async()=>button(crew.view.container,'Discard rejected action').click());assert.equal(crew.discards.length,1);assert.equal(crew.posts.length,0);assert.equal(crew.reads.length,0);}
 finally{await crew.view.close();}
});

test('pending reconciliation locks duplicate presses and ignores completion after unmount',async()=>{
 const pending=deferred();const app=setup(dispatch,()=>pending.promise);const {view}=app;
 await view.render();await act(()=>button(view.container,'Refresh routing state').click());assert.equal(button(view.container,'Refresh routing state').disabled,true);
 await view.close();await act(async()=>pending.resolve({plan_id:null}));assert.equal(app.refreshes(),0);assert.equal(app.posts.length,0);
});
