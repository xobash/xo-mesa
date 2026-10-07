// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const io = vi.hoisted(() => ({
  start: vi.fn(async (_port: number, _token: string, _root: string) => {}),
  stop: vi.fn(async () => {}),
}));
vi.mock('./lib/sync', async original => ({
  ...await original<object>(),
  startSyncServer: io.start,
  stopSyncServer: io.stop,
}));

import { useAppStore } from './store';

const initial = useAppStore.getState();
beforeEach(() => {
  vi.clearAllMocks();
  useAppStore.setState({ ...initial, vaultPath: '/vault', syncListening: true,
    settings: { ...initial.settings, syncEnabled: true, syncToken: '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f', syncPort: 8787 } });
});
afterEach(() => useAppStore.setState(initial));

it('reconfigures the active receiver when its port or key changes', async () => {
  useAppStore.getState().setSetting('syncPort', 8788);
  await vi.waitFor(() => expect(io.start).toHaveBeenCalledWith(8788, '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f', '/vault', '127.0.0.1'));
  useAppStore.getState().setSetting('syncToken', '202122232425262728292a2b2c2d2e2f303132333435363738393a3b3c3d3e3f');
  await vi.waitFor(() => expect(io.start).toHaveBeenCalledWith(8788, '202122232425262728292a2b2c2d2e2f303132333435363738393a3b3c3d3e3f', '/vault', '127.0.0.1'));
});

it('stops receiving when the edited key is invalid', async () => {
  useAppStore.getState().setSetting('syncToken', 'short');
  await vi.waitFor(() => expect(io.stop).toHaveBeenCalledOnce());
  expect(useAppStore.getState().syncListening).toBe(false);
  expect(io.start).not.toHaveBeenCalled();
});

it('reconfigures the receiver when its selected interface changes', async () => {
  useAppStore.getState().setSetting('syncBindAddress', '203.0.113.8');
  await vi.waitFor(() => expect(io.start).toHaveBeenCalledWith(8787, expect.any(String), '/vault', '203.0.113.8'));
});
