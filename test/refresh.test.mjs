import { test } from 'node:test';
import assert from 'node:assert/strict';
import { refreshConfig } from '../src/refresh.mjs';
import { ipcRefreshAdapter } from '../src/refresh-adapters.mjs';
test('refresh configuration requires explicit event and compatible read/fault scope',()=>{
 const c={transport:'ipc',channel:'read',trigger:{type:'dom-event',target:'window',name:'online'}};
 assert.equal(refreshConfig(c).fault,'rejection');assert.throws(()=>refreshConfig({...c,trigger:{type:'call',global:'danger'}}));assert.throws(()=>refreshConfig({...c,fault:'http-error'}));assert.throws(()=>refreshConfig({...c,times:0}));assert.throws(()=>refreshConfig({...c,observationMs:60000}));assert.throws(()=>refreshConfig({...c,trigger:{...c.trigger,code:'arbitrary()'}}));
});
test('refresh IPC resets a possibly armed begin even when its reply is lost',async()=>{
 let state,resetId;const control={async call(method,args){if(method==='begin'){state={id:args.id,armed:{remaining:1}};throw Error('reply lost');}if(method==='reset'){resetId=args;state.armed=null;return state;}if(method==='snapshot')return state;}};
 const adapter=ipcRefreshAdapter(control,{channel:'read',requiredChannels:[]},1);
 await assert.rejects(adapter.begin({fault:'rejection'}),/reply lost/);await adapter.disarm();assert.equal(resetId,state.id);assert.equal(state.armed,null);
});
