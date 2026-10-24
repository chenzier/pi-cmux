import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { createAssistantMessageEventStream, InMemoryCredentialStore } from '@earendil-works/pi-ai';
import { createAgentSessionRuntime, createAgentSessionServices, createAgentSessionFromServices, ModelRuntime, SessionManager, SettingsManager } from '@earendil-works/pi-coding-agent';
import registerMessaging from '../../extensions/cmux-messages.ts';
import { makeEnvelope } from '../../lib/messaging/protocol.ts';

export async function until(predicate,timeoutMs=3000){
 const deadline=Date.now()+timeoutMs;
 while(!predicate()){if(Date.now()>deadline)throw Error('SDK fixture deadline');await sleep(5)}
}

// Real SDK/extension/session persistence. All transport, UI and model I/O is local fake data.
export async function messagingSDK(t,{sessionFile,identity,peer:originalPeer,beforeMessaging=()=>{},afterMessaging=()=>{},userPrompt=false}={}){
 const root=mkdtempSync(join(tmpdir(),'pi-cmux-sdk-message-'));
 const sm=sessionFile?SessionManager.open(sessionFile):SessionManager.create(root,root);
 if(!sessionFile)sm.appendMessage({role:'user',content:'Authorized local fixture task',timestamp:1});
 const owner=identity??{surfaceId:randomUUID(),sessionId:sm.getSessionId(),conversationId:randomUUID(),taskId:randomUUID()};
 const peer=originalPeer??{...owner,surfaceId:randomUUID(),sessionId:randomUUID(),conversationId:randomUUID()};
 const queue=[],reads=[],acks=[],contexts=[],uiEvents=[],dialogs=[],terminalListeners=new Set();
 let runtime,ctx,modelCalls=0,abortedStarts=0,holdNext=false,release,receiving=true,claims=0,modal,draft='Unsubmitted SDK fixture draft',editorWrites=0,retired=false,session;
 // Forbidden-operation sentinels verify the receiver never consumes native input.
 const client={ready:async()=>{},list:async()=>[...queue],settings:async()=>receiving,
  claim:async()=>{claims++;assert.fail('native claim is forbidden')},
  ack:async(_lease,ids)=>{acks.push(...ids);assert.fail('native ACK is forbidden')},
  markRead:async ids=>{reads.push(...ids);assert.fail('native mark-read is forbidden')}};
 const settings=SettingsManager.inMemory({compaction:{enabled:false},retry:{enabled:false},cacheWarming:{enabled:false}});
 const retire=()=>{if(retired)return;retired=true;runtime?.detach();session?.dispose()};
 t.after(()=>{retire();rmSync(root,{recursive:true,force:true})});
 const models=await ModelRuntime.create({credentials:new InMemoryCredentialStore(),modelsPath:null,modelsStorePath:join(root,'models-cache.json'),allowModelNetwork:false,refreshOnCreate:false});
 const model=models.getModels()[0];assert.ok(model);
 if(userPrompt)await models.setRuntimeApiKey(model.provider,'isolated-fixture-not-a-real-key');
 const ui={setStatus:()=>{},notify:()=>{},select:async(title,options)=>new Promise(resolve=>{dialogs.push({title,options});modal=resolve}),
  getEditorText:()=>draft,setEditorText:text=>{editorWrites++;draft=text},
  onTerminalInput:handler=>{terminalListeners.add(handler);return()=>terminalListeners.delete(handler)}};
 const createRuntime=async({cwd,sessionManager,sessionStartEvent})=>{
  const services=await createAgentSessionServices({cwd,agentDir:root,settingsManager:settings,modelRuntime:models,resourceLoaderOptions:{
   noExtensions:true,noSkills:true,noPromptTemplates:true,noThemes:true,noContextFiles:true,extensionFactories:[pi=>{
    beforeMessaging(pi);
    runtime=registerMessaging(pi,{self:c=>({...owner,sessionId:c.sessionManager.getSessionId()}),peer:id=>id===peer.surfaceId?peer:undefined,client:()=>client});
    afterMessaging(pi);
    pi.on('session_start',(_e,context)=>{ctx=context});
    for(const type of ['ui_prompt_start','ui_prompt_end'])pi.on(type,e=>{uiEvents.push(e.type)});
   }],
  }});
  const result=await createAgentSessionFromServices({services,sessionManager,sessionStartEvent,model,tools:[],thinkingLevel:'off'});
  session=result.session;
  session.agent.streamFunction=(_model,context,options)=>{
   const reply={role:'assistant',content:[{type:'text',text:'Fixture reply'}],provider:model.provider,api:model.api,model:model.id,usage:{input:1,output:1,cacheRead:0,cacheWrite:0,totalTokens:2,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},stopReason:'stop',timestamp:Date.now()};
   const stream=createAssistantMessageEventStream();let ended=false;
   const finish=(aborted=false)=>{
    if(ended)return;ended=true;options?.signal?.removeEventListener('abort',onAbort);
    const message=aborted?{...reply,stopReason:'aborted'}:reply;
    stream.push(aborted?{type:'error',reason:'aborted',error:message}:{type:'done',reason:'stop',message});stream.end(message);
   };
   const onAbort=()=>finish(true);
   // SDK may call a provider with an already-aborted signal; never model real I/O then.
   if(options?.signal?.aborted){abortedStarts++;finish(true);return stream}
   modelCalls++;contexts.push(context);
   options?.signal?.addEventListener('abort',onAbort,{once:true});
   if(holdNext){holdNext=false;release=()=>finish()}else queueMicrotask(()=>finish());
   return stream;
  };
  return {...result,services,diagnostics:services.diagnostics};
 };
 const host=await createAgentSessionRuntime(createRuntime,{cwd:root,agentDir:root,sessionManager:sm});
 const bindings={mode:'tui',uiContext:ui,commandContextActions:{
  waitForIdle:()=>host.session.waitForIdle(),newSession:o=>host.newSession(o),fork:(id,o)=>host.fork(id,o),
  navigateTree:(id,o)=>host.session.navigateTree(id,o),switchSession:(path,o)=>host.switchSession(path,o),reload:()=>host.session.reload(),
 }};
 host.setRebindSession(s=>s.bindExtensions(bindings));
 await session.bindExtensions(bindings);
 const add=(kind='result',text='SDK receiver proof',envelope)=>{
  const e=envelope??makeEnvelope(peer,owner,'sdk-fixture',kind,text);
  const native={id:randomUUID(),thread_id:randomUUID(),sender_surface_id:peer.surfaceId,recipient_surface_id:owner.surfaceId,body:JSON.stringify(e),state:'queued',in_reply_to:null};
  queue.push(native);return {envelope:e,native};
 };
 return {root,sm,owner,peer,host,models,client,queue,reads,acks,contexts,uiEvents,dialogs,add,retire,
  get session(){return host.session},get runtime(){return runtime},get ctx(){return ctx},get modelCalls(){return modelCalls},get abortedStarts(){return abortedStarts},get claims(){return claims},
  get draft(){return draft},get editorWrites(){return editorWrites},get modal(){return modal},
  get release(){return release},holdNext(){release=undefined;holdNext=true},receiving:enabled=>receiving=enabled,
  raw:data=>{for(const handler of terminalListeners)assert.equal(handler(data),undefined,'observer cannot consume or replace terminal input')},
  get terminalListeners(){return terminalListeners.size},
  enable:()=>runtime.enable(ctx),tick:()=>runtime.worker?.tick(),
 };
}
