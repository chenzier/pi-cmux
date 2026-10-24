import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import registerMessaging from '../extensions/cmux-messages.ts';
import { makeEnvelope } from '../lib/messaging/protocol.ts';
function harness(t){
 const root=mkdtempSync(join(tmpdir(),'pi-cmux-message-runtime-')),sm=SessionManager.create(root,root);sm.appendMessage({role:'user',content:'Explicit task',timestamp:1});
 const owner={surfaceId:randomUUID(),sessionId:sm.getSessionId(),conversationId:randomUUID(),taskId:randomUUID()},peer={...owner,surfaceId:randomUUID(),sessionId:randomUUID(),conversationId:randomUUID()};
 let livePeer=peer,idle=true;
 const events=new Map(),commands=new Map(),tools=new Map(),messages=[],calls=[],statuses=[],notifications=[],queue=[];
 const ctx={mode:'tui',cwd:root,hasUI:true,sessionManager:sm,isIdle:()=>idle,hasPendingMessages:()=>false,abort:()=>assert.fail('messaging abort'),ui:{onTerminalInput:()=>assert.fail('input observer'),getEditorText:()=>assert.fail('editor access'),setStatus:(...a)=>statuses.push(a),notify:(...a)=>notifications.push(a),select:async()=>assert.fail('unexpected dialog')}};
 const client={ready:async()=>calls.push('ready'),claim:async()=>assert.fail('claim'),ack:async()=>assert.fail('ack'),markRead:async()=>assert.fail('mark_read'),list:async()=>{calls.push('list');return [...queue]},send:async()=>({id:randomUUID(),state:'queued'})};
 const pi={on:(name,cb)=>events.set(name,cb),registerCommand:(name,def)=>commands.set(name,def),registerTool:def=>tools.set(def.name,def),appendEntry:(type,data)=>sm.appendCustomEntry(type,data),sendMessage:(msg,opts)=>{messages.push({msg,opts});assert.equal(opts.triggerTurn,false);sm.appendCustomMessageEntry(msg.customType,msg.content,msg.display,msg.details)}};
 const runtime=registerMessaging(pi,{self:c=>c.mode==='tui'?{...owner,sessionId:c.sessionManager.getSessionId()}:undefined,peer:id=>livePeer?.surfaceId===id?livePeer:undefined,client:()=>client});runtime.attach(ctx);
 t.after(()=>{runtime.detach();rmSync(root,{recursive:true,force:true})});
 const add=(kind='result',patch={})=>{const envelope={...makeEnvelope(peer,owner,'req-1',kind,'A peer report'),...patch},native={id:randomUUID(),thread_id:randomUUID(),sender_surface_id:peer.surfaceId,recipient_surface_id:owner.surfaceId,body:JSON.stringify(envelope),state:'queued',in_reply_to:null};queue.push(native);return {envelope,native}};
 return {root,sm,owner,peer,ctx,pi,runtime,events,commands,tools,messages,calls,statuses,notifications,queue,client,add,busy:()=>idle=false,replacePeer:()=>livePeer={...peer,sessionId:randomUUID()},flush:()=>runtime.worker?.tick(),command:args=>commands.get('cmmsg').handler(args,ctx)};
}
test('loading, enabling and preview never claim, import or wake',async t=>{
 const h=harness(t);h.add();assert.equal(h.calls.length,0);h.runtime.enable(h.ctx);await h.flush();assert.equal(h.messages.length,0);assert.deepEqual(h.calls,['list']);await h.command('inbox');assert.equal(h.messages.length,0);assert.equal(h.queue.length,1);
});
test('allow is retired and only read-only inbox/send tools are registered',async t=>{
 const h=harness(t);await h.command(`allow ${h.peer.surfaceId} req-1`);assert.match(h.notifications.at(-1)[0],/Unexpected/);assert.deepEqual([...h.tools.keys()],['cmux_message_send','cmux_message_inbox']);assert.equal(h.runtime.authorize,undefined);
});
test('busy progress and malicious native bodies never become background context/status text',async t=>{
 const h=harness(t);h.busy();const {native}=h.add('progress');native.body='malicious body';h.runtime.enable(h.ctx);await h.flush();assert.equal(h.messages.length,0);assert.ok(h.statuses.some(s=>s[1]?.includes('1 native queued')));assert.ok(h.statuses.every(s=>!s[1]?.includes('malicious body')));
});
test('model inbox inspection is bounded, read-only, and headless is unsupported',async t=>{
 const h=harness(t);for(let i=0;i<17;i++)h.add('result',{text:'x'.repeat(1000)});const result=await h.tools.get('cmux_message_inbox').execute('read',{},undefined,()=>{},h.ctx);assert.equal(result.details.messages.length,16);assert.equal(result.details.more,true);assert.equal(h.messages.length,0);assert.ok(result.details.messages.every(m=>m.body.length<600));h.ctx.mode='rpc';await assert.rejects(h.runtime.inbox(h.ctx),/interactive/);
});
test('send validates current endpoints and unknown outcomes retain stable logical IDs',async t=>{
 const h=harness(t);h.client.send=async()=>{throw Object.assign(Error('timeout'),{uncertain:true})};const id=randomUUID();assert.equal((await h.runtime.send(h.ctx,{target:h.peer.surfaceId,requestId:'req-1',kind:'result',text:'Reply',id})).logicalId,id);assert.equal(h.messages.length,0);
 h.client.ready=async()=>h.replacePeer();await assert.rejects(h.runtime.send(h.ctx,{target:h.peer.surfaceId,requestId:'req-1',kind:'result',text:'Reply'}),/changed before send/);
});
test('retired import opens no UI, writes no context/receipt and consumes nothing',async t=>{
 const h=harness(t);h.add();const entries=h.sm.getEntries().length,before=JSON.stringify(h.queue);
 await h.command('import');assert.match(h.notifications.at(-1)[0],/Usage/);
 assert.equal(h.runtime.selectImport,undefined);assert.equal(h.messages.length,0);assert.equal(h.sm.getEntries().length,entries);assert.equal(JSON.stringify(h.queue),before);
});
test('status/off controls remain read-only and off revokes automatic permissions',async t=>{
 const h=harness(t);h.runtime.enable(h.ctx);await h.flush();await h.command('status');await h.command('off');
 assert.equal(h.runtime.snapshot().enabled,false);assert.equal(h.runtime.snapshot().returnRequests,0);assert.equal(h.messages.length,0);
});
test('late inbox response cannot cross a session/branch replacement',async t=>{
 const h=harness(t);h.add();h.client.list=async()=>{h.runtime.attach(h.ctx);return [...h.queue]};await assert.rejects(h.runtime.inbox(h.ctx),/changed during inbox/);assert.equal(h.messages.length,0);
});
test('headless inbox is rejected without context or UI',async t=>{
 const h=harness(t);h.add();h.ctx.mode='rpc';await assert.rejects(h.runtime.inbox(h.ctx),/interactive/);assert.equal(h.messages.length,0);
});
