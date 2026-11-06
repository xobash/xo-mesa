// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS } from '../lib/settings';
const io=vi.hoisted(()=>({windows:false,resetKeys:vi.fn(async()=>{}),start:vi.fn(),stop:vi.fn(),setSetting:vi.fn(),loadSecrets:vi.fn(async()=>{}),state:{} as Record<string,unknown>}));
vi.mock('../store',()=>{
  const use=(select:(state:Record<string,unknown>)=>unknown)=>select(io.state);
  use.getState=()=>io.state;use.setState=vi.fn();return {useAppStore:use};
});
vi.mock('../lib/vault',()=>({IN_TAURI:true}));
vi.mock('@tauri-apps/api/event',()=>({listen:vi.fn(async()=>()=>{})}));
vi.mock('../lib/syncUi',async original=>({...await original<object>(),syncServerRunning:async()=>false,localSyncAddr:async()=> '192.0.2.1',syncIdentity:async()=> 'f'.repeat(64),startSyncDiscovery:io.start,stopSyncDiscovery:io.stop,get IS_WINDOWS(){return io.windows;}}));
vi.mock('./Modal',()=>({Modal:({children}:{children:React.ReactNode})=><div>{children}</div>}));
vi.mock('./SyncConflictReview',()=>({SyncConflictReview:()=>null}));
import { SyncModal } from './SyncModal';
let host:HTMLDivElement;let root:ReturnType<typeof createRoot>;
// App mounts the lazy SyncModal only while Sync is open; render through the same gate.
async function render() { await act(async()=>{root.render(io.state.syncOpen ? <SyncModal/> : null);}); }
const setSetting=(key:string,value:unknown)=>{io.setSetting(key,value);io.state.settings={...(io.state.settings as object),[key]:value};};
afterEach(async()=>{await act(async()=>root?.unmount());host?.remove();vi.clearAllMocks();vi.useRealTimers();io.windows=false;});
it('opening Sync or receiving never announces until temporary consent; closing revokes it',async()=>{
  io.state={syncOpen:true,syncListening:false,syncBusy:false,syncStatus:'',vaultName:'Synthetic',syncLog:[],syncProgress:null,syncReport:null,files:[],syncPhase:'idle',
    settings:{...DEFAULT_SETTINGS,syncEnabled:true,syncToken:'credential:device'},setSetting,setSyncOpen:vi.fn(),loadSyncSecrets:io.loadSecrets};
  host=document.createElement('div');document.body.append(host);root=createRoot(host);
  await render();expect(io.start).not.toHaveBeenCalled();expect(io.loadSecrets).toHaveBeenCalledTimes(1);
  io.state.syncListening=true;await render();expect(io.start).not.toHaveBeenCalled();
  setSetting('syncDiscovery',true);io.setSetting.mockClear();
  await render();await vi.waitFor(()=>expect(io.start).toHaveBeenCalledTimes(1));
  io.state.syncOpen=false;await render();await vi.waitFor(()=>expect(io.stop).toHaveBeenCalledTimes(1));
  expect(io.setSetting).toHaveBeenCalledWith('syncDiscovery',false);
  expect((io.state.settings as {syncDiscovery:boolean}).syncDiscovery).toBe(false);
  io.state.syncOpen=true;await render();await act(async()=>{await new Promise(r=>setTimeout(r,20));});
  expect(io.start).toHaveBeenCalledTimes(1);
});
it('on Windows, a quiet discovery window shows firewall guidance; other platforms never do',async()=>{
  const firewallNote=()=>[...host.querySelectorAll('[role="note"]')].find(node=>/Windows Firewall/.test(node.textContent??''));
  for(const windows of [true,false]){
    io.windows=windows;vi.useFakeTimers();
    io.state={syncOpen:true,syncListening:false,syncBusy:false,syncStatus:'',vaultName:'Synthetic',syncLog:[],syncProgress:null,syncReport:null,files:[],syncPhase:'idle',
      settings:{...DEFAULT_SETTINGS,syncEnabled:true,syncDiscovery:true,syncToken:'credential:device'},setSetting,setSyncOpen:vi.fn(),loadSyncSecrets:io.loadSecrets};
    host=document.createElement('div');document.body.append(host);root=createRoot(host);
    await render();
    expect(firewallNote()).toBeUndefined();
    await act(async()=>{vi.advanceTimersByTime(6_000);});
    expect(Boolean(firewallNote())).toBe(windows);
    if(windows)expect(firewallNote()?.textContent).toMatch(/Public.*Private/);
    await act(async()=>root.unmount());host.remove();vi.useRealTimers();
  }
});
const baseState=(settings:Record<string,unknown>={})=>({syncOpen:true,syncListening:false,syncBusy:false,syncStatus:'',vaultName:'Synthetic',syncLog:[],syncProgress:null,syncReport:null,files:[],syncPhase:'idle',settingsIssue:'',
  settings:{...DEFAULT_SETTINGS,syncEnabled:true,syncToken:'credential:device',...settings},setSetting,setSyncOpen:vi.fn(),loadSyncSecrets:io.loadSecrets,resetSyncKeys:io.resetKeys});
it('a discovery socket that failed to bind says so instead of blaming the firewall',async()=>{
  io.windows=true;vi.useFakeTimers();io.start.mockRejectedValueOnce('Address already in use (os error 10048)');
  io.state=baseState({syncDiscovery:true});
  host=document.createElement('div');document.body.append(host);root=createRoot(host);
  await render();await act(async()=>{await vi.advanceTimersByTimeAsync(7_000);});
  const notes=[...host.querySelectorAll('[role="note"],[role="alert"]')].map(node=>node.textContent??'');
  expect(notes.some(text=>/could not start on this device: Address already in use/.test(text))).toBe(true);
  expect(notes.some(text=>/Windows Firewall/.test(text))).toBe(false);
});
it('damaged saved keys offer a reset that runs only after typing RESET',async()=>{
  io.state={...baseState(),settingsIssue:'Sync credentials could not be loaded from the OS credential store: Saved sync keys are damaged or incomplete, so Mesa will not use them.'};
  host=document.createElement('div');document.body.append(host);root=createRoot(host);
  await render();
  expect(host.querySelector('[role="alert"]')?.textContent).toMatch(/Every device must\s+then pair again/);
  const button=(label:string)=>[...host.querySelectorAll('button')].find(node=>node.textContent===label) as HTMLButtonElement;
  await act(async()=>{button('Reset sync keys…').click();});
  const confirm=button('Reset sync keys');expect(confirm.disabled).toBe(true);
  const input=host.querySelector('input[aria-label="Type RESET to confirm"]') as HTMLInputElement;
  const type=async(value:string)=>act(async()=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(input,value);input.dispatchEvent(new Event('input',{bubbles:true}));});
  await type('reset');expect(button('Reset sync keys').disabled).toBe(true);
  expect(io.resetKeys).not.toHaveBeenCalled();
  await type('RESET');await act(async()=>{button('Reset sync keys').click();});
  expect(io.resetKeys).toHaveBeenCalledOnce();
  expect(host.querySelector('input[aria-label="Type RESET to confirm"]')).toBeNull();
});
it('healthy keys show no reset',async()=>{
  io.state=baseState();
  host=document.createElement('div');document.body.append(host);root=createRoot(host);
  await render();
  expect([...host.querySelectorAll('button')].some(node=>node.textContent==='Reset sync keys…')).toBe(false);
});
