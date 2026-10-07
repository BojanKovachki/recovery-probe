import { randomUUID } from 'node:crypto';
import { observeHttp } from './http-observer.mjs';
import { resetIpcAndConfirm } from './ipc-control.mjs';
export function httpRefreshAdapter(page, config) {
  let current;
  return {
    async begin(fault={}) { if(current)await current.stop();current=await observeHttp(page,{endpoint:config.endpoint,requiredEndpoints:config.requiredEndpoints,...fault}); },
    snapshot() { if(!current)throw Error('Observer not started');return current.snapshot(); },
    async disarm() {if(current)await current.disarm();},
    async stop() {if(current)await current.stop();},
  };
}
export function ipcRefreshAdapter(control, config, senderId) {
  let id;
  const disarm=async()=>{
    if(id)return resetIpcAndConfirm(control,id);
    if((await control.call('snapshot'))?.armed)throw Error('IPC_OTHER_PLAN_ARMED: not owned by this experiment');
  };
  return {
    async begin(fault={}) {
      if(id)await resetIpcAndConfirm(control,id);
      const deadline=Date.now()+(config.baselineTimeoutMs??15000);
      // Do not retry a mutating begin after an uncertain reply. Wait using
      // read-only snapshots before issuing that mutation exactly once.
      while(true) {
        const previous=await control.call('snapshot');
        if(previous?.armed)throw Error('IPC_PLAN_ALREADY_ARMED');
        if(!previous?.channels || !Object.values(previous.channels).some(row=>row.pending))break;
        if(Date.now()>=deadline)throw Error('IPC_PREVIOUS_CALLS_PENDING');
        await new Promise(resolve=>setTimeout(resolve,50));
      }
      id=randomUUID(); // Assign before mutation: a lost reply still requires reset.
      await control.call('begin',{id,channel:config.channel,requiredChannels:config.requiredChannels,...fault});
    },
    async snapshot() {const s=await control.call('snapshot');if(!s||s.id!==id||s.senderId!==senderId)throw Error('IPC_TARGET_OR_RUN_CHANGED');return s;},
    disarm,
    stop: disarm,
  };
}
