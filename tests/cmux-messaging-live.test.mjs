import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { MessageClient } from '../lib/messaging/client.ts';
import { makeEnvelope } from '../lib/messaging/protocol.ts';
import { uuid } from '../lib/orientation/state.ts';

const run=promisify(execFile);
// Explicit opt-in: creates ONE disposable terminal surface, never a Pi agent.
// This verifies send/list/settings and unchanged native state, not Pi model wakeup.
test('native messaging: isolated terminal journal send/list without consumption',{
 skip:process.env.PI_CMUX_MESSAGES_LIVE!=='1'&&'Set PI_CMUX_MESSAGES_LIVE=1 only for an explicitly authorized native fixture run',timeout:45000
},async t=>{
 const call=async args=>{const r=await run('cmux',args,{timeout:5000,maxBuffer:2*1024*1024});return JSON.parse(r.stdout)};
 const identified=await call(['--json','--id-format','both','identify']);const caller=identified.caller;
 assert.ok(uuid(caller?.window_id)&&uuid(caller?.workspace_id));assert.equal(uuid(caller.surface_id),uuid(process.env.CMUX_SURFACE_ID));
 const created=await call(['--json','--id-format','both','new-surface','--type','terminal','--workspace',caller.workspace_id,'--focus','false']);
 const surface=uuid(created.surface_id);assert.ok(surface);assert.notEqual(surface,uuid(caller.surface_id));
 t.after(()=>run('cmux',['close-surface','--surface',surface],{timeout:5000}));
 const client=new MessageClient(surface);assert.deepEqual(await client.list(),[]);assert.equal(await client.settings(),true);
 const owner={surfaceId:surface,sessionId:randomUUID(),conversationId:randomUUID(),taskId:randomUUID()};
 const envelope=makeEnvelope(owner,owner,`native-fixture:${randomUUID()}`,'result','Isolated native journal probe; not a Pi instruction.');
 const sent=await client.send(envelope);assert.equal(sent.state,'queued');
 const before=await client.list(),after=await client.list();assert.deepEqual(after,before);
 assert.deepEqual(after.map(m=>m.id),[sent.id]);assert.equal(after[0].state,'queued');assert.equal(after[0].body,JSON.stringify(envelope));
});
