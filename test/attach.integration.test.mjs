import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { chromium } from 'playwright';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { freePort } from './repair-fixture.mjs';
const exec = promisify(execFile);
test('web attach CLI preserves a sessionStorage login without exporting it', { timeout: 40000 }, async () => {
  const server = createServer((req,res) => {
    res.setHeader('Cache-Control','no-store');
    if(req.url==='/api/read'){res.setHeader('Content-Type','application/json');if(req.headers.authorization!=='fixture-private-session'){res.writeHead(401);res.end('{}');}else res.end('{"name":"Item"}');return;}
    res.setHeader('Content-Type','text/html');res.end(`<!doctype html><main><h1>Items</h1><div id="result"></div></main><script>
    let attempts=0;async function load(){try{if(!sessionStorage.getItem('session')){document.querySelector('#result').textContent='Sign in';return;}const r=await fetch('/api/read',{headers:{Authorization:sessionStorage.getItem('session')}});if(!r.ok)throw Error();const d=await r.json();document.querySelector('#result').innerHTML='<ul><li>'+d.name+'</li></ul>';}catch{if(attempts++===0)setTimeout(load,30);else document.querySelector('#result').innerHTML='<div role="alert">Could not load</div>';}}load();</script>`);
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));const url=`http://127.0.0.1:${server.address().port}`;
  const port=await freePort();const browser=await chromium.launch({args:[`--remote-debugging-port=${port}`,'--remote-debugging-address=127.0.0.1']});
  const page=await browser.newPage();const dir=await mkdtemp(join(tmpdir(),'rp-attach-'));
  try {
    await page.goto(url);await page.evaluate(()=>sessionStorage.setItem('session','fixture-private-session'));await page.reload();await page.locator('li').waitFor();
    const config={cdp:`http://127.0.0.1:${port}`,pageUrl:url,endpoint:url+'/api/read',times:2,faults:['http-error'],repeats:1,settleMs:200,baselineTimeoutMs:5000,recoveryTimeoutMs:1000,readyText:'private-ignore-this'};
    const path=join(dir,'config.json');await writeFile(path,JSON.stringify(config));
    const out=join(dir,'report');
    const result=await exec(process.execPath,[fileURLToPath(new URL('../bin/recovery-probe.mjs',import.meta.url)),'web','--attach','--discover','--config',path,'--out',out],{timeout:20000});
    assert.match(result.stdout,/ERROR_OR_RETRY_SHOWN/);
    const report=JSON.parse(await readFile(join(out,'report.json'),'utf8'));assert.equal(report.ok,true);assert.equal(report.results[0].snapshot.injected,2);
    assert.ok(!JSON.stringify(report).includes('fixture-private-session'));assert.ok(!(await readFile(join(out,'scenario.json'),'utf8')).includes('private-ignore-this'));
    assert.equal(await page.evaluate(()=>sessionStorage.getItem('session')),'fixture-private-session');await page.reload();await page.locator('li').waitFor();
  } finally {await browser.close();await new Promise(r=>server.close(r));await rm(dir,{recursive:true,force:true});}
});
