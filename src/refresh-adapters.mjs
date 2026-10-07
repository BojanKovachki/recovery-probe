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
  return {
    async begin(fault={}) {
      if(id)await resetIpcAndConfirm(control,id);
      id=randomUUID(); // Assign before mutation: a lost reply still requires reset.
      await control.call('begin',{id,channel:config.channel,requiredChannels:config.requiredChannels,...fault});
    },
    async snapshot() {const s=await control.call('snapshot');if(!s||s.id!==id||s.senderId!==senderId)throw Error('IPC_TARGET_OR_RUN_CHANGED');return s;},
    async disarm() {if(id)await resetIpcAndConfirm(control,id);},
    async stop() {if(id)await resetIpcAndConfirm(control,id);},
  };
}
