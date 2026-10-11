// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { useAppStore } from './store';
import type { VaultFile } from './types';
const boundary = vi.hoisted(() => ({ handlers: new Map<string, (event: {payload:unknown})=>Promise<void>>(), scan: vi.fn(), read: vi.fn() }));
vi.mock('@tauri-apps/api/event', () => ({ listen: async (name:string, callback:(event:{payload:unknown})=>Promise<void>) => { boundary.handlers.set(name,callback);return ()=>boundary.handlers.delete(name); } }));
vi.mock('@tauri-apps/api/core', async original => ({...await original<object>(), invoke: async()=>undefined}));
vi.mock('@tauri-apps/plugin-fs', async original => ({...await original<object>(),stat:async()=>({size:1,mtime:null})}));
vi.mock('./lib/vault', async original => ({...await original<object>(), IN_TAURI:true,authorizeVaultRoot:async()=>{},assertVaultRootAvailable:async()=>{},scanVault:boundary.scan,readNote:boundary.read,readNoteResult:async()=>({ok:true,text:'text'}),recoverWriteArtifacts:async()=>({restored:[],removed:[]}),watchVault:async()=>()=>{}}));
vi.mock('./lib/vaultIndex',async original=>({...await original<object>(),loadIndexedNotes:async()=>({notes:{},cache:{},read:0,reused:0,skipped:[],failed:[]})}));
const initial=useAppStore.getState();
afterEach(()=>{useAppStore.setState(initial,true);vi.useRealTimers();});
it('50 activity writes to known paths in a 5000-file vault cause no full scan',async()=>{
  vi.useFakeTimers();
  const files:VaultFile[]=Array.from({length:5000},(_,i)=>({path:`/v/N${i}.md`,relPath:`N${i}.md`,name:`N${i}`,ext:'md',isMarkdown:true}));
  boundary.scan.mockResolvedValue(files);boundary.read.mockResolvedValue('text');
  await useAppStore.getState().openVault('/v');await vi.advanceTimersByTimeAsync(2000);
  expect(boundary.handlers.has('activity')).toBe(true);boundary.scan.mockClear();
  for(let i=0;i<50;i++) {
    await boundary.handlers.get('activity')!({payload:{path:`/v/N${i}.md`,op:'write',status:'ok'}});
    await vi.advanceTimersByTimeAsync(200);
  }
  expect(boundary.scan).not.toHaveBeenCalled();
});
