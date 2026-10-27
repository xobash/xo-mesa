import { buildSync } from 'esbuild';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { zipSync } from 'fflate';

const count = Number(process.env.MESA_FUZZ_CASES ?? 512);
const seed = Number(process.env.MESA_FUZZ_SEED ?? 1296388930);
if (!Number.isSafeInteger(count) || count < 1 || count > 100000 || !Number.isSafeInteger(seed) || seed < 0 || seed > 0xffffffff) throw new Error('Invalid fuzz bounds.');
const dir = mkdtempSync(join(tmpdir(), 'mesa-document-fuzz-'));
try {
  const bundle = join(dir, 'checks.mjs');
  buildSync({ entryPoints: ['scripts/document-fuzz.entry.ts'], outfile: bundle, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' });
  const runner = join(dir, 'runner.mjs');
  writeFileSync(runner, `import {JSDOM} from ${JSON.stringify(pathToFileURL(resolve('node_modules/jsdom/lib/api.js')).href)};
import {readFileSync,writeFileSync} from 'node:fs';
const dom=new JSDOM('');
for(const name of ['window','document','DOMParser','Node','Element','HTMLElement','HTMLTemplateElement']) globalThis[name]=dom.window[name];
const {checkText,checkBytes}=await import(${JSON.stringify(pathToFileURL(bundle).href)});
const cases=JSON.parse(readFileSync(process.argv[2],'utf8'));
for(const item of cases) {
 writeFileSync(process.argv[3], JSON.stringify(item));
 checkText(item.text); checkBytes(Uint8Array.from(item.bytes));
}
dom.window.close();
`);
  let state = seed >>> 0;
  const random = () => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return state >>> 0; };
  const textSeeds = [
    '<img src=x onerror="window.__TAURI_INTERNALS__.invoke(\'quit_after_save\')">',
    '<svg><foreignObject><math><mtext><table><mglyph><style><!--</style><img onerror=alert(1)>',
    '<base href="https://example.com"><meta http-equiv=refresh content="0;url=https://example.com"><form action=x><input formaction=x></form>',
    '<a href="java&#x0a;script:alert(1)" ping="https://example.com">x</a><iframe srcdoc="<script>alert(1)</script>"></iframe>',
    '<img src="https://example.com/a"><style>@import "https://example.com/a";</style>',
    '{\\rtf1{\\object secret}\\u-1?\\par safe}', '\\rtf1 \\',
    '[x](javascript:alert(1))\n\n<script>alert(1)</script>',
    '[['.repeat(128), 'mailto:'.repeat(128), '<div id=__TAURI_INTERNALS__>benign text</div>',
  ];
  const zip = zipSync({ 'notes/a.md': new TextEncoder().encode('synthetic') });
  const byteSeeds = [zip, Uint8Array.from([1,0,0,0,0xfe,0xff,0xff,0xff]), Uint8Array.from([1,0,0,0,0xff,0xff,0xff,0xff]), Uint8Array.from([1,0,0,0,3,0,0,0,97,98,99])];
  for (let start = 0; start < count; start += 64) {
    const cases=[];
    for(let i=start;i<Math.min(count,start+64);i++) {
      let text=textSeeds[i % textSeeds.length];
      let bytes=Array.from(byteSeeds[i % byteSeeds.length]);
      if(i >= textSeeds.length) {
        const at=random() % (text.length+1); const token=textSeeds[random() % textSeeds.length];
        text = text.slice(0,at) + token + text.slice(at + (random()%4));
        for(let j=0;j<1+random()%8;j++) { const offset=random()%(bytes.length+1); bytes[offset]=random()&255; }
        if(random()%4===0) bytes=bytes.slice(0,random()%(bytes.length+1));
      }
      cases.push({id:i,seed,text,bytes});
    }
    const inputs=join(dir,'inputs.json'), current=join(dir,'current.json');
    writeFileSync(inputs,JSON.stringify(cases));
    const result=spawnSync(process.execPath,['--max-old-space-size=512',runner,inputs,current],{encoding:'utf8',timeout:30000,maxBuffer:1024*1024});
    if(result.status!==0 || result.error) {
      let reproducer='worker failed before input';
      try { reproducer=JSON.parse((await import('node:fs')).readFileSync(current,'utf8')); } catch {}
      console.error(JSON.stringify({seed,reproducer,error:result.error?.message,stderr:result.stderr}));
      process.exitCode=1; break;
    }
  }
  if(!process.exitCode) console.log(JSON.stringify({engine:'deterministic mutation (no coverage feedback)',seed,cases:count,surfaces:['Markdown','saved HTML offline/online','reader','RTF','ZIP metadata','IPC read frames'],crashes:0,workerHeapMiB:512,batchTimeoutSeconds:30}));
} finally { rmSync(dir,{recursive:true,force:true}); }
