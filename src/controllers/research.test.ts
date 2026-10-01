// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { createStore } from 'zustand';
import { useAppStore } from '../store';
import { backgroundWork } from '../lib/backgroundWorkGovernor';
import { createResearchController } from './research';
const io = vi.hoisted(() => ({ listen: vi.fn(), send: vi.fn(), interrupt: vi.fn(), nav: vi.fn() }));
vi.mock('../lib/vault', async original => ({ ...await original<object>(), IN_TAURI: true }));
vi.mock('../lib/piSessionBridge', () => ({ getPiSessionSnapshot: () => ({ sessionId: 'test-session' }), requestSharedPiRestart: async () => { } }));
vi.mock('@tauri-apps/api/event', () => ({ listen: io.nav }));
vi.mock('../lib/deepResearchRun', () => ({ listenDeepResearch: io.listen, sendResearchPrompt: io.send, interruptPi: io.interrupt, waitForPiSession: async () => 'test-session' }));
afterEach(() => { backgroundWork.resetForTests(); vi.clearAllMocks(); });
function fixture() {
  const state = createStore(() => ({ ...useAppStore.getInitialState(), vaultPath: '/synthetic', files: [], notes: {}, contentCache: {} }));
  const controller = createResearchController({
    get: state.getState, set: state.setState, getGeneration: () => 0,
    registerExternalFile: async () => { }, refreshMissingExternalFiles: async () => { }
  });
  state.setState(controller.actions);
  return { state, controller, start: () => controller.actions.startDeepResearch('test', { piSurfaceAvailable: true }) };
}
it('cancels a pending subscription and never submits the cancelled prompt', async () => {
  let resolve!: (unlisten: () => void) => void;
  io.listen.mockReturnValue(new Promise(r => { resolve = r; }));
  const f = fixture(); const start = f.start();
  await vi.waitFor(() => expect(io.listen).toHaveBeenCalledOnce());
  await f.controller.actions.cancelDeepResearch();
  const stop = vi.fn(); resolve(stop); await start;
  expect(stop).toHaveBeenCalledOnce(); expect(io.send).not.toHaveBeenCalled();
  expect(f.state.getState().deepResearch).toMatchObject({ phase: 'cancelled', launchStage: 'cancelled' });
});
it('rolls back partial navigation registration while retaining progress until stop', async () => {
  const progress = vi.fn(), browse = vi.fn(); io.listen.mockResolvedValue(progress);
  io.nav.mockResolvedValueOnce(browse).mockRejectedValueOnce(Error('registration failed'));
  const f = fixture(); await f.start();
  expect(browse).toHaveBeenCalledOnce(); expect(progress).not.toHaveBeenCalled();
  expect(io.send).toHaveBeenCalledOnce(); await f.controller.stop();
  expect(progress).toHaveBeenCalledOnce(); expect(browse).toHaveBeenCalledOnce();
});
it('does not revive a cancelled run when prompt submission completes late', async () => {
  let resolve!: () => void;
  io.listen.mockResolvedValue(vi.fn()); io.nav.mockResolvedValue(vi.fn());
  io.send.mockReturnValueOnce(new Promise<void>(r => {resolve = r;}));
  const f = fixture(); const start = f.start();
  await vi.waitFor(() => expect(io.send).toHaveBeenCalledOnce());
  await f.controller.actions.cancelDeepResearch(); resolve(); await start;
  expect(f.state.getState().deepResearch).toMatchObject({phase:'cancelled', launchStage:'cancelled'});
});
