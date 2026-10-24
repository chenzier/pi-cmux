import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { execute } from '../lib/messaging/client.ts';

async function fake(t,source,run){
 const dir=mkdtempSync(join(tmpdir(),'pi-cmux-message-cli-')),old=process.env.PATH;
 writeFileSync(join(dir,'cmux'),`#!${process.execPath}\n${source}`,{mode:0o700});process.env.PATH=`${dir}:${old}`;
 try{await run(dir);}finally{process.env.PATH=old;rmSync(dir,{recursive:true,force:true});}
}
test('bounded native executable preserves JSON arguments without a shell',async t=>{
 await fake(t,'process.stdout.write(JSON.stringify({args:process.argv.slice(2)}));',async()=>{
  const args=['--json','rpc','agent.message.send',JSON.stringify({body:"a 'quoted' $(exit 99) ; line\nnext"})];
  const r=await execute(args);assert.equal(r.code,0);assert.deepEqual(JSON.parse(r.stdout).args,args);
 });
});
test('aborted and oversized native processes settle instead of keeping a pipe open',async t=>{
 await fake(t,`require('node:fs').writeFileSync(process.argv[1]+'.pid',String(process.pid));process.stdout.write("x".repeat(3*1024*1024));setInterval(()=>{},1000);`,async dir=>{
  await assert.rejects(execute([]),e=>e.uncertain===true&&/2 MiB/.test(e.message));
  const pid=Number(readFileSync(join(dir,'cmux.pid'),'utf8'));assert.throws(()=>process.kill(pid,0));
 });
 await fake(t,'setInterval(()=>{},1000);',async()=>{
  const controller=new AbortController();const work=execute([],controller.signal);setTimeout(()=>controller.abort(),30);
  await assert.rejects(work,e=>e.uncertain===true);
 });
 const controller=new AbortController();controller.abort();await assert.rejects(execute([],controller.signal),e=>e.uncertain===false);
});
