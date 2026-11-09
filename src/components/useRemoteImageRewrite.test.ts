import { afterEach, expect, it, vi } from 'vitest';
const native = vi.hoisted(() => ({ tokens: 0, invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({
  invoke: native.invoke,
  convertFileSrc: (_path: string, scheme: string) => `${scheme}://localhost/`,
}));
vi.mock('../lib/vault', () => ({ IN_TAURI: true }));
import { subscribeRemoteImages } from './useRemoteImageRewrite';

afterEach(() => { native.invoke.mockReset(); native.tokens = 0; });

it('shares one broker token per window, renews nothing after release and revokes it', async () => {
  native.invoke.mockImplementation(async (_cmd: string, args: { token: string | null }) => (args.token ? null : `tok${++native.tokens}`));
  const first = vi.fn(), second = vi.fn();
  const releaseFirst = subscribeRemoteImages(first);
  const releaseSecond = subscribeRemoteImages(second);
  await vi.waitFor(() => expect(first).toHaveBeenCalled());
  expect(native.invoke).toHaveBeenCalledTimes(1);
  const rewrite = first.mock.calls.at(-1)![0] as (raw: string) => string;
  expect(rewrite('https://cdn.example/a.png')).toBe('mesa-web://localhost/tok1?u=https%3A%2F%2Fcdn.example%2Fa.png');
  expect(second).toHaveBeenCalled();
  releaseFirst();
  expect(native.invoke).toHaveBeenCalledTimes(1);
  releaseSecond();
  expect(native.invoke).toHaveBeenLastCalledWith('browse_resource_session', { token: 'tok1' });
});

it('reports an unavailable broker so callers keep remote media unloaded', async () => {
  native.invoke.mockRejectedValue(new Error('surface denied'));
  const listener = vi.fn();
  const release = subscribeRemoteImages(listener);
  await vi.waitFor(() => expect(listener).toHaveBeenCalledWith(null));
  release();
});
