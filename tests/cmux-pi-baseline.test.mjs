import assert from "node:assert/strict";
import { mkdtempSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { AgentSession, SessionManager } from "@earendil-works/pi-coding-agent";

test("Pi1.3 persists the initial user prompt and subsequent custom entries before an assistant reply", t => {
 const dir = mkdtempSync(join(tmpdir(), "pi-cmux-modern-")); t.after(() => rmSync(dir, {recursive:true,force:true}));
 const sm = SessionManager.create(dir, dir);
 sm.appendCustomEntry("setup", {}); assert.equal(existsSync(sm.getSessionFile()), false);
 sm.appendMessage({role:"user",content:"Initial prompt",timestamp:1});
 sm.appendCustomMessageEntry("received", "Peer note", true, {id:"receipt"});
 const rows = readFileSync(sm.getSessionFile(),"utf8").trim().split("\n").map(JSON.parse);
 assert.ok(rows.some(e=>e.type==="message"&&e.message.role==="user"));
 assert.ok(rows.some(e=>e.type==="custom_message"&&e.customType==="received"));
 assert.equal(rows.some(e=>e.type==="message"&&e.message.role==="assistant"),false);
});

test("modern settled event explicitly distinguishes an aborted run", async () => {
 for(const aborted of [false,true]){
  const seen=[]; const host={_agentRunAbortRequested:aborted,_deferredSettledActions:[],_extensionRunner:{emit:async e=>seen.push(e)},_emit:()=>{},_resolveIdleWaitIfIdle:()=>{}};
  await AgentSession.prototype._emitAgentSettled.call(host);
  assert.deepEqual(seen,[{type:"agent_settled",aborted}]);
  assert.equal(host._isAgentRunActive,false);
 }
});
