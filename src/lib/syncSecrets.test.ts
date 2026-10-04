import { expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS, SETTINGS_KEY } from './settings';
import { hydrateSyncSecrets, persistSyncSecrets, type SyncSecretStore } from './syncSecrets';

function setup(raw: string | null) {
  const values = new Map<string, string>();
  if (raw !== null) values.set(SETTINGS_KEY, raw);
  const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
  let secret: string | null = null;
  const backend: SyncSecretStore = {
    read: vi.fn(async () => secret),
    write: vi.fn(async value => { secret = value; }),
  };
  return { storage, backend, saved: () => secret };
}

it('moves legacy device and peer keys to the credential store before scrubbing browser storage', async () => {
  const key = 'a'.repeat(64);
  const settings = { ...DEFAULT_SETTINGS, syncToken: key, peers: [{ id: 'one', name: 'One', address: 'peer', favorite: false, token: key }] };
  const { storage, backend, saved } = setup(JSON.stringify(settings));
  const loaded = await hydrateSyncSecrets(settings, backend, storage);
  expect(loaded.syncToken).toBe(key);
  expect(loaded.peers[0].token).toBe(key);
  expect(JSON.parse(saved()!).peers.one).toBe(key);
  expect(storage.getItem(SETTINGS_KEY)).not.toContain(key);
});

it('keeps legacy keys if credential storage fails', async () => {
  const key = 'b'.repeat(64);
  const settings = { ...DEFAULT_SETTINGS, syncToken: key };
  const { storage, backend } = setup(JSON.stringify(settings));
  backend.write = vi.fn(async () => { throw new Error('locked'); });
  await expect(hydrateSyncSecrets(settings, backend, storage)).rejects.toThrow('locked');
  expect(storage.getItem(SETTINGS_KEY)).toContain(key);
});

it('uses saved credentials on a later launch and writes updates without browser storage', async () => {
  const key = 'c'.repeat(64);
  const next = 'd'.repeat(64);
  const { storage, backend } = setup(JSON.stringify(DEFAULT_SETTINGS));
  await persistSyncSecrets({ ...DEFAULT_SETTINGS, syncToken: key }, backend, storage);
  expect((await hydrateSyncSecrets(DEFAULT_SETTINGS, backend, storage)).syncToken).toBe(key);
  await persistSyncSecrets({ ...DEFAULT_SETTINGS, syncToken: next }, backend, storage);
  expect((await hydrateSyncSecrets(DEFAULT_SETTINGS, backend, storage)).syncToken).toBe(next);
  expect(storage.getItem(SETTINGS_KEY)).not.toContain(next);
});
