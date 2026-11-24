// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  inTauri: true,
  native: { saved: true, active: true, controllable: true } as Record<string, unknown>,
  fail: '',
  invoke: vi.fn(),
}));
vi.mock('../../lib/vaultFs', () => ({ get IN_TAURI() { return mocks.inTauri; } }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));

import { HardwareAccelerationRow } from './HardwareAccelerationRow';
import { normalizeGraphicsState } from '../../lib/graphicsAcceleration';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement, root: ReturnType<typeof createRoot>;
const toggle = () => host.querySelector<HTMLButtonElement>('[role="switch"]');
const render = () => act(async () => { root.render(<HardwareAccelerationRow />); await Promise.resolve(); });

beforeEach(() => {
  mocks.inTauri = true; mocks.fail = '';
  mocks.native = { saved: true, active: true, controllable: true };
  mocks.invoke.mockReset();
  mocks.invoke.mockImplementation(async (command: string, args?: { enabled?: boolean }) => {
    if (command !== 'graphics_acceleration') throw new Error(command);
    if (args?.enabled !== undefined) {
      if (mocks.fail) throw mocks.fail;
      mocks.native = { ...mocks.native, saved: args.enabled };
    }
    return mocks.native;
  });
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });

it('shows the saved native preference, on by default, with the restart rule', async () => {
  await render();
  expect(host.textContent).toContain('Hardware acceleration');
  expect(toggle()!.getAttribute('aria-checked')).toBe('true');
  expect(host.textContent).toContain('Applies after you restart Mesa.');
  expect(host.querySelector('[role="status"]')).toBeNull();
  expect(mocks.invoke).toHaveBeenCalledWith('graphics_acceleration');
});

it('saves a change natively for the next launch and says a restart is needed', async () => {
  await render();
  await act(async () => { toggle()!.click(); await Promise.resolve(); });
  expect(mocks.invoke).toHaveBeenLastCalledWith('graphics_acceleration', { enabled: false });
  expect(toggle()!.getAttribute('aria-checked')).toBe('false');
  expect(host.querySelector('[role="status"]')!.textContent).toContain('Restart Mesa to apply');
  // Turning it back on matches this launch again, so no restart is pending.
  await act(async () => { toggle()!.click(); await Promise.resolve(); });
  expect(host.querySelector('[role="status"]')).toBeNull();
});

it('keeps the saved value and shows the refusal when native saving fails', async () => {
  mocks.fail = 'Cannot create Mesa\'s settings folder';
  await render();
  await act(async () => { toggle()!.click(); await Promise.resolve(); });
  expect(toggle()!.getAttribute('aria-checked')).toBe('true');
  expect(host.querySelector('[role="alert"]')!.textContent).toContain('Cannot create');
});

it('says plainly that macOS has no switch and offers none', async () => {
  mocks.native = { saved: true, active: true, controllable: false };
  await render();
  expect(toggle()).toBeNull();
  expect(host.textContent).toContain('Always on');
  expect(host.textContent).toContain('Apple gives apps no switch');
});

it('is absent in the browser preview, which has no native side', async () => {
  mocks.inTauri = false;
  await render();
  expect(host.textContent).toBe('');
  expect(mocks.invoke).not.toHaveBeenCalled();
});

it('rejects malformed native replies', () => {
  expect(normalizeGraphicsState({ saved: true, active: true, controllable: true })).toEqual({ saved: true, active: true, controllable: true });
  expect(normalizeGraphicsState({ saved: 'no', active: true, controllable: true })).toBeNull();
  expect(normalizeGraphicsState(null)).toBeNull();
});
