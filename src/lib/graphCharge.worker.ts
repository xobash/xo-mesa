import { ChargeKernel } from "./graphChargeKernel";
import type { ChargeRequest, ChargeResponse } from "./graphChargeParallel";

// One helper of the physics worker: builds the tick's tree from positions,
// then applies the many-body pass to its range of nodes.
const kernel = new ChargeKernel();
let built = false;

self.onmessage = (event: MessageEvent<ChargeRequest>) => {
  const m = event.data;
  if (m.kind === "tree") {
    kernel.reserve(m.n);
    kernel.xs.set(m.xs); kernel.ys.set(m.ys);
    kernel.strengths = m.strengths;
    kernel.distanceMin2 = m.distanceMin2; kernel.distanceMax2 = m.distanceMax2; kernel.theta2 = m.theta2;
    built = kernel.prepare();
    return;
  }
  kernel.vx.set(m.vx); kernel.vy.set(m.vy);
  let jiggled = false;
  if (built) kernel.applyRange(m.from, m.to, m.alpha, () => { jiggled = true; return 0.5; });
  const vx = kernel.vx.slice(m.from, m.to), vy = kernel.vy.slice(m.from, m.to);
  const reply: ChargeResponse = { id: m.id, from: m.from, vx, vy, jiggled };
  (self as unknown as Worker).postMessage(reply, [vx.buffer, vy.buffer]);
};
