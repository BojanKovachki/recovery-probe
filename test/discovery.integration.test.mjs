import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import { discoverHttp } from '../src/http-discover.mjs';
import { checkDesktop } from '../src/desktop.mjs';

function fixture(options) {
  return `<!doctype html><meta charset="utf-8"><main><h1>Catalog</h1><div id="loading" role="progressbar">…</div><section id="content"></section></main><script>
  const o=${JSON.stringify(options)}; const content=document.querySelector('#content'); let failures=0;let defaultRole=false;
  const request=()=>o.style==='xhr'?new Promise((resolve,reject)=>{const x=new XMLHttpRequest();x.open('GET','/api/read');x.onload=()=>{try{if(x.status!==200)throw Error();resolve(JSON.parse(x.responseText))}catch(e){reject(e)}};x.onerror=reject;x.send()}):fetch('/api/read').then(r=>{if(!r.ok)throw Error();return r.json()});
  const success=data=>{if(data===null)throw Error();document.querySelector('#loading').remove();
    if(o.family==='legitimate-empty'){content.textContent='Keine Einträge';return;}
    if(o.family==='grid'){content.innerHTML=Array.from({length:13},()=>'<a href="#"><img width="12" height="12" alt="" src="data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22/%3E"></a>').join('');return;}
    if(o.family==='virtualized'){content.style.cssText='height:80px;overflow:auto';const render=()=>{const start=Math.floor(content.scrollTop/20);content.innerHTML='<div style="height:2000px;position:relative"><ul style="position:absolute;top:'+start*20+'px">'+Array.from({length:4},(_,i)=>'<li aria-setsize="100" aria-posinset="'+(start+i+1)+'">Item '+(start+i)+'</li>').join('')+'</ul></div>';};content.onscroll=render;render();return;}
    content.innerHTML='<ul>'+Array.from({length:4},(_,i)=>'<li><span>Item '+i+'</span><span>'+(i===0&&!defaultRole?'manager':'user')+'</span></li>').join('')+'</ul>';
  };
  const failure=()=>{if(failures++<o.retries){setTimeout(load,30*2**(failures-1));return;}
    if(o.family==='distribution'){defaultRole=true;success({});return;}
    document.querySelector('#loading').remove();
    if(o.family==='explicit-error'){content.innerHTML='<div role="alert">'+(o.language==='icon'?'⚠':'Fehler')+'</div><button aria-label="Erneut versuchen">↻</button>';return;}
    if(o.family==='grid')return;
    if(o.family==='translated'||o.family==='legitimate-empty'){content.textContent='Keine Einträge';return;}
    if(o.family==='icon-empty'){content.innerHTML='<span>◇</span>';return;}
    content.textContent='No items';
  };
  function load(){if(o.style==='promise'){request().then(success).catch(failure);return;} (async()=>{try{success(await request())}catch{failure()}})()}
  fetch('/api/telemetry',{method:'POST'});if(o.family==='repeated')request().catch(()=>{});load();
  </script>`;
}
test('structural HTTP fixture matrix: three fetch styles, negative controls and repeated faults', { timeout: 240000 }, async () => {
  let options; let loads=0;
  const server = createServer((req, res) => {
    res.setHeader('Cache-Control','no-store');
    if(req.url==='/api/telemetry'){res.writeHead(204);res.end();return;}
    if(req.url==='/api/read'){res.setHeader('Content-Type','application/json');setTimeout(()=>res.end('{"name":"data"}'),options.delay??10);return;}
    res.setHeader('Content-Type','text/html');loads++;res.end(fixture(options)+(options.unstable&&loads===5?'<aside>changed control</aside>':''));
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const base=`http://127.0.0.1:${server.address().port}`;
  const browser=await chromium.launch();const page=await browser.newPage();
  const metrics=[];
  try {
    for(const style of ['async','promise','xhr']) for(const family of ['grid','translated','icon-empty','explicit-error','legitimate-empty','delayed-content','backoff','distribution','repeated','virtualized']) {
      options={style,family,retries: family==='backoff'?3:family==='delayed-content'?1:0, delay:family==='delayed-content'?250:10,language:style==='xhr'?'icon':'de'};
      await page.goto(base);
      const config={endpoint:base+'/api/read',faults:['http-error'],times:family==='backoff'?3:1,repeats:1,settleMs:200,baselineTimeoutMs:5000,recoveryTimeoutMs:1600};
      const report=await discoverHttp(page,config);
      assert.equal(report.error,undefined,JSON.stringify({family,style,error:report.error,stopped:report.stoppedObservation}));
      assert.equal(report.finalReset,'healthy');
      const finding=report.findings[0]; const expectedBug=['grid','translated','icon-empty','virtualized'].includes(family);
      const detected=finding.kind==='suspected-defect';
      metrics.push({family,style,knownBugs:expectedBug?1:0,detected:expectedBug&&detected?1:0,misses:expectedBug&&!detected?1:0,falsePositives:!expectedBug&&detected?1:0,classification:finding.classification});
      assert.equal(detected,expectedBug,JSON.stringify({family,style,finding}));
      assert.ok(report.coverage.some(c=>c.method==='POST'&&!c.supported));
      if(family==='distribution') assert.ok(report.results[0].observation.distributionChanges.length > 0);
      if(family==='repeated') assert.ok(report.baselines[0].repeatedReads.some(r=>r.code==='REPEATED_READS'));
      if(family==='grid') assert.equal(report.results[0].observation.after.images,0);
    }
    options={style:'async',family:'list',retries:1,unstable:true};loads=0;await page.goto(base);
    const unstable=await discoverHttp(page,{endpoint:base+'/api/read',faults:['http-error'],repeats:1,settleMs:200,recoveryTimeoutMs:1600});
    assert.equal(unstable.error,'CONTROL_UNSTABLE');assert.equal(unstable.failedControl.reasons.fingerprintChanged,true);assert.ok(unstable.failedControl.timeline.length);
    // The explicit verifier must require ALL requested faults, and exclude every
    // injected HTTP-200 malformed body from later-success counts.
    options={style:'async',family:'list',retries:1};await page.goto(base);
    const config={pageUrl:base,endpoint:base+'/api/read',readySelector:'li:first-child',recovery:'automatic',times:2,timeoutMs:800,faults:['invalid-json']};
    const exhausted=await checkDesktop(page,config);
    assert.equal(exhausted.results[0].applied,2);assert.equal(exhausted.results[0].successfulResponsesAfterFault,0);assert.equal(exhausted.results[0].code,'RECOVERY_NOT_OBSERVED');
    const unused=await checkDesktop(page,{...config,times:3});
    assert.equal(unused.results[0].code,'FAULT_NOT_TRIGGERED');assert.equal(unused.results[0].outcome,'inconclusive');
    await mkdir('artifacts',{recursive:true});await writeFile('artifacts/discovery-fixture-metrics.json',JSON.stringify(metrics,null,2));
    console.log('DISCOVERY_MATRIX '+JSON.stringify(metrics));
  } finally {await browser.close();await new Promise(r=>server.close(r));}
});
