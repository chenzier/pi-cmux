import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { appendFileSync,readFileSync } from 'node:fs';
import { test } from 'node:test';
import { messagingSDK,until } from './helpers/messaging-sdk.mjs';
import { makeEnvelope, digest } from '../lib/messaging/protocol.ts';
import { FOLLOWUP_CONTEXT,FOLLOWUP_INTENT,ReceiptLedger } from '../lib/messaging/receipts.ts';
const batches=f=>f.sm.getEntries().filter(e=>e.type==='custom_message'&&e.customType===FOLLOWUP_CONTEXT);
const intents=f=>f.sm.getEntries().filter(e=>e.type==='custom'&&e.customType===FOLLOWUP_INTENT);
function seed(f){return {version:1,taskId:f.peer.taskId,conversationId:f.peer.conversationId,role:'review',topic:'Fixture review',origin:{...f.owner,role:'main',target:{surfaceId:f.owner.surfaceId,windowId:randomUUID(),workspaceId:randomUUID(),paneId:randomUUID()}}}}
async function permit(f){const ticket=await f.runtime.prepareReturn(f.ctx);f.runtime.registerReturn(ticket,f.peer.surfaceId,seed(f));await f.tick();return ticket}
const add=(f,ticket,kind='result',text='Delegated fixture findings',patch={})=>f.add(kind,text,{...makeEnvelope(f.peer,f.owner,ticket.requestId,kind,text),...patch});
const work=f=>f.session.sendCustomMessage({customType:'fixture.work',content:'Original authorized work',display:true},{triggerTurn:true});
const clean=f=>{assert.equal(f.claims,0);assert.deepEqual(f.acks,[]);assert.deepEqual(f.reads,[]);assert.equal(f.editorWrites,0);assert.equal(f.terminalListeners,0)};

test('default periodic polling alone delivers late findings through the actual SDK', {timeout:10000}, async t=>{
 const f=await messagingSDK(t);let lists=0;const list=f.client.list;f.client.list=async()=>{lists++;return list()};
 const ticket=await f.runtime.prepareReturn(f.ctx);f.runtime.registerReturn(ticket,f.peer.surfaceId,seed(f));
 // The initial list captured an empty inbox. No explicit tick, kick, event or user prompt follows.
 add(f,ticket);assert.equal(f.modelCalls,0);
 await until(()=>f.modelCalls===1&&f.session.isIdle,8000);
 assert.ok(lists>=2);assert.equal(batches(f).length,1);assert.equal(intents(f).length,1);assert.equal(f.queue.length,1);clean(f);
});
for(const mode of ['native-sender','native-recipient','failed-native','wrong-task','wrong-request','pending','unknown-pending'])test(`automatic polling rejects ${mode} without context or native consumption`,async t=>{
 const f=await messagingSDK(t),ticket=await permit(f),r=add(f,ticket);
 if(mode==='native-sender')r.native.sender_surface_id=randomUUID();
 if(mode==='native-recipient')r.native.recipient_surface_id=randomUUID();
 if(mode==='failed-native')r.native.state='failed';
 if(mode==='wrong-task')r.native.body=JSON.stringify({...r.envelope,from:{...f.peer,taskId:randomUUID()}});
 if(mode==='wrong-request')r.native.body=JSON.stringify({...r.envelope,requestId:'not-selected'});
 if(mode==='pending')f.ctx.hasPendingMessages=()=>true;
 if(mode==='unknown-pending')f.ctx.hasPendingMessages=()=>undefined;
 await f.tick();assert.equal(f.modelCalls,0);assert.equal(intents(f).length,0);assert.equal(batches(f).length,0);assert.equal(f.queue.length,1);clean(f);
});
test('an exception after SDK enqueue never causes an automatic second attempt',async t=>{
 const f=await messagingSDK(t,{afterMessaging:pi=>{const send=pi.sendMessage;pi.sendMessage=(message,options)=>{send(message,options);if(message.customType===FOLLOWUP_CONTEXT)throw Error('unknown after enqueue')}}});
 const ticket=await permit(f);add(f,ticket);await f.tick();await until(()=>f.modelCalls===1&&f.session.isIdle);await f.tick();
 assert.equal(f.modelCalls,1);assert.equal(intents(f).length,1);assert.equal(batches(f).length,1);assert.equal(f.queue.length,1);clean(f);
});
test('historical manual records suppress automatic reinsertion without restoring permissions',async t=>{
 for(const phase of ['staged','received','wake_requested','turn_finished','replied','rejected']){
  const f=await messagingSDK(t),ticket=await permit(f),r=add(f,ticket);
  f.sm.appendCustomEntry('pi-cmux.message.receipt',{version:1,owner:f.owner,logicalId:r.envelope.id,nativeId:r.native.id,digest:digest(r.envelope),requestId:ticket.requestId,phase,nonce:randomUUID()});
  await f.tick();assert.equal(f.modelCalls,0);assert.equal(intents(f).length,0);assert.equal(f.queue.length,1);clean(f);
 }
});
test('idle delegated findings wake once as visible untrusted follow-up with durable intent, not native receipts',async t=>{
 const f=await messagingSDK(t),ticket=await permit(f),r=add(f,ticket);await f.tick();await until(()=>f.modelCalls===1&&f.session.isIdle);
 assert.equal(batches(f).length,1);assert.equal(intents(f).length,1);assert.equal(batches(f)[0].display,true);assert.match(JSON.stringify(f.contexts[0].messages),/untrusted peer input/);assert.equal(f.queue.length,1);clean(f);
 await f.tick();assert.equal(f.modelCalls,1);assert.equal(new ReceiptLedger(f.owner,f.sm,()=>{}).inspect(r.envelope),'inserted');
 const rows=readFileSync(f.sm.getSessionFile(),'utf8').trim().split('\n').map(JSON.parse);assert.ok(rows.findIndex(e=>e.customType===FOLLOWUP_INTENT)<rows.findIndex(e=>e.customType===FOLLOWUP_CONTEXT));
});
test('busy findings from multiple requests coalesce after existing work finishes, without steering',async t=>{
 const f=await messagingSDK(t),a=await permit(f),b=await permit(f);f.holdNext();const run=work(f);await until(()=>f.release);
 add(f,a,'result','First findings');add(f,b,'question','Second request question');add(f,a,'progress','Quiet progress');await f.tick();
 assert.equal(f.modelCalls,1);assert.equal(intents(f).length,0);assert.equal(f.session.agent.signal.aborted,false);assert.equal(f.session.pendingMessageCount,0);assert.equal(batches(f).length,0);
 f.release();await run;await f.tick();await until(()=>f.modelCalls===2&&f.session.isIdle);
 assert.equal(batches(f).length,1);assert.equal(batches(f)[0].details.receipts.length,2);assert.match(JSON.stringify(f.contexts[1].messages),/First findings/);assert.match(JSON.stringify(f.contexts[1].messages),/Second request question/);assert.doesNotMatch(JSON.stringify(f.contexts[1].messages),/Quiet progress/);clean(f);
});
test('if host starts during durable-intent I/O, delivery joins followUp rather than steering/aborting',async t=>{
 let f,race,once=true;f=await messagingSDK(t,{afterMessaging:pi=>{const append=pi.appendEntry;pi.appendEntry=(type,data)=>{append(type,data);if(type===FOLLOWUP_INTENT&&once){once=false;f.holdNext();race=work(f)}}}});
 const ticket=await permit(f);add(f,ticket);await f.tick();await until(()=>f.release);assert.equal(f.modelCalls,1);assert.equal(batches(f).length,0);assert.equal(f.session.agent.hasQueuedMessages(),true);assert.doesNotMatch(JSON.stringify(f.contexts[0].messages),/Delegated fixture findings/);assert.equal(f.session.agent.signal.aborted,false);
 f.release();await race;await until(()=>f.modelCalls===2&&f.session.isIdle);assert.equal(batches(f).length,1);clean(f);
});
test('progress, unauthorized/stale/control traffic never create automatic requests',async t=>{
 const f=await messagingSDK(t),ticket=await permit(f);add(f,ticket,'progress');add(f,ticket,'control');add(f,ticket,'result','Wrong request',{requestId:'not-authorized'});add(f,ticket,'result','Wrong recipient',{to:{...f.owner,sessionId:randomUUID()}});add(f,ticket,'result','Wrong conversation',{from:{...f.peer,conversationId:randomUUID()}});await f.tick();assert.equal(f.modelCalls,0);assert.equal(intents(f).length,0);clean(f);
});
test('duplicates across native IDs/timestamps never resend; same-ID conflict before intake blocks all copies',async t=>{
 const f=await messagingSDK(t),ticket=await permit(f),r=add(f,ticket);add(f,ticket,'result','unused',{...r.envelope,at:r.envelope.at+1});await f.tick();await until(()=>f.modelCalls===1&&f.session.isIdle);assert.equal(batches(f)[0].details.receipts.length,1);
 add(f,ticket,'result','unused',{...r.envelope,at:r.envelope.at+2});await f.tick();assert.equal(f.modelCalls,1);
 const g=await messagingSDK(t),other=await permit(g),first=add(g,other);add(g,other,'result','Conflict',{id:first.envelope.id});await g.tick();assert.equal(g.modelCalls,0);assert.equal(intents(g).length,0);clean(g);
});
for(const mode of ['abort','off','tree','reload'])test(`${mode} revokes pending return authority and prepared launch tickets`,async t=>{
 const f=await messagingSDK(t),ticket=await permit(f);f.holdNext();const run=work(f);await until(()=>f.release);add(f,ticket);
 if(mode==='abort'){await f.session.abort();await run}else {if(mode==='off')f.runtime.disable();if(mode==='tree')f.runtime.attach(f.ctx);if(mode==='reload')await f.session.reload();f.release();await run}
 await f.tick();assert.equal(f.modelCalls,1);assert.equal(f.runtime.snapshot().returnRequests,0);assert.throws(()=>f.runtime.registerReturn(ticket,f.peer.surfaceId,seed(f)),/stale/);assert.equal(batches(f).length,0);clean(f);
});
test('restart with pending or dispatched intent never restores authority or replays legacy work',async t=>{
 const f=await messagingSDK(t),ticket=await permit(f),r=add(f,ticket);await f.tick();await until(()=>f.modelCalls===1&&f.session.isIdle);const file=f.sm.getSessionFile();f.retire();
 const g=await messagingSDK(t,{sessionFile:file,identity:f.owner,peer:f.peer});g.add('result','unused',r.envelope);g.enable();await g.tick();assert.equal(g.runtime.snapshot().returnRequests,0);assert.equal(g.modelCalls,0);clean(g);
});
test('dialog and observable pending user work retain native findings until a later boundary',async t=>{
 const f=await messagingSDK(t),ticket=await permit(f);const dialog=f.ctx.ui.select('Fixture dialog',['Cancel']);await until(()=>f.modal);add(f,ticket);await f.tick();assert.equal(f.modelCalls,0);f.modal('Cancel');await dialog;
 await f.tick();await until(()=>f.modelCalls===1&&f.session.isIdle);clean(f);
});
for(const fault of ['corrupt','queue-throw','intent-only'])test(`${fault} leaves scheduling unknown without automatic retry or native loss`,async t=>{
 let throws=0;const f=await messagingSDK(t,{afterMessaging:pi=>{const send=pi.sendMessage;pi.sendMessage=(message,options)=>{if(message.customType===FOLLOWUP_CONTEXT){if(fault==='queue-throw'){throws++;throw Error('unknown enqueue')}if(fault==='intent-only')return}send(message,options)}}});
 const ticket=await permit(f);if(fault==='corrupt')appendFileSync(f.sm.getSessionFile(),'broken\n');add(f,ticket);await f.tick();await f.tick();assert.equal(f.modelCalls,0);assert.equal(f.queue.length,1);assert.equal(throws,fault==='queue-throw'?1:0);assert.equal(intents(f).length,1);clean(f);
});
test('automatic intake is bounded by batch bytes/items and per-request message budget',async t=>{
 const f=await messagingSDK(t),ticket=await permit(f);for(let i=0;i<20;i++)add(f,ticket,'result',`Finding ${i}`);await f.tick();await until(()=>f.modelCalls===1&&f.session.isIdle);assert.equal(batches(f)[0].details.receipts.length,16);await f.tick();assert.equal(f.modelCalls,1);assert.equal(f.queue.length,20);
 const g=await messagingSDK(t),other=await permit(g);for(let i=0;i<10;i++)add(g,other,'result',`${i}:`+'x'.repeat(24000));await g.tick();await until(()=>g.modelCalls===1&&g.session.isIdle);assert.ok(batches(g)[0].details.receipts.length<=5);clean(g);
});
for(const behavior of ['steer','followUp'])test(`accepted user ${behavior} queues finish before delegated findings, without cancellation`,async t=>{
 const f=await messagingSDK(t,{userPrompt:true}),ticket=await permit(f);f.holdNext();const run=work(f);await until(()=>f.release);await f.session.prompt('Accepted user continuation',{streamingBehavior:behavior});add(f,ticket);await f.tick();
 assert.equal(intents(f).length,0);const signal=f.session.agent.signal,count=f.session.pendingMessageCount;await assert.rejects(f.session.prompt('Later unqueued API input'),/already processing|streamingBehavior/i);assert.equal(signal.aborted,false);assert.equal(f.session.pendingMessageCount,count);
 f.release();await run;await f.session.waitForIdle();assert.equal(f.modelCalls,2);await f.tick();await until(()=>f.modelCalls===3&&f.session.isIdle);assert.match(JSON.stringify(f.contexts[1].messages),/Accepted user continuation/);assert.equal(batches(f).length,1);clean(f);
});
for(const position of ['before','after'])test(`authorized follow-up respects actual SDK deferred settlement (${position} observer)`,async t=>{
 let entered=false,release,once=true;const gate=new Promise(r=>release=r);t.after(()=>release());const hook=pi=>pi.on('agent_settled',async()=>{if(once){once=false;entered=true;await gate}});
 const f=await messagingSDK(t,{[position==='before'?'beforeMessaging':'afterMessaging']:hook}),ticket=await permit(f);const run=work(f);await until(()=>entered);add(f,ticket);await f.tick();assert.equal(f.modelCalls,1);assert.equal(batches(f).length,0);release();await run;await until(()=>f.modelCalls===2&&f.session.isIdle);assert.equal(batches(f).length,1);clean(f);
});
test('request expiry, native receiving changes and pinned child sessions suppress future delivery',async t=>{
 const f=await messagingSDK(t),ticket=await permit(f);f.receiving(false);add(f,ticket);await f.tick();assert.equal(f.modelCalls,0);f.receiving(true);ticket.expiresAt=Date.now()-1;await f.tick();assert.equal(f.modelCalls,0);assert.equal(f.runtime.snapshot().returnRequests,0);
 const g=await messagingSDK(t),other=await permit(g);add(g,other,'progress');await g.tick();g.peer.sessionId=randomUUID();add(g,other);await g.tick();assert.equal(g.modelCalls,0);clean(g);
});
test('native newest-first entries batch oldest-first and abandoned-branch contexts suppress reinsertion',async t=>{
 const f=await messagingSDK(t),ticket=await permit(f),leaf=f.sm.getLeafId();f.client.list=async()=>[...f.queue].reverse();const a=add(f,ticket,'result','Oldest finding'),b=add(f,ticket,'result','Newest finding');await f.tick();await until(()=>f.modelCalls===1&&f.session.isIdle);assert.deepEqual(batches(f)[0].details.receipts.map(r=>r.logicalId),[a.envelope.id,b.envelope.id]);
 f.sm.branch(leaf);const ledger=new ReceiptLedger(f.owner,f.sm,()=>{});assert.equal(ledger.inspect(a.envelope),'inserted');await assert.rejects(ledger.reserveFollowup([{envelope:a.envelope,message:a.native}]),/not fresh/);clean(f);
});
for(const boundary of ['input','authentication'])test(`best-effort limitation: hidden ${boundary} can lose startup priority, without messaging cancellation`,async t=>{
 let entered=false,release;const gate=new Promise(r=>release=r);t.after(()=>release());const f=await messagingSDK(t,{userPrompt:true,beforeMessaging:pi=>{if(boundary==='input')pi.on('input',async()=>{entered=true;await gate;return{action:'continue'}})}}),ticket=await permit(f);
 if(boundary==='authentication'){f.models.hasConfiguredAuth=()=>false;f.models.checkAuth=async()=>{entered=true;await gate;return{}}}
 const human=f.session.prompt('Human input hidden in preflight').then(()=>({ok:true}),error=>({error:error.message}));await until(()=>entered);f.holdNext();add(f,ticket);await f.tick();await until(()=>f.release);release();const result=await human;assert.ok(result.error,'upstream collision is an observed limitation, not a passing priority guarantee');assert.equal(f.session.agent.signal.aborted,false);f.release();await until(()=>f.session.agent.state.isStreaming===false);assert.equal(f.modelCalls,1);clean(f);
});
test('native disabled or missing persistence rejects return setup before launching anything',async t=>{
 const f=await messagingSDK(t);f.receiving(false);await assert.rejects(f.runtime.prepareReturn(f.ctx),/disabled/);f.receiving(true);await assert.rejects(f.runtime.prepareReturn({...f.ctx,sessionManager:{...f.ctx.sessionManager,getSessionId:()=>f.owner.sessionId,getSessionFile:()=>undefined}}),/persisted session/);assert.equal(f.runtime.snapshot().returnRequests,0);clean(f);
});
