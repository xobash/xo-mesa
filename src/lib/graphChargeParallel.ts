import type { Simulation, SimulationLinkDatum, SimulationNodeDatum } from "d3-force";
import type { ChargeKernel } from "./graphChargeKernel";

/**
 * The many-body pass of a heavy simulation spread over helper workers. Each
 * node's charge velocity depends only on positions, its own starting velocity
 * and the tree, so every helper builds the same tree and applies a range; the
 * results are bit-identical to the serial pass (`graphChargeParallel.test.ts`).
 * Positions do not change while a tick's forces run, so helpers build their
 * trees while this thread runs the x, y and link forces; only the range pass
 * waits for the link force's velocities. A range that needs a jiggle (exactly
 * coincident points) makes the tick redo the pass serially with the
 * simulation's own random source.
 */

/** Build the tree for this tick from positions (sent before the link force runs). */
export interface ChargeTreeRequest {
  kind: "tree";
  n: number;
  xs: Float64Array; ys: Float64Array; strengths: Float64Array;
  distanceMin2: number; distanceMax2: number; theta2: number;
}

/** Apply nodes `from` to `to` on the built tree, from the given starting velocities. */
export interface ChargeApplyRequest {
  kind: "apply";
  id: number;
  vx: Float64Array; vy: Float64Array;
  alpha: number;
  from: number; to: number;
}

export type ChargeRequest = ChargeTreeRequest | ChargeApplyRequest;

export interface ChargeResponse {
  id: number;
  from: number;
  vx: Float64Array; vy: Float64Array;
  jiggled: boolean;
}

/** Where ranges run: helper workers in the app, in-process kernels in tests. Messages to one helper run in order. */
export interface ChargeHelpers {
  readonly size: number;
  /** A helper died; every later apply rejects at once. */
  readonly failed?: boolean;
  tree(helper: number, request: ChargeTreeRequest): void;
  apply(helper: number, request: ChargeApplyRequest): Promise<ChargeResponse>;
  /**
   * Run one tick's tree and apply messages without another simulation's in
   * between: the warm-up and a settle or replay session share the helpers,
   * and interleaved messages would apply one graph's ranges to another's tree.
   */
  exclusive?<T>(task: () => Promise<T>): Promise<T>;
}

/** A queue that runs async tasks one at a time, in call order; a failed task never blocks the next. */
export function createExclusive(): <T>(task: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(task: () => Promise<T>) => {
    const run = tail.then(task, task);
    tail = run.then(() => undefined, () => undefined);
    return run;
  };
}

/** Simulations at least this large use helpers (smaller ones lose to message cost). */
export const PARALLEL_CHARGE_MIN_NODES = 3000;

/** Helper workers for the many-body pass; null where nested workers are unavailable. */
export function createChargeHelpers(count: number): ChargeHelpers | null {
  if (count < 1 || typeof Worker === "undefined") return null;
  const workers: Worker[] = [];
  const waiting = new Map<number, { resolve: (response: ChargeResponse) => void; reject: (error: Error) => void }>();
  let failed = false;
  try {
    for (let i = 0; i < count; i++) {
      const worker = new Worker(new URL("./graphCharge.worker.ts", import.meta.url), { type: "module" });
      worker.onmessage = (event: MessageEvent<ChargeResponse>) => {
        const done = waiting.get(event.data.id);
        waiting.delete(event.data.id);
        done?.resolve(event.data);
      };
      worker.onerror = () => {
        failed = true;
        for (const done of waiting.values()) done.reject(new Error("charge helper failed"));
        waiting.clear();
      };
      workers.push(worker);
    }
  } catch {
    for (const worker of workers) worker.terminate();
    return null;
  }
  return {
    size: workers.length,
    get failed() { return failed; },
    tree(helper, request) {
      if (!failed) workers[helper].postMessage(request);
    },
    apply(helper, request) {
      if (failed) return Promise.reject(new Error("charge helper failed"));
      return new Promise((resolve, reject) => {
        waiting.set(request.id, { resolve, reject });
        workers[helper].postMessage(request);
      });
    },
    exclusive: createExclusive(),
  };
}

let requestId = 0;

/** Send this tick's positions so every helper builds its tree now. */
export function beginChargeParallel(kernel: ChargeKernel, helpers: ChargeHelpers): void {
  const n = kernel.n;
  for (let h = 0; h < helpers.size; h++) {
    helpers.tree(h, {
      kind: "tree", n, xs: kernel.xs.subarray(0, n), ys: kernel.ys.subarray(0, n), strengths: kernel.strengths,
      distanceMin2: kernel.distanceMin2, distanceMax2: kernel.distanceMax2, theta2: kernel.theta2,
    });
  }
}

/**
 * Apply the many-body pass for all nodes from the kernel's velocities (filled
 * after the link force), one range per helper. False when any range needed a
 * jiggle; the kernel's velocities are then unusable.
 */
export async function finishChargeParallel(kernel: ChargeKernel, alpha: number, helpers: ChargeHelpers): Promise<boolean> {
  const n = kernel.n, size = Math.ceil(n / helpers.size);
  const pending: Promise<ChargeResponse>[] = [];
  for (let h = 0; h < helpers.size; h++) {
    const from = h * size, to = Math.min(n, from + size);
    if (from >= to) break;
    pending.push(helpers.apply(h, { kind: "apply", id: ++requestId, vx: kernel.vx.subarray(0, n), vy: kernel.vy.subarray(0, n), alpha, from, to }));
  }
  let jiggled = false;
  for (const response of await Promise.all(pending)) {
    if (response.jiggled) jiggled = true;
    kernel.vx.set(response.vx, response.from);
    kernel.vy.set(response.vy, response.from);
  }
  return !jiggled;
}

/** The many-body force methods the parallel tick needs (`flatManyBody`). */
export interface ParallelCharge {
  (alpha: number): void;
  /** Load node positions into the kernel (no tree); null when there are no nodes. */
  loadPositions(): ChargeKernel | null;
  /** Load node velocities into the kernel. */
  loadVelocities(): void;
  /** Write the kernel's velocities back to the nodes. */
  commitKernel(): void;
}

/**
 * One `simulation.tick()` with the many-body force run through helpers: the
 * same alpha step, forces in Mesa's registration order (x, y, link, charge,
 * collide: `createGraphSimulation`, `GraphPhysicsSession`) and integration as
 * d3-force 3.0.0, so positions match a serial tick bit for bit.
 */
export async function tickParallel<N extends SimulationNodeDatum, L extends SimulationLinkDatum<N>>(sim: Simulation<N, L>, helpers: ChargeHelpers): Promise<void> {
  if (helpers.exclusive) return helpers.exclusive(() => tickParallelNow(sim, helpers));
  return tickParallelNow(sim, helpers);
}

async function tickParallelNow<N extends SimulationNodeDatum, L extends SimulationLinkDatum<N>>(sim: Simulation<N, L>, helpers: ChargeHelpers): Promise<void> {
  // d3 keeps 1 - velocityDecay; recover it exactly or fall back to d3's tick.
  const decay = 1 - sim.velocityDecay();
  const charge = sim.force("charge") as unknown as Partial<ParallelCharge> | undefined;
  if (1 - decay !== sim.velocityDecay() || !charge?.loadPositions || !charge.loadVelocities || !charge.commitKernel) { sim.tick(); return; }
  const alpha = sim.alpha() + (sim.alphaTarget() - sim.alpha()) * sim.alphaDecay();
  sim.alpha(alpha);
  const kernel = charge.loadPositions();
  if (kernel) beginChargeParallel(kernel, helpers);
  for (const name of ["x", "y", "link"]) (sim.force(name) as unknown as ((a: number) => void) | undefined)?.(alpha);
  if (kernel) {
    charge.loadVelocities();
    let done = false;
    try { done = await finishChargeParallel(kernel, alpha, helpers); } catch { done = false; }
    if (done) charge.commitKernel(); else (charge as ParallelCharge)(alpha);
  }
  (sim.force("collide") as unknown as ((a: number) => void) | undefined)?.(alpha);
  for (const node of sim.nodes()) {
    if (node.fx == null) node.x! += node.vx! *= decay;
    else { node.x = node.fx; node.vx = 0; }
    if (node.fy == null) node.y! += node.vy! *= decay;
    else { node.y = node.fy; node.vy = 0; }
  }
}
