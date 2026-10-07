// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS } from '../lib/settings';
const io=vi.hoisted(()=>({start:vi.fn(),stop:vi.fn(),setSetting:vi.fn(),state:{} as Record<string,unknown>}));
vi.mock('../store',()=>{
  const use=(select:(state:Record<string,unknown>)=>unknown)=>select(io.state);
  use.getState=()=>io.state;use.setState=vi.fn();return {useAppStore:use};
});
vi.mock('../lib/vault',()=>({IN_TAURI:true}));
vi.mock('@tauri-apps/api/event',()=>({listen:vi.fn(async()=>()=>{})}));
vi.mock('../lib/syncUi',async original=>({...await original<object>(),syncServerRunning:async()=>false,localSyncAddr:async()=> '192.0.2.1',syncIdentity:async()=> 'f'.repeat(64),startSyncDiscovery:io.start,stopSyncDiscovery:io.stop}));
vi.mock('./Modal',()=>({Modal:({children}:{children:React.ReactNode})=><div>{children}</div>}));
vi.mock('./SyncConflictReview',()=>({SyncConflictReview:()=>null}));
import { SyncModal } from './SyncModal';
let host:HTMLDivElement;let root:ReturnType<typeof createRoot>;
async function render() { await act(async()=>{root.render(<SyncModal/>);}); }
afterEach(async()=>{await act(async()=>root?.unmount());host?.remove();vi.clearAllMocks();});
it('opening Sync or receiving never announces until temporary consent; closing revokes it',async()=>{
  io.state={syncOpen:true,syncListening:false,syncBusy:false,syncStatus:'',vaultName:'Synthetic',syncLog:[],syncProgress:null,syncReport:null,files:[],syncPhase:'idle',
    settings:{...DEFAULT_SETTINGS,syncEnabled:true,syncToken:'credential:device'},setSetting:io.setSetting,setSyncOpen:vi.fn()};
  host=document.createElement('div');document.body.append(host);root=createRoot(host);
  await render();expect(io.start).not.toHaveBeenCalled();
  io.state.syncListening=true;await render();expect(io.start).not.toHaveBeenCalled();
  io.state.settings={...DEFAULT_SETTINGS,syncEnabled:true,syncDiscovery:true,syncToken:'credential:device'};
  await render();await vi.waitFor(()=>expect(io.start).toHaveBeenCalledTimes(1));
  io.state.syncOpen=false;await render();await vi.waitFor(()=>expect(io.stop).toHaveBeenCalledTimes(1));
  expect(io.setSetting).toHaveBeenCalledWith('syncDiscovery',false);
});
