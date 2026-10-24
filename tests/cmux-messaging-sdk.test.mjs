import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { messagingSDK, until } from './helpers/messaging-sdk.mjs';
import { supportsMessaging } from '../lib/messaging/runtime.ts';
import { InteractiveMode } from '../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/interactive-mode.js';
async function queueRestore(f){
 let draft='Existing TUI-code draft',writes=0,aborts=0;
 const view={session:f.session,compactionQueuedMessages:[{text:'Existing compaction queue',mode:'followUp'}],editor:{getText:()=>draft,setText:text=>{draft=text;writes++}},updatePendingMessagesDisplay:()=>{},clearAllQueues(){return InteractiveMode.prototype.clearAllQueues.call(this)}};
 await f.session.bindExtensions({abortHandler:()=>{aborts++;InteractiveMode.prototype.restoreQueuedMessagesToEditor.call(view,{abort:true})}});
 return {view,verify(){assert.equal(writes,0);assert.equal(aborts,0);assert.equal(draft,'Existing TUI-code draft');assert.equal(view.compactionQueuedMessages.length,1)}};
}
const contexts=f=>f.session.sessionManager.getEntries().filter(e=>e.type==='custom_message'&&e.customType==='pi-cmux.message.context');
const untouched=f=>{assert.equal(f.claims,0);assert.deepEqual(f.acks,[]);assert.deepEqual(f.reads,[]);assert.equal(contexts(f).length,0);assert.equal(f.editorWrites,0);assert.equal(f.terminalListeners,0)};
const start=async f=>{f.enable();f.add();await f.tick()};
const work=f=>f.session.sendCustomMessage({customType:'fixture.work',content:'User-authorized fixture work',display:true},{triggerTurn:true});
test('messaging requires modern Pi baseline',()=>{
 for(const v of ['0.85.1','1.2.9','1.3.0-alpha.1','bad','1.3'])assert.equal(supportsMessaging(v),false);
 for(const v of ['1.3.0','1.3.0+build.1','1.3.1-beta.1','1.4.0','2.0.0'])assert.equal(supportsMessaging(v),true);
});
test('actual SDK idle arrivals, progress and legacy grants never create context or turns',async t=>{
 const f=await messagingSDK(t);f.sm.appendCustomEntry('pi-cmux.message.grant',{enabled:true});f.sm.appendCustomEntry('pi-cmux.message.receipt',{phase:'wake_requested'});
 await start(f);f.add('progress');await f.tick();assert.equal(f.modelCalls,0);untouched(f);assert.equal(f.queue.length,2);
 assert.equal(f.runtime.authorize,undefined);assert.equal(f.runtime.beforeStart,undefined);assert.equal(f.runtime.input,undefined);
});
test('actual SDK busy and dialog arrivals preserve user runs and synthetic editor',async t=>{
 const f=await messagingSDK(t);f.enable();f.holdNext();const run=work(f);await until(()=>f.release);const signal=f.session.agent.signal;
 f.add();await f.tick();assert.equal(signal.aborted,false);assert.equal(f.modelCalls,1);untouched(f);
 const dialog=f.ctx.ui.select('Synthetic dialog',['Cancel']);await until(()=>f.modal);await f.tick();f.modal('Cancel');await dialog;
 assert.deepEqual(f.uiEvents,['ui_prompt_start','ui_prompt_end']);assert.equal(f.draft,'Unsubmitted SDK fixture draft');f.release();await run;await f.tick();assert.equal(f.modelCalls,1);untouched(f);
});
for(const boundary of ['input','authentication'])test(`arrivals during asynchronous ${boundary} cause zero extra SDK requests`,async t=>{
 let entered=false,release;const gate=new Promise(r=>release=r);t.after(()=>release());
 const f=await messagingSDK(t,{userPrompt:true,beforeMessaging:pi=>{if(boundary==='input')pi.on('input',async()=>{entered=true;await gate;return{action:'continue'}})}});
 if(boundary==='authentication'){f.models.hasConfiguredAuth=()=>false;f.models.checkAuth=async()=>{entered=true;await gate;return{}}}
 f.enable();const prompt=f.session.prompt('Ordinary user prompt');await until(()=>entered);f.add();await f.tick();assert.equal(f.modelCalls,0);untouched(f);release();await prompt;await f.tick();assert.equal(f.modelCalls,1);untouched(f);
});
for(const source of ['session','core'])for(const behavior of ['steer','followUp'])for(const phase of ['pending','consumed'])test(`${source} ${phase} ${behavior} user queue survives peer arrivals and later API input`,async t=>{
 const f=await messagingSDK(t,{userPrompt:true}),ui=await queueRestore(f);f.enable();f.holdNext();const run=work(f);await until(()=>f.release);
 if(source==='session')await f.session.prompt('Accepted queued user work',{streamingBehavior:behavior});
 else f.session.agent[behavior]({role:'user',content:[{type:'text',text:'Accepted queued user work'}],timestamp:Date.now()});
 if(phase==='consumed'){const release=f.release;f.holdNext();release();await until(()=>f.modelCalls===2&&f.release)}
 const pending=f.session.pendingMessageCount,signal=f.session.agent.signal;
 f.add();await f.tick();await assert.rejects(f.session.prompt('Later unqueued API input'),/already processing|streamingBehavior/i);
 assert.equal(signal.aborted,false);assert.equal(f.session.pendingMessageCount,pending);untouched(f);ui.verify();
 f.release();await run;await f.session.waitForIdle();assert.equal(f.modelCalls,2);assert.match(JSON.stringify(f.contexts.at(-1).messages),/Accepted queued user work/);untouched(f);ui.verify();
});
for(const behavior of ['steer','followUp'])test(`stale legacy custom startup does not cancel accepted ${behavior} queue`,async t=>{
 let entered=false,release;const gate=new Promise(r=>release=r);t.after(()=>release());
 const f=await messagingSDK(t,{userPrompt:true,beforeMessaging:pi=>pi.on('before_agent_start',async()=>{entered=true;await gate})}),ui=await queueRestore(f);f.enable();
 // Explicit host start of old custom content, not an arrival; messaging must not react.
 const run=f.session.sendCustomMessage({customType:'pi-cmux.message.wake',content:'Historical wake content',display:true,details:{nonce:'stale'}},{triggerTurn:true});await until(()=>entered);
 await f.session.prompt('Accepted startup user work',{streamingBehavior:behavior});f.add();await f.tick();release();await run;await f.session.waitForIdle();
 assert.equal(f.abortedStarts,0);assert.match(JSON.stringify(f.contexts.at(-1).messages),/Accepted startup user work/);untouched(f);ui.verify();
});
test('arrivals during SDK settlement cannot request abort or continuation',async t=>{
 let entered=false,release,once=true;const gate=new Promise(r=>release=r);t.after(()=>release());
 const f=await messagingSDK(t,{afterMessaging:pi=>pi.on('agent_settled',async()=>{if(once){once=false;entered=true;await gate}})});f.enable();const run=work(f);await until(()=>entered);f.add();await f.tick();assert.equal(f.modelCalls,1);untouched(f);release();await run;await f.tick();assert.equal(f.modelCalls,1);
});
for(const transition of ['new','fork','tree','switch','reload'])test(`actual SDK ${transition} disables observation without legacy replay`,async t=>{
 const f=await messagingSDK(t),leaf=f.sm.getLeafId();await start(f);
 if(transition==='new')await f.host.newSession();
 if(transition==='fork')await f.host.fork(f.sm.getEntries().find(e=>e.type==='message'&&e.message.role==='user').id);
 if(transition==='tree'){f.sm.appendCustomEntry('fixture.branch',{});await f.session.navigateTree(leaf,{summarize:false})}
 if(transition==='switch'){const target=SessionManager.create(f.root,f.root);target.appendMessage({role:'user',content:'Other fixture',timestamp:2});await f.host.switchSession(target.getSessionFile())}
 if(transition==='reload')await f.session.reload();
 assert.equal(f.runtime.snapshot().enabled,false);await f.tick();assert.equal(f.modelCalls,0);untouched(f);
});
test('retired import command cannot open dialogs, inject context or start a model',async t=>{
 const f=await messagingSDK(t);f.add();await f.session.prompt('/cmmsg import');
 assert.equal(f.dialogs.length,0);assert.equal(f.modelCalls,0);assert.equal(f.runtime.selectImport,undefined);untouched(f);
});
test('actual TUI queue restoration fixture is live, not a no-op assertion',async t=>{
 const f=await messagingSDK(t),ui=await queueRestore(f);assert.equal(InteractiveMode.prototype.restoreQueuedMessagesToEditor.call(ui.view),1);assert.equal(ui.view.editor.getText(),'Existing compaction queue\n\nExisting TUI-code draft');
});
test('automatic source uses only follow-up delivery, never preemption/editor/native consume integration',()=>{
 const runtime=readFileSync(new URL('../lib/messaging/runtime.ts',import.meta.url),'utf8'),extension=readFileSync(new URL('../extensions/cmux-messages.ts',import.meta.url),'utf8'),worker=readFileSync(new URL('../lib/messaging/worker.ts',import.meta.url),'utf8');
 for(const source of [runtime,extension,worker])assert.doesNotMatch(source,/ctx\.abort|\.claim\(|\.ack\(|\.markRead\(|onTerminalInput|setEditorText|waitForIdle|runtime\.authorize|deliverAs:\s*["']steer["']/);
 for(const hook of ['input','before_agent_start'])assert.ok(!extension.includes(`pi.on("${hook}"`));
 assert.match(runtime,/triggerTurn: true, deliverAs: "followUp"/);
 assert.doesNotMatch(worker,/\bspawn\b|watchEvents|stopWatch/);
});
