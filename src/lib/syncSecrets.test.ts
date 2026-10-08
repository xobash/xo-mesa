import { expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS, SETTINGS_KEY } from './settings';
import { hydrateSyncSecrets, persistSyncSecrets, type SyncSecretStore } from './syncSecrets';
function setup(raw: string | null) {
  const values = new Map<string,string>();
  if (raw !== null) values.set(SETTINGS_KEY,raw);
  const storage = { getItem: (key:string) => values.get(key) ?? null, setItem: (key:string,value:string) => { values.set(key,value); } };
  let secret: { syncToken: string; peers: Record<string,string> } = { syncToken: '', peers: {} };
  const references = () => JSON.stringify({ syncToken: secret.syncToken ? 'credential:device' : '', peers: Object.fromEntries(Object.keys(secret.peers).map(id => [id,`credential:peer:${id}`])) });
  const backend: SyncSecretStore = {
    read: vi.fn(async () => references()),
    write: vi.fn(async value => {
      const input = JSON.parse(value);
      secret = { syncToken: input.syncToken === 'credential:device' ? secret.syncToken : input.syncToken, peers: Object.fromEntries(Object.entries<string>(input.peers).map(([id,key]) => [id,key.startsWith('credential:') ? secret.peers[id] : key])) };
      return references();
    }),
  };
  return { storage, backend, saved: () => secret };
}
it('migrates legacy keys before scrubbing storage and returns references only', async () => {
  const key = 'a'.repeat(64);
  const settings = { ...DEFAULT_SETTINGS, syncToken:key, peers:[{ id:'one', name:'One',address:'peer',favorite:false,token:key }] };
  const {storage,backend,saved} = setup(JSON.stringify(settings));
  const loaded = await hydrateSyncSecrets(settings,backend,storage);
  expect(loaded.syncToken).toBe('credential:device'); expect(loaded.peers[0].token).toBe('credential:peer:one');
  expect(saved().peers.one).toBe(key); expect(JSON.stringify(loaded)).not.toContain(key); expect(storage.getItem(SETTINGS_KEY)).not.toContain(key);
});
it('keeps legacy keys if credential storage fails',async () => {
  const key = 'b'.repeat(64); const settings = { ...DEFAULT_SETTINGS,syncToken:key };
  const {storage,backend} = setup(JSON.stringify(settings)); backend.write = vi.fn(async () => { throw new Error('locked'); });
  await expect(hydrateSyncSecrets(settings,backend,storage)).rejects.toThrow('locked'); expect(storage.getItem(SETTINGS_KEY)).toContain(key);
});
it('retains native keys across launches and updates without returning them',async () => {
  const key = 'c'.repeat(64),next = 'd'.repeat(64); const {storage,backend,saved} = setup(JSON.stringify(DEFAULT_SETTINGS));
  const loaded = await persistSyncSecrets({...DEFAULT_SETTINGS,syncToken:key},backend,storage);
  expect(loaded.syncToken).toBe('credential:device'); expect((await hydrateSyncSecrets(DEFAULT_SETTINGS,backend,storage)).syncToken).toBe('credential:device');
  await persistSyncSecrets({...loaded,syncToken:next},backend,storage); expect(saved().syncToken).toBe(next);
  expect(storage.getItem(SETTINGS_KEY)).not.toContain(next);
});
it('fails closed without scrubbing legacy keys when native read fails',async () => {
  const {storage,backend} = setup(JSON.stringify({...DEFAULT_SETTINGS,syncToken:'keep'}));
  backend.read = vi.fn(async () => { throw new Error('unavailable'); });
  await expect(hydrateSyncSecrets(DEFAULT_SETTINGS,backend,storage)).rejects.toThrow('unavailable'); expect(storage.getItem(SETTINGS_KEY)).toContain('keep');
});
