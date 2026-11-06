// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
const boundary = vi.hoisted(() => ({ invoke: vi.fn(async (_name: string, _args?: unknown): Promise<unknown> => undefined) }));
vi.mock('@tauri-apps/api/core', async original => ({ ...await original<object>(), invoke: (name: string, args?: unknown) => boundary.invoke(name, args) }));
vi.mock('./lib/vault', async original => ({ ...await original<object>(), IN_TAURI: true }));
import { useAppStore } from './store';
const DAMAGED = 'Saved sync keys are damaged or incomplete, so Mesa will not use them.';
const initial = useAppStore.getState();
afterEach(() => { useAppStore.setState(initial, true); boundary.invoke.mockReset(); });

it('a confirmed reset replaces damaged keys, drops stale peer references and clears the error', async () => {
  let damaged = true;
  boundary.invoke.mockImplementation(async (name: string, args?: unknown) => {
    if (name === 'sync_secrets_read') { if (damaged) throw DAMAGED; return JSON.stringify({ syncToken: 'credential:device', peers: {} }); }
    if (name === 'sync_secrets_generate') { expect(args).toEqual({ reset: true }); damaged = false; return 'credential:device'; }
    if (name === 'sync_secrets_write') {
      const value = JSON.parse((args as { value: string }).value) as { syncToken: string; peers: Record<string, string> };
      return JSON.stringify({ syncToken: value.syncToken ? 'credential:device' : '', peers: {} });
    }
    return undefined;
  });
  const state = useAppStore.getState();
  useAppStore.setState({ settings: { ...state.settings, syncToken: '', peers: [{ id: 'p', name: 'Peer', address: 'https://198.51.100.2:8787', token: 'credential:peer:p' }] as typeof state.settings.peers } });
  await expect(useAppStore.getState().loadSyncSecrets()).rejects.toBe(DAMAGED);
  expect(useAppStore.getState().settingsIssue).toContain('Saved sync keys are damaged');
  expect(boundary.invoke).not.toHaveBeenCalledWith('sync_secrets_generate', expect.anything());

  await useAppStore.getState().resetSyncKeys();
  const after = useAppStore.getState();
  expect(after.settings.syncToken).toBe('credential:device');
  expect(after.settings.peers[0].token).toBeUndefined();
  expect(after.settingsIssue).not.toContain('damaged');
  await vi.waitFor(() => expect(boundary.invoke).toHaveBeenCalledWith('sync_secrets_write', expect.anything()));
  const write = boundary.invoke.mock.calls.find(([name]) => name === 'sync_secrets_write')!;
  expect(JSON.parse((write[1] as { value: string }).value)).toEqual({ syncToken: 'credential:device', peers: {} });
});
