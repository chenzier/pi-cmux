import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, appendFileSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { ReceiptLedger, RECEIPT_ENTRY, CONTEXT_ENTRY, FOLLOWUP_INTENT, FOLLOWUP_CONTEXT } from '../lib/messaging/receipts.ts';
import { makeEnvelope, digest } from '../lib/messaging/protocol.ts';

const peer=()=>({surfaceId:randomUUID(),sessionId:randomUUID(),conversationId:randomUUID(),taskId:randomUUID()});
function fixture(t,{fresh=false,memory=false}={}){
 const root=mkdtempSync(join(tmpdir(),'pi-cmux-receipts-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const sm=memory?SessionManager.inMemory(root):SessionManager.create(root,root);
 if(!fresh)sm.appendMessage({role:'user',content:'Explicit task',timestamp:1});
 const owner={...peer(),sessionId:sm.getSessionId()},from=peer(),envelope=makeEnvelope(from,owner,'request-1','result','Report');
 const message={id:randomUUID(),recipient_surface_id:owner.surfaceId,sender_surface_id:from.surfaceId,body:JSON.stringify(envelope),state:'queued',thread_id:randomUUID(),in_reply_to:null};
 let active=true;
 const ledger=new ReceiptLedger(owner,sm,(type,data)=>sm.appendCustomEntry(type,data),()=>active);
 const legacy=phase=>({version:1,owner,logicalId:envelope.id,nativeId:message.id,digest:digest(envelope),requestId:envelope.requestId,phase,nonce:randomUUID()});
 return {root,sm,owner,from,envelope,message,ledger,legacy,item:{envelope,message},stop(){active=false}};
}

test('automatic reservation is persisted intent, not context or model processing',async t=>{
 const f=fixture(t);assert.equal(f.ledger.inspect(f.envelope),'new');
 const batch=await f.ledger.reserveFollowup([f.item]);
 assert.equal(batch.receipts[0].phase,'followup_intent');assert.equal(f.ledger.inspect(f.envelope),'reserved');
 const rows=readFileSync(f.sm.getSessionFile(),'utf8').trim().split('\n').map(JSON.parse);
 assert.equal(rows.filter(e=>e.customType===FOLLOWUP_INTENT).length,1);assert.equal(rows.filter(e=>e.type==='custom_message').length,0);
 assert.equal(f.ledger.receive,undefined);assert.equal(f.ledger.note,undefined);
 f.sm.appendCustomMessageEntry(FOLLOWUP_CONTEXT,'Untrusted fixture findings',true,batch);
 assert.equal(f.ledger.inspect(f.envelope),'inserted');
});
test('logical IDs deduplicate across native IDs/timestamps and conflicting content stays blocked',async t=>{
 const f=fixture(t);await f.ledger.reserveFollowup([f.item]);
 const duplicate={envelope:{...f.envelope,at:f.envelope.at+1},message:{...f.message,id:randomUUID()}};
 await assert.rejects(f.ledger.reserveFollowup([duplicate]),/not fresh/);
 assert.equal(f.ledger.inspect({...f.envelope,text:'Conflicting content'}),'conflict');
 await assert.rejects(f.ledger.reserveFollowup([{...f.item,envelope:{...f.envelope,text:'Conflicting content'}}]),/not fresh/);
});
for(const [phase,state] of [['staged','staged'],['received','inserted'],['wake_requested','inserted'],['turn_finished','inserted'],['replied','inserted'],['rejected','rejected']])test(`historical ${phase} records remain conservative replay fences`,async t=>{
 const f=fixture(t);f.sm.appendCustomEntry(RECEIPT_ENTRY,f.legacy(phase));
 assert.equal(f.ledger.inspect(f.envelope),state);
 await assert.rejects(f.ledger.reserveFollowup([f.item]),/not fresh/);
 assert.equal(f.sm.getEntries().some(e=>e.customType===FOLLOWUP_INTENT),false);
});
test('old manual context and automatic batch context survive branch movement/reopen without replay',async t=>{
 for(const kind of ['manual','automatic']){
  const f=fixture(t),leaf=f.sm.getLeafId();
  if(kind==='manual')f.sm.appendCustomMessageEntry(CONTEXT_ENTRY,'Historical manual context',true,f.legacy('received'));
  else {const batch=await f.ledger.reserveFollowup([f.item]);f.sm.appendCustomMessageEntry(FOLLOWUP_CONTEXT,'Automatic context',true,batch)}
  f.sm.branch(leaf);assert.equal(f.ledger.inspect(f.envelope),'inserted');
  const reopened=SessionManager.open(f.sm.getSessionFile()),ledger=new ReceiptLedger(f.owner,reopened,()=>assert.fail('unexpected append'));
  assert.equal(ledger.inspect(f.envelope),'inserted');await assert.rejects(ledger.reserveFollowup([f.item]),/not fresh/);
 }
});
test('copied historical records do not bind another owner and reservation routing stays exact',async t=>{
 const f=fixture(t);f.sm.appendCustomEntry(RECEIPT_ENTRY,f.legacy('received'));
 const owner={...f.owner,sessionId:randomUUID()},foreign=new ReceiptLedger(owner,{getSessionId:()=>owner.sessionId,getSessionFile:()=>f.sm.getSessionFile(),getEntries:()=>f.sm.getEntries()},()=>{});
 assert.equal(foreign.inspect(f.envelope),'new');
 await assert.rejects(foreign.reserveFollowup([f.item]),/routing changed/);
 for(const item of [{...f.item,envelope:{...f.envelope,to:peer()}},{...f.item,message:{...f.message,sender_surface_id:randomUUID()}}])await assert.rejects(f.ledger.reserveFollowup([item]),/not fresh|routing changed/);
});
test('unflushed/memory sessions cannot confirm durable intent',async t=>{
 for(const options of [{fresh:true},{memory:true}]){const f=fixture(t,options);await assert.rejects(f.ledger.reserveFollowup([f.item]))}
});
test('shutdown, corruption and owner mismatch fail without inserting context',async t=>{
 const f=fixture(t);f.stop();await assert.rejects(f.ledger.reserveFollowup([f.item]),/inactive/);
 const g=fixture(t);appendFileSync(g.sm.getSessionFile(),'broken\n');await assert.rejects(g.ledger.reserveFollowup([g.item]));
 const h=fixture(t);writeFileSync(h.sm.getSessionFile(),JSON.stringify({type:'session',id:randomUUID()})+'\n');await assert.rejects(h.ledger.reserveFollowup([h.item]),/owner changed/);
 for(const x of [f,g,h])assert.equal(x.sm.getEntries().some(e=>e.type==='custom_message'),false);
});
test('missing writes, oversize entries and abort cannot masquerade as confirmed intent',async t=>{
 const f=fixture(t),file=f.sm.getSessionFile(),bytes=readFileSync(file);
 const ledger=new ReceiptLedger(f.owner,f.sm,(type,data)=>{f.sm.appendCustomEntry(type,data);writeFileSync(file,bytes)});
 await assert.rejects(ledger.reserveFollowup([f.item]),/not confirmed/);assert.equal(ledger.inspect(f.envelope),'reserved');
 const g=fixture(t);appendFileSync(g.sm.getSessionFile(),JSON.stringify({type:'custom',id:'oversize',data:'x'.repeat(1024*1024)})+'\n');await assert.rejects(g.ledger.reserveFollowup([g.item]),/bound|oversized/);
 const ctrl=new AbortController();ctrl.abort();await assert.rejects(f.ledger.reserveFollowup([f.item],ctrl.signal));
});
