import { performance } from 'node:perf_hooks';
import { readRegion, summarizeRegion, compareRegions } from './ipc-observation.mjs';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export function refreshConfig(input) {
  const c = { transport: undefined, cdp: 'http://127.0.0.1:9222', inspector: 'http://127.0.0.1:9229', page: undefined, pageUrl: undefined,
    endpoint: undefined, requiredEndpoints: [], channel: undefined, requiredChannels: [], trigger: undefined,
    fault: undefined, times: 1, repeats: 3, baselineTimeoutMs: 15000, observationMs: 15000, idleMs: 1000, settleMs: 800,
    secondTrigger: false, regionSelector: undefined, restoreWindow: false };
  for (const key of Object.keys(c)) if (Object.hasOwn(input, key)) c[key] = input[key];
  if (!['http','ipc'].includes(c.transport)) throw Error('transport must be http or ipc');
  if (!c.trigger || c.trigger.type !== 'dom-event' || c.trigger.target !== 'window' || typeof c.trigger.name !== 'string' || !/^[a-zA-Z][\w:.-]{0,79}$/.test(c.trigger.name) || Object.keys(c.trigger).some(k => !['type','target','name'].includes(k))) throw Error('Use an explicit trigger: {type: dom-event, target: window, name: online}');
  if (typeof c.secondTrigger !== 'boolean' || typeof c.restoreWindow !== 'boolean') throw Error('Boolean options required');
  const faults = c.transport === 'http' ? ['http-error','connection-failure','invalid-json'] : ['rejection','null-result'];
  c.fault ??= faults[0]; if (!faults.includes(c.fault)) throw Error('Unsupported fault for transport');
  const names = c.transport === 'http' ? ['endpoint','requiredEndpoints'] : ['channel','requiredChannels'];
  const valid = value => { if (typeof value !== 'string' || !value.trim()) return false; if (c.transport === 'ipc') return true; try { const u=new URL(value);return ['http:','https:'].includes(u.protocol)&&!u.username&&!u.password&&!u.search&&!u.hash&&u.href===value; } catch {return false;} };
  if (!valid(c[names[0]]) || !Array.isArray(c[names[1]]) || !c[names[1]].every(valid) || new Set([c[names[0]],...c[names[1]]]).size !== 1+c[names[1]].length) throw Error('Provide a distinct target and known read dependencies');
  for (const [key,min,max] of [['times',1,10],['repeats',1,3],['baselineTimeoutMs',500,30000],['observationMs',500,30000],['idleMs',200,10000],['settleMs',100,5000]]) if (!Number.isInteger(c[key]) || c[key]<min || c[key]>max) throw Error(`Invalid ${key}`);
  if (c.regionSelector !== undefined && (typeof c.regionSelector !== 'string' || !c.regionSelector.trim())) throw Error('Invalid regionSelector');
  return c;
}

// Both transports supply begin/snapshot/disarm/stop. No reload occurs between
// the faulted refresh and its spontaneous/optional second-trigger observations.
export async function runRefresh(page, input, adapter, { signal } = {}) {
  const c = refreshConfig(input), target = c.transport === 'http' ? c.endpoint : c.channel;
  const required = c.transport === 'http' ? c.requiredEndpoints : c.requiredChannels;
  const report = { schemaVersion: 1, mode: 'refresh experiment', trigger: { ...c.trigger, synthesized: true, changesNetworkState: false },
    readiness: { strategy: 'bounded-end-state-calibration', calibrationRuns: 3, calibrationWindowMs: c.baselineTimeoutMs, settleMs: c.settleMs, limitation: 'Matching stable end states do not prove completeness beyond the calibration window.' },
    baselines: [], results: [], findings: [], ok: false, finalReset: 'not-verified', faultReset: 'not-verified',
    limitation: 'Synthetic window event only; no network outage, OS resume, token expiry or native transport is simulated. Timing establishes association, not causal proof. Trigger handlers may have application side effects. No recovery beyond the observation window is established.' };
  const initialUrl = page.url(); let errors=0; const onError=()=>errors++; page.on('pageerror',onError);
  const checkAbort=()=>{if(signal?.aborted)throw Error('ABORTED');};
  async function sample() {
    if(page.url()!==initialUrl)throw Error('TARGET_NAVIGATED');
    const ui=summarizeRegion(await page.evaluate(readRegion,c.regionSelector));
    if(!ui.visible||!ui.online)throw Error('ENVIRONMENT_BLOCKED');
    const snapshot=await adapter.snapshot();
    if(snapshot.injectionError)throw Error('INJECTION_ERROR');
    return {ui,snapshot};
  }
  async function observe(ms, predicate, ignoreAbort=false, fullWindow=false) {
    const start=performance.now(), timeline=[];let last, previous, stableSince=start;
    do {
      if(!ignoreAbort)checkAbort();last=await sample();
      const signature=JSON.stringify(last.ui);
      if(signature!==previous){previous=signature;stableSince=performance.now();}
      const elapsedMs=Math.round(performance.now()-start);
      const event={elapsedMs,...last};
      if(timeline.length<100 && (JSON.stringify(timeline.at(-1)?.ui)!==signature || JSON.stringify(timeline.at(-1)?.snapshot)!==JSON.stringify(last.snapshot)))timeline.push(event);
      const stable=performance.now()-stableSince>=c.settleMs;
      if(!fullWindow&&predicate?.(last,stable))return {...last,elapsedMs,timeline,ready:true};
      if(performance.now()-start>=ms)return {...last,elapsedMs,timeline,ready:Boolean(fullWindow&&predicate?.(last,stable))};
      await sleep(50);
    } while(true);
  }
  const settled=s=>Object.values(s.channels).every(r=>r.pending===0);
  const healthy=(value,stable,expected)=>stable&&!value.ui.loading&&!Object.values(value.snapshot.channels).some(r=>r.errors)&&settled(value.snapshot)&&value.snapshot.channels[target].successes>0&&required.every(k=>value.snapshot.channels[k].successes>0)&&(!expected||value.ui.fingerprint===expected);
  async function load(expected, ignoreAbort=false, calibrate=false) {
    const initialErrors=errors;await adapter.begin();
    await page.reload({waitUntil:'domcontentloaded',timeout:c.baselineTimeoutMs});
    const result=await observe(c.baselineTimeoutMs,(v,stable)=>healthy(v,stable,expected),ignoreAbort,calibrate);
    if(errors!==initialErrors)result.ready=false;return result;
  }
  async function quiet() {
    await adapter.begin(); const phase=await observe(c.idleMs);
    if(phase.snapshot.channels[target].calls || !settled(phase.snapshot)) {report.stoppedObservation=phase;throw Error('ATTRIBUTION_AMBIGUOUS: target traffic during idle control');}
    if(baseline && phase.ui.fingerprint!==baseline.ui.fingerprint){report.stoppedObservation=phase;throw Error('CONTROL_UNSTABLE_DURING_IDLE');}
    return phase;
  }
  async function fire() {
    checkAbort();const before=await sample();
    if(before.snapshot.channels[target].calls)throw Error('ATTRIBUTION_AMBIGUOUS: target read before trigger');
    const emitted=await page.evaluate(name=>{const firedAt=Date.now();window.dispatchEvent(new Event(name));return {firedAt,event:name,synthesized:true,online:navigator.onLine,visibility:document.visibilityState};},c.trigger.name);
    return emitted;
  }
  let baseline;
  try {
    for(let i=0;i<3;i++) {
      checkAbort();const b=await load(undefined,false,true);report.baselines.push(b);
      if(!b.ready||errors)throw Error('BASELINE_UNSTABLE');
    }
    if(!report.baselines.every(b=>b.ui.fingerprint===report.baselines[0].ui.fingerprint))throw Error('BASELINE_UNSTABLE');
    baseline=report.baselines[0];
    for(let i=0;i<c.repeats;i++) {
      const row={run:i+1,requested:c.times,observationMs:c.observationMs,attribution:{kind:'temporal-association',causalProof:false},stage:'control'};
      report.results.push(row);const initialErrors=errors;
      row.healthy=await load(baseline.ui.fingerprint);
      if(!row.healthy.ready)throw Error('CONTROL_UNSTABLE');
      row.idle=await quiet();await adapter.begin();row.controlTrigger=await fire();
      row.control=await observe(c.baselineTimeoutMs,(v,stable)=>stable&&!v.ui.loading&&settled(v.snapshot)&&v.snapshot.channels[target].successes>0&&v.ui.fingerprint===baseline.ui.fingerprint);
      if(!row.control.snapshot.channels[target].calls){row.code='TRIGGER_NO_READ';row.kind='inconclusive';break;}
      if(!row.control.ready||Object.values(row.control.snapshot.channels).some(r=>r.errors))throw Error('TRIGGER_CONTROL_UNSTABLE');
      row.controlReads=Object.entries(row.control.snapshot.channels).filter(([,r])=>r.calls).map(([read,r])=>({read,calls:r.calls}));
      row.preFault=await load(baseline.ui.fingerprint);
      if(!row.preFault.ready)throw Error('CONTROL_UNSTABLE');
      row.preFaultIdle=await quiet();
      await adapter.begin({fault:c.fault,times:c.times,ttlMs:c.observationMs+5000});
      row.stage='fault';row.trigger=await fire();
      row.spontaneous=await observe(c.observationMs); // Never issue another trigger in this phase.
      await adapter.disarm();report.faultReset='healthy';
      const s=row.spontaneous.snapshot;row.injected=s.injected;row.observation=compareRegions(row.preFault.ui,row.spontaneous.ui);
      row.subsequentRealReads=s.channels[target].realCalls;
      row.noSubsequentReadObserved=row.subsequentRealReads===0;
      const recovered=s.successfulAfterFault>0&&row.spontaneous.ui.fingerprint===baseline.ui.fingerprint&&!row.spontaneous.ui.loading;
      if(s.injected===0){row.code='TRIGGER_NO_READ';row.kind='inconclusive';}
      else if(s.injected!==c.times){row.code='FAULT_NOT_TRIGGERED';row.kind='inconclusive';}
      else if(Object.values(s.channels).some(r=>r.errors)||errors>initialErrors){row.code='EXPERIMENT_CONFOUNDED';row.kind='inconclusive';}
      else if(recovered){row.code='RECOVERED_AUTOMATICALLY';row.kind='observation';}
      else if(row.observation.contentLoss){row.code='CONTENT_LOSS_ON_REFRESH';row.kind='suspected-defect';}
      else if(row.spontaneous.ui.fingerprint===baseline.ui.fingerprint){row.code='CONTENT_KEPT';row.kind='observation';}
      else {row.code='UI_DIFFERENCE_AT_DEADLINE';row.kind='decision-needed';}
      row.freshReadSucceeded=s.successfulAfterFault>0;
      if(c.secondTrigger&&row.kind!=='inconclusive') {
        if(!settled(s))throw Error('PENDING_READS_BEFORE_SECOND_TRIGGER');
        await adapter.begin();row.stage='second-trigger';row.secondTrigger=await fire();
        row.afterSecondTrigger=await observe(c.observationMs);
        const a=row.afterSecondTrigger;
        row.secondTriggerResult=a.snapshot.channels[target].successes>0&&a.ui.fingerprint===baseline.ui.fingerprint&&!a.ui.loading ? 'RECOVERED_AFTER_TRIGGER' : a.ui.fingerprint===baseline.ui.fingerprint ? 'NO_REFRESH_SUCCESS_OBSERVED' : 'NOT_RECOVERED_WITHIN_WINDOW';
        // This result never changes the spontaneous-phase classification.
      }
      row.stage='completed';
      row.summary=`After the synthetic ${c.trigger.name} event, ${row.injected}/${c.times} faults were consumed; ${row.code}. ${row.noSubsequentReadObserved?'No subsequent target read was observed': 'Subsequent target reads were observed'} within ${c.observationMs} ms.`;
    }
  } catch(error) {report.error=error.message;}
  finally {
    let safe=false;
    try {await adapter.disarm();report.faultReset='healthy';safe=true;}catch(error){report.cleanupError=error.message;}
    if(safe&&baseline)try {report.cleanup=await load(baseline.ui.fingerprint,true);report.finalReset=report.cleanup.ready?'healthy':'not-verified';}catch(error){report.cleanupError=error.message;}
    try {await adapter.stop();}catch(error){report.cleanupError=error.message;report.faultReset='not-verified';}
    page.off('pageerror',onError);
  }
  const completed=report.results.filter(r=>r.stage==='completed');
  const consistent=completed.length===c.repeats&&completed.every(r=>r.code===completed[0].code);
  report.findings=[{id:`${c.trigger.name}-${c.fault}-${c.times}`,classification:consistent?completed[0].code:'INCOMPLETE_EXPERIMENT',kind:consistent?completed[0].kind:'inconclusive',completedRuns:completed.length,plannedRuns:c.repeats,repeatConsistent:consistent,repeatConfirmed:consistent&&c.repeats===3&&completed[0].kind!=='inconclusive'}];
  if(report.results[0]?.code==='TRIGGER_NO_READ'&&!completed.length)report.findings[0].classification='TRIGGER_NO_READ';
  report.ok=!report.error&&!report.cleanupError&&report.finalReset==='healthy'&&report.faultReset==='healthy'&&report.findings.every(f=>f.kind==='observation');
  return report;
}
