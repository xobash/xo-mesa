import { afterEach, expect, it, vi } from 'vitest';
const native = vi.hoisted(() => ({ tokens: 0, invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({
  invoke: native.invoke,
  convertFileSrc: (_path: string, scheme: string) => `${scheme}://localhost/`,
}));
vi.mock('./vault', () => ({ IN_TAURI: true }));
import { brokerImageUrl, parseSrcset, rewriteSrcset, subscribeRemoteImages } from './remoteImages';

afterEach(() => { native.invoke.mockReset(); native.tokens = 0; });

it('brokers only web image URLs and normalizes protocol-relative ones to HTTPS', () => {
  expect(brokerImageUrl('mesa-web://localhost/', 't1', 'https://cdn.example/a b.png'))
    .toBe('mesa-web://localhost/t1?u=https%3A%2F%2Fcdn.example%2Fa%2520b.png');
  expect(brokerImageUrl('B/', 't', '//cdn.example/x.png')).toBe('B/t?u=https%3A%2F%2Fcdn.example%2Fx.png');
  expect(brokerImageUrl('B/', 't', 'http://plain.example/x.png')).toBe('B/t?u=http%3A%2F%2Fplain.example%2Fx.png');
  for (const raw of ['javascript:alert(1)', 'data:image/png;base64,AA', 'file:///etc/passwd', 'not a url']) {
    expect(brokerImageUrl('B/', 't', raw)).toBe('');
  }
});

it('rewrites every srcset candidate and keeps descriptors', () => {
  const rewrite = (raw: string) => `P(${raw})`;
  expect(rewriteSrcset('https://a.example/1.png 1x, //b.example/2.png 2x', rewrite)).toBe('P(https://a.example/1.png) 1x, P(//b.example/2.png) 2x');
  expect(rewriteSrcset('data:image/png;base64,A,B 1x', rewrite)).toBe('');
});

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

it('parses srcset candidates as HTML does, keeping commas inside URLs', () => {
  expect(parseSrcset('https://cdn.example/f_auto,w_100/a.png 1x,https://cdn.example/f_auto,w_200/a.png 2x')).toEqual([
    { url: 'https://cdn.example/f_auto,w_100/a.png', descriptors: ['1x'] },
    { url: 'https://cdn.example/f_auto,w_200/a.png', descriptors: ['2x'] },
  ]);
  expect(parseSrcset(' a.png,, b.png 100w  , c.png,')).toEqual([
    { url: 'a.png', descriptors: [] },
    { url: 'b.png', descriptors: ['100w'] },
    { url: 'c.png', descriptors: [] },
  ]);
  const rewrite = (raw: string) => `P(${raw})`;
  expect(rewriteSrcset('//cdn.example/x,y.png 2x', rewrite)).toBe('P(//cdn.example/x,y.png) 2x');
});
