import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { connectDesktop, selectDesktopPage, desktopPages } from '../src/desktop.mjs';
import { connectIpcInspector } from '../src/ipc-inspector.mjs';
import { prepareVisibility } from '../src/visibility.mjs';
import { refreshConfig, runRefresh } from '../src/refresh.mjs';
import { httpRefreshAdapter, ipcRefreshAdapter } from '../src/refresh-adapters.mjs';
const escape=value=>String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export async function refreshMain(args) {
  if(args.includes('--help')){console.log('recovery-probe refresh --config FILE [--out NEW_DIRECTORY] [--json]\nOpt-in synthetic window-event refresh experiments. No network outage or OS resume. See docs/refresh.md.');return;}
  const options={};for(let i=0;i<args.length;i++){if(args[i]==='--json')options.json=true;else if(['--config','--out'].includes(args[i])&&args[i+1]&&!args[i+1].startsWith('--'))options[args[i].slice(2)]=args[++i];else throw Error('Use refresh --config FILE [--out NEW_DIRECTORY] [--json]');}
  if(!options.config)throw Error('--config required');
  const c=refreshConfig(JSON.parse(await readFile(options.config,'utf8')));
  const directory=resolve(options.out??`.recovery-probe/refresh-${Date.now()}`);
  await mkdir(resolve(directory,'..'),{recursive:true,mode:0o700});await mkdir(directory,{mode:0o700});
  await writeFile(resolve(directory,'.gitignore'),'*\n',{mode:0o600});
  const abort=new AbortController();const onSignal=()=>abort.abort();process.on('SIGINT',onSignal);process.on('SIGTERM',onSignal);
  let browser,control,visibility,report;
  try {
    browser=await connectDesktop(c.cdp);let page,adapter;
    if(c.transport==='ipc') {
      control=await connectIpcInspector(c.inspector);const identity=await control.call('identify');
      if(c.times>identity.capabilities?.maxFaultCount)throw Error('IPC hook does not support requested fault count');
      for(const channel of [c.channel,...c.requiredChannels])if(!identity.registered.includes(channel))throw Error('Configured channel was not captured');
      const pages=desktopPages(browser).filter(p=>p.url()===identity.pageUrl);if(pages.length!==1)throw Error('Keep one matching IPC target open');page=pages[0];
      const nonce=randomUUID();await page.evaluate(value=>{if(Object.hasOwn(globalThis,'__recoveryProbeWindowNonce'))throw Error('Existing challenge');Object.defineProperty(globalThis,'__recoveryProbeWindowNonce',{value,configurable:true});},nonce);
      try{await control.call('identify',nonce);}finally{await page.evaluate(()=>delete globalThis.__recoveryProbeWindowNonce);}
      adapter=ipcRefreshAdapter(control,c,identity.senderId);
    } else {page=selectDesktopPage(browser,c);adapter=httpRefreshAdapter(page,c);}
    visibility=await prepareVisibility(page,{...c,control,announce:console.error});
    report=await runRefresh(page,c,adapter,{signal:abort.signal});report.window={initial:visibility.initial};
  } catch(error) {report??={schemaVersion:1,mode:'refresh experiment',ok:false,finalReset:'not-verified',results:[],findings:[]};report.error=error.message;}
  finally {
    try{if(visibility){report.window??={initial:visibility.initial};report.window.restoration=await visibility.revert();}}catch(error){report.ok=false;report.windowRestoreError=error.message;}
    control?.close();try{if(browser)await browser.close();}catch(error){report.ok=false;report.disconnectError=error.message;}
    process.off('SIGINT',onSignal);process.off('SIGTERM',onSignal);
  }
  await writeFile(resolve(directory,'scenario.json'),JSON.stringify(c,null,2),{mode:0o600});
  await writeFile(resolve(directory,'report.json'),JSON.stringify(report,null,2),{mode:0o600});
  await writeFile(resolve(directory,'report.html'),`<!doctype html><meta charset="utf-8"><title>Recovery Probe refresh</title><style>body{font:16px system-ui;max-width:1000px;margin:40px auto;padding:20px}pre{white-space:pre-wrap;overflow-wrap:anywhere}</style><h1>Refresh experiment</h1><p>${escape(report.limitation??report.error)}</p>${report.results.map(r=>`<p>${escape(r.summary??r.code??r.stage)}</p>`).join('')}<details><summary>Evidence</summary><pre>${escape(JSON.stringify(report,null,2))}</pre></details>`,{mode:0o600});
  const summary={ok:report.ok,error:report.error,findings:report.findings,finalReset:report.finalReset,faultReset:report.faultReset,report:resolve(directory,'report.json')};
  if(options.json)console.log(JSON.stringify(summary));else{for(const row of report.results)console.log(row.summary??row.code??row.stage);if(report.error)console.error(report.error);console.log(`Final reload: ${report.finalReset}\nReport: ${directory}/report.html`);}
  process.exitCode=report.ok?0:2;
}
