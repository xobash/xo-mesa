// Slow-motion clock: page time runs at K x real time so heavy frames can be captured smoothly.
(() => {
  let K = 1;
  try { K = Number(window.top === window ? (window.__REC_K__ ?? 1) : (window.top.__REC_K__ ?? 1)) || 1; } catch { K = 1; }
  if (K === 1) return;
  const rPerf = performance.now.bind(performance);
  const rDateNow = Date.now.bind(Date);
  const base = rDateNow();
  const pBase = rPerf();
  performance.now = () => pBase + (rPerf() - pBase) * K;
  const vNow = () => Math.floor(base + (rDateNow() - base) * K);
  const RD = Date;
  RD.now = vNow;
  window.Date = class extends RD { constructor(...a) { if (a.length === 0) super(vNow()); else super(...a); } static now() { return vNow(); } };
  const st = window.setTimeout.bind(window), si = window.setInterval.bind(window);
  window.setTimeout = (fn, d = 0, ...a) => st(fn, (Number(d) || 0) / K, ...a);
  window.setInterval = (fn, d = 0, ...a) => si(fn, Math.max(1, (Number(d) || 0) / K), ...a);
  const raf = window.requestAnimationFrame.bind(window);
  window.requestAnimationFrame = (cb) => raf(() => cb(performance.now()));
})();
