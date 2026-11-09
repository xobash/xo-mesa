import { expect, it } from 'vitest';
import { brokerImageUrl, parseSrcset, rewriteSrcset } from './remoteImages';

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
