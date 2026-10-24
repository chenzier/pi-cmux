import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setImmediate as immediate } from 'node:timers/promises';
import { ReceiverWorker } from '../lib/messaging/worker.ts';
function harness(t,overrides={}){
 const timers=new Map(),counts=[],diagnostics=[];let id=0,current=true,messages=[{state:'queued'},{state:'read'}];
 const client={list:async()=>messages,...overrides.client};
 const worker=new ReceiverWorker({client,current:()=>current,queued:n=>counts.push(n),diagnostic:m=>diagnostics.push(m),setTimer:(fn,delay)=>{timers.set(++id,{fn,delay});return id},clearTimer:id=>timers.delete(id),...overrides,client});
 t.after(()=>worker.stop());return {worker,timers,counts,diagnostics,replace:()=>current=false,setMessages:m=>messages=m};
}
const drain=async()=>{for(let i=0;i<3;i++)await immediate()};
test('observer lists only and reports counts without importing or consuming',async t=>{
 const h=harness(t);assert.equal(h.worker.start(),undefined);await drain();assert.deepEqual(h.counts,[1]);assert.equal(h.timers.size,1);
 h.setMessages([]);await h.worker.tick();assert.deepEqual(h.counts,[1,0]);
});
test('lifecycle kicks and overlapping ticks coalesce while list is in flight',async t=>{
 let release,calls=0;const h=harness(t,{client:{list:async()=>{calls++;return new Promise(r=>release=r)}}});h.worker.start();
 const a=h.worker.tick(),b=h.worker.tick();h.worker.kick();assert.equal(a,b);assert.equal(calls,1);release([]);await a;assert.equal(h.timers.size,1);
});
for(const mode of ['stop','replace'])test(`${mode} suppresses late observation`,async t=>{
 let release;const h=harness(t,{client:{list:async()=>new Promise(r=>release=r)}});h.worker.start();if(mode==='stop')h.worker.stop();else h.replace();release([{state:'queued'}]);await drain();assert.deepEqual(h.counts,[]);assert.equal(h.timers.size,0);h.worker.start();assert.equal(h.timers.size,0);
});
test('offline retry backs off and bounds timers',async t=>{
 const h=harness(t,{client:{list:async()=>{throw Error('offline')}}});h.worker.start();await drain();assert.equal([...h.timers.values()][0].delay,2000);await h.worker.tick();assert.equal([...h.timers.values()][0].delay,4000);assert.equal(h.timers.size,1);assert.equal(h.diagnostics.length,2);
});
test('periodic timer reconciles again without an event stream or lifecycle kick',async t=>{
 const observed=[],h=harness(t,{reconcile:async messages=>observed.push([...messages])});h.worker.start();await drain();
 assert.equal(observed.length,1);assert.equal(h.timers.size,1);
 const [id,timer]=[...h.timers][0];assert.equal(timer.delay,2000);
 h.setMessages([{state:'queued',body:'Later arrival'}]);h.timers.delete(id);timer.fn();await drain();
 assert.equal(observed.length,2);assert.equal(observed[1][0].body,'Later arrival');assert.equal(h.timers.size,1);
 h.worker.stop();assert.equal(h.timers.size,0);
});
