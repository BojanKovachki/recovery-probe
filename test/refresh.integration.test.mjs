import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { chromium } from 'playwright';
import { runRefresh } from '../src/refresh.mjs';
import { httpRefreshAdapter } from '../src/refresh-adapters.mjs';

function fixture(mode) {return `<!doctype html><main><h1>Catalog</h1><ul id="items"></ul><div id="error"></div></main><script>
const mode=${JSON.stringify(mode)};let refreshes=0;const items=document.querySelector('#items');
async function load(refresh=false,attempt=0){try{const r=await fetch('/api/items');if(!r.ok)throw Error();const data=await r.json();items.innerHTML=Array.from({length:mode==='legitimate-change'&&refresh?2:4},(_,i)=>'<li>Item '+i+'</li>').join('');document.querySelector('#error').textContent='';}catch{if(mode==='retry'&&attempt===0){setTimeout(()=>load(refresh,1),80);return;}if(mode!=='keep')items.innerHTML='';else document.querySelector('#error').textContent='';}}
load();window.addEventListener('online',()=>{if(mode==='wrong-target'){fetch('/api/other');return;}load(true);});
if(mode==='background')setInterval(()=>load(),100);
</script>`;}
test('refresh HTTP: populated content, spontaneous versus retriggered recovery, ambiguity and cleanup', {timeout:90000}, async()=>{
 let mode='broken';const server=createServer((req,res)=>{res.setHeader('Cache-Control','no-store');if(req.url.startsWith('/api/')){res.setHeader('Content-Type','application/json');res.end('{}');return;}res.setHeader('Content-Type','text/html');res.end(fixture(mode));});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}`;const browser=await chromium.launch();const page=await browser.newPage();
 const config={transport:'http',endpoint:base+'/api/items',requiredEndpoints:[],trigger:{type:'dom-event',target:'window',name:'online'},fault:'http-error',times:1,repeats:1,baselineTimeoutMs:1600,observationMs:500,idleMs:200,settleMs:100,secondTrigger:true};
 const run=async(overrides={})=>{await page.goto(base);const c={...config,...overrides};return runRefresh(page,c,httpRefreshAdapter(page,c));};
 try {
  let r=await run();assert.equal(r.error,undefined,JSON.stringify(r));assert.equal(r.results[0].code,'CONTENT_LOSS_ON_REFRESH');assert.equal(r.results[0].observation.before.items,4);assert.equal(r.results[0].observation.after.items,0);assert.equal(r.results[0].secondTriggerResult,'RECOVERED_AFTER_TRIGGER');assert.equal(r.finalReset,'healthy');assert.equal(r.results[0].noSubsequentReadObserved,true);
  for(const fault of ['connection-failure','invalid-json']) {r=await run({fault,secondTrigger:false});assert.equal(r.results[0].code,'CONTENT_LOSS_ON_REFRESH');assert.equal(r.results[0].injected,1);assert.equal(r.faultReset,'healthy');}
  r=await run({repeats:3,secondTrigger:false});assert.equal(r.findings[0].repeatConfirmed,true);assert.equal(r.results.length,3);
  mode='retry';r=await run({secondTrigger:false});assert.equal(r.results[0].code,'RECOVERED_AUTOMATICALLY');assert.equal(r.results[0].secondTrigger,undefined);assert.equal(r.results[0].freshReadSucceeded,true);assert.equal(r.ok,true);
  mode='keep';r=await run({secondTrigger:false});assert.equal(r.results[0].code,'CONTENT_KEPT');assert.equal(r.results[0].freshReadSucceeded,false);assert.equal(r.results[0].spontaneous.ui.error,false);
  mode='legitimate-change';r=await run();assert.equal(r.error,'TRIGGER_CONTROL_UNSTABLE');assert.equal(r.results[0].control.snapshot.injected,0);assert.equal(r.finalReset,'healthy');
  mode='background';r=await run();assert.match(r.error,/ATTRIBUTION_AMBIGUOUS/);assert.equal(r.results[0].trigger,undefined);assert.equal(r.faultReset,'healthy');
  mode='wrong-target';r=await run({requiredEndpoints:[base+'/api/other']}); // Baseline dependency isn't read: safely inconclusive.
  assert.equal(r.error,'BASELINE_UNSTABLE');
  r=await run();assert.equal(r.findings[0].classification,'TRIGGER_NO_READ');assert.equal(r.results[0].trigger,undefined);
  mode='broken';r=await run({times:2});assert.equal(r.results[0].injected,1);assert.equal(r.results[0].code,'FAULT_NOT_TRIGGERED');assert.equal(r.results[0].secondTrigger,undefined);assert.equal(r.findings[0].repeatConfirmed,false);assert.equal(r.faultReset,'healthy');
  const abort=new AbortController();await page.goto(base);const adapter=httpRefreshAdapter(page,config);const begin=adapter.begin;adapter.begin=async fault=>{await begin(fault);if(fault?.fault)abort.abort();};r=await runRefresh(page,config,adapter,{signal:abort.signal});assert.equal(r.error,'ABORTED');assert.equal(r.faultReset,'healthy');assert.equal(r.finalReset,'healthy');
 } finally {await browser.close();await new Promise(r=>server.close(r));}
});
