import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { MessageClient, METHODS, TransportError } from '../lib/messaging/client.ts';
import { endpoint, makeEnvelope, decodeEnvelope, digest, incoming } from '../lib/messaging/protocol.ts';
import { MessagingRuntime } from '../lib/messaging/runtime.ts';

const peer = () => ({surfaceId:randomUUID(),sessionId:randomUUID(),conversationId:randomUUID(),taskId:randomUUID()});
function fixture(){
 const from=peer(),to=peer(),envelope=makeEnvelope(from,to,'request-1','result','A report');
 const native={id:randomUUID(),thread_id:randomUUID(),sender_surface_id:from.surfaceId,recipient_surface_id:to.surfaceId,body:JSON.stringify(envelope),state:'queued',in_reply_to:null};
 return {from,to,envelope,native};
}
function harness(f, responses={}){
 const calls=[]; const exec=async args=>{
  calls.push(args);
  if(args[1]==='capabilities')return {code:0,stdout:JSON.stringify({methods:METHODS})};
  const method=args[args.indexOf('rpc')+1].split('.').at(-1),params=JSON.parse(args.at(-1));
  const result=typeof responses[method]==='function'?await responses[method](params):responses[method];
  if(result instanceof Error)throw result;
  return result?.stdout!==undefined?result:{code:0,stdout:JSON.stringify(result??{})};
 };
 return {client:new MessageClient(f.to.surfaceId,exec),sender:new MessageClient(f.from.surfaceId,exec),calls};
}

test('envelopes strictly validate and logical digests ignore retry timestamps',()=>{
 const f=fixture();assert.deepEqual(decodeEnvelope(JSON.stringify(f.envelope)),f.envelope);
 assert.equal(digest(f.envelope),digest({...f.envelope,at:f.envelope.at+10}));
 assert.notEqual(digest(f.envelope),digest({...f.envelope,text:'Different'}));
 for(const patch of [{version:2},{kind:['result']},{at:1.2},{from:[]},{extra:true},{text:'\u001bBAD'},{id:'bad'},{requestId:'bad\nrequest'}])assert.throws(()=>decodeEnvelope(JSON.stringify({...f.envelope,...patch})));
 assert.throws(()=>endpoint({...f.from,extra:true}));
 assert.throws(()=>makeEnvelope(f.from,f.to,'r','result','😀'.repeat(9000)));
});

test('send confirms explicit UUID sender/recipient/body and never uses titles',async()=>{
 const f=fixture(),h=harness(f,{send:f.native});
 assert.equal((await h.sender.send(f.envelope)).id,f.native.id);
 const params=JSON.parse(h.calls.at(-1).at(-1));assert.equal(params.target,f.to.surfaceId);assert.equal(params.sender_surface_id,f.from.surfaceId);
 assert.equal(h.calls.length,2);
});

test('explicit reply carries correlation and still verifies original recipient',async()=>{
 const f=fixture(),replyTo=randomUUID(),parent={...f.native,id:replyTo,sender_surface_id:f.to.surfaceId,recipient_surface_id:f.from.surfaceId,body:JSON.stringify(makeEnvelope(f.to,f.from,'request-1','question','Question'))};
 const h=harness(f,{list:{messages:[parent]},send:{...f.native,recipient_surface_id:randomUUID()}});
 await assert.rejects(h.sender.send(f.envelope,undefined,replyTo),e=>e.uncertain===true);
 assert.ok(JSON.parse(h.calls.at(-1).at(-1)).reply_to);
 assert.equal(JSON.parse(h.calls.at(-1).at(-1)).thread_id,undefined,'native replies must inherit the original thread');
});

test('foreign reply and forged client sender are rejected before send',async()=>{
 const f=fixture(),h=harness(f,{list:{messages:[]}});
 await assert.rejects(h.sender.send(f.envelope,undefined,randomUUID()),/Reply address/);
 assert.equal(h.calls.some(a=>a.includes('agent.message.send')),false);
 await assert.rejects(h.client.send(f.envelope),/Sender surface/);
 assert.throws(()=>new MessageClient('workspace:1'));
});

test('ambiguous send is surfaced without automatic retry',async()=>{
 const f=fixture(),h=harness(f,{send:new TransportError('deadline',true)});
 await assert.rejects(h.sender.send(f.envelope),e=>e.uncertain===true);
 assert.equal(h.calls.filter(a=>a.includes('agent.message.send')).length,1);
});

for(const bad of [{code:1,stdout:'no'}, {code:0,stdout:'not json'}, {code:0,stdout:'[]'}])test(`bad send response is not a delivery receipt: ${JSON.stringify(bad)}`,async()=>{
 const f=fixture(),h=harness(f,{send:bad});await assert.rejects(h.sender.send(f.envelope));
});

for(const patch of [{},{id:'bad'},{state:'invented'}])test(`malformed post-dispatch native shape preserves unknown evidence: ${JSON.stringify(patch)}`,async()=>{
 const f=fixture(),to={...f.to,taskId:f.from.taskId};
 const h=harness(f,{send:Object.keys(patch).length?{...f.native,...patch}:{}});
 const runtime=new MessagingRuntime({}, {self:()=>f.from,peer:()=>to,client:()=>h.sender,hostVersion:'1.3.0'});
 const result=await runtime.send({mode:'tui'},{target:to.surfaceId,requestId:'shape-regression',kind:'result',text:'Fake native response'});
 const sends=h.calls.filter(a=>a.includes('agent.message.send'));assert.equal(sends.length,1);
 const envelope=JSON.parse(JSON.parse(sends[0].at(-1)).body);
 assert.equal(result.state,'unknown');assert.equal(result.logicalId,envelope.id);assert.match(result.warning,/Do not automatically retry/);
});

test('list filters outgoing messages; ordinary inspection claims nothing',async()=>{
 const f=fixture(),outgoing={...f.native,id:randomUUID(),recipient_surface_id:f.from.surfaceId,sender_surface_id:f.to.surfaceId};
 const h=harness(f,{list:{messages:[outgoing,f.native]}});
 assert.deepEqual(await h.client.list(),[f.native]);assert.equal(h.calls.filter(a=>a.includes('agent.message.claim')).length,0);
 assert.deepEqual(incoming([outgoing],f.to.surfaceId),[]);
 assert.equal(incoming([{...f.native,thread_id:'user-defined-thread'}],f.to.surfaceId)[0].thread_id,'user-defined-thread');
});

test('only send/list/settings are required; unused native lease/poll/read methods are absent',async()=>{
 const f=fixture(),h=harness(f,{list:{messages:[f.native]},settings:{id:f.to.surfaceId,scope:'surface',receiving:true,messages_enabled:true,workspace_receiving:true}});
 assert.deepEqual(METHODS,['agent.message.send','agent.message.list','agent.message.settings']);
 assert.deepEqual(await h.client.list(),[f.native]);assert.equal(await h.client.settings(),true);
 for(const name of ['poll','claim','ack','markRead','pollerKey'])assert.equal(h.client[name],undefined);
 assert.equal(h.calls.filter(a=>a[1]==='capabilities').length,1);
});
for(const field of ['receiving','messages_enabled','workspace_receiving'])test(`native receiving respects ${field}`,async()=>{
 const f=fixture(),settings={id:f.to.surfaceId,scope:'surface',receiving:true,messages_enabled:true,workspace_receiving:true,[field]:false},h=harness(f,{settings});
 assert.equal(await h.client.settings(),false);
});
for(const missing of METHODS)test(`missing required capability ${missing} prevents dispatch`,async()=>{
 const f=fixture(),calls=[],client=new MessageClient(f.from.surfaceId,async args=>{calls.push(args);return {code:0,stdout:JSON.stringify({methods:METHODS.filter(m=>m!==missing)})}});
 await assert.rejects(client.send(f.envelope),/unavailable/);assert.equal(calls.length,1);
});

test('unsupported capabilities prevent dispatch and malformed arrays/inboxes are rejected',async()=>{
 const f=fixture(),calls=[]; const client=new MessageClient(f.from.surfaceId,async args=>{calls.push(args);return {code:0,stdout:'{"methods":[]}'}});
 await assert.rejects(client.send(f.envelope),/unavailable/);assert.equal(calls.length,1);
 assert.throws(()=>incoming(Array(1001).fill(f.native),f.to.surfaceId));
 assert.throws(()=>incoming([{...f.native,sender_surface_id:['bad']}],f.to.surfaceId));
});
