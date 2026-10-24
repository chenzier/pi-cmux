import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync,rmSync,existsSync,readFileSync,readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join,resolve,dirname } from 'node:path';
import { test } from 'node:test';
import { loadExtensions } from '../node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js';

test('isolated HOME install includes every local runtime import and loads through actual Pi loader',async t=>{
 const home=mkdtempSync(join(tmpdir(),'pi-cmux-install-'));t.after(()=>rmSync(home,{recursive:true,force:true}));
 const run=args=>execFileSync(process.execPath,[resolve('install.mjs'),...args],{env:{PATH:process.env.PATH,HOME:home},encoding:'utf8'});
 run([]);const dest=join(home,'.pi/agent/packages/pi-cmux'),entry=join(dest,'extensions/index.ts'),visited=new Set();
 assert.ok(existsSync(join(dest,'lib/messaging/runtime.ts')));assert.ok(existsSync(join(dest,'lib/orientation/runtime.ts')));
 function walk(file){if(visited.has(file))return;visited.add(file);assert.ok(existsSync(file),`installed import missing: ${file}`);const source=readFileSync(file,'utf8');for(const match of source.matchAll(/(?:from\s*|import\s*\()\s*["'](\.[^"']+)["']/g)){const dependency=resolve(dirname(file),match[1]);if(/\.(ts|js|mjs)$/.test(dependency))walk(dependency);else assert.ok(existsSync(dependency))}}
 walk(entry);assert.ok(visited.size>=25);
 const result=await loadExtensions([entry],home);assert.deepEqual(result.errors,[]);assert.equal(result.extensions.length,1);assert.ok(result.extensions[0].tools.has('cmux_message_send'));assert.ok(result.extensions[0].commands.has('cmmsg'));
 const settings=()=>JSON.parse(readFileSync(join(home,'.pi/agent/settings.json'),'utf8'));assert.deepEqual(settings().packages,['./packages/pi-cmux']);run([]);assert.deepEqual(settings().packages,['./packages/pi-cmux']);
 for(const name of ['plans','tests','node_modules','.pi'])assert.equal(existsSync(join(dest,name)),false);
 run(['--remove']);assert.equal(existsSync(dest),false);assert.deepEqual(settings().packages,[]);
});
