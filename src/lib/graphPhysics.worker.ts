import { GraphPhysicsSession, GraphReplaySession, warmGraphSimulation, warmGraphSimulationParallel, type GraphPhysicsRequest, type GraphPhysicsResponse } from "./graphPhysics";
import { PARALLEL_CHARGE_MIN_NODES, createChargeHelpers, type ChargeHelpers } from "./graphChargeParallel";

// One physics step per display frame at most, matching GraphView's one tick per frame.
const STEP_MS = 1000 / 60;
let session: GraphPhysicsSession | null = null;
let sessionId = 0;
let timer: ReturnType<typeof setTimeout> | null = null;
let running = false;
// A grab, release or admit that arrived during a running step wakes the next one.
let wake = false;
let replay: GraphReplaySession | null = null;

// Heavy simulations spread the many-body pass over helper workers, leaving a
// core for the page and one for this worker (bit-identical results;
// `graphChargeParallel.ts`). Created on first need; null without nested workers.
let helpers: ChargeHelpers | null | undefined;
function helpersFor(count: number): ChargeHelpers | null {
  if (count < PARALLEL_CHARGE_MIN_NODES) return null;
  if (helpers === undefined) {
    const cores = typeof navigator !== "undefined" && navigator.hardwareConcurrency ? navigator.hardwareConcurrency : 2;
    helpers = createChargeHelpers(Math.min(6, cores - 2));
  }
  // A helper died: the rest of this worker's life runs on one core.
  return helpers && !helpers.failed ? helpers : null;
}

const post = (message: GraphPhysicsResponse) =>
  (self as unknown as Worker).postMessage(message, [message.state.buffer]);

function schedule(delay: number): void {
  if (running) { wake = true; return; }
  if (timer == null) timer = setTimeout(() => void run(), delay);
}

async function run(): Promise<void> {
  timer = null;
  running = true;
  try {
    const started = performance.now();
    const current = replay ?? session;
    if (!current) return;
    if (current === replay) {
      // A replay ticks once per frame while hot; the next admit wakes it.
      if (!replay.hot) return;
      const pool = helpersFor(replay.nodeCount);
      if (pool) await replay.stepParallel(pool); else replay.step();
      if (current !== replay) return;
      post({ type: "state", session: sessionId, state: replay.state(), alpha: replay.sim.alpha() });
      running = false;
      schedule(Math.max(0, STEP_MS - (performance.now() - started)));
      return;
    }
    const physics = current as GraphPhysicsSession;
    const pool = helpersFor(physics.nodeCount);
    if (pool) await physics.stepParallel(pool); else physics.step();
    // A stop or a new session arrived while the step ran.
    if (physics !== session) return;
    const settled = physics.settled;
    post({ type: settled ? "idle" : "state", session: sessionId, state: physics.state(), alpha: physics.sim.alpha() });
    // A settled session pauses; a later grab resumes it, a stop discards it.
    running = false;
    if (!settled) schedule(Math.max(0, STEP_MS - (performance.now() - started)));
  } finally {
    running = false;
    if (wake) { wake = false; schedule(0); }
  }
}

self.onmessage = async (event: MessageEvent<GraphPhysicsRequest>) => {
  const message = event.data;
  if (message.type === "helpers") {
    helpersFor(message.count);
    return;
  }
  if (message.type === "warm") {
    // Independent of any drag or settle session; the copy is dropped after.
    const started = performance.now();
    const warm = new GraphPhysicsSession(message.init);
    const pool = helpersFor(warm.nodeCount);
    if (pool) await warmGraphSimulationParallel(warm.sim, message.count, pool, message.startAlpha);
    else warmGraphSimulation(warm.sim, message.count, message.startAlpha);
    post({ type: "warmed", session: message.session, state: warm.state(), alpha: warm.sim.alpha(), ms: Math.round(performance.now() - started), helpers: pool?.size ?? 0 });
    return;
  }
  if (message.type === "start") {
    replay = null;
    session = new GraphPhysicsSession(message.init);
    sessionId = message.session;
    schedule(0);
    return;
  }
  if (message.type === "replay") {
    session = null;
    replay = new GraphReplaySession(message.ids, message.links, message.admitAt, message.settings);
    sessionId = message.session;
    return;
  }
  if (message.session !== sessionId) return;
  if (message.type === "admit") {
    replay?.admit(message.count, message.seeds);
    schedule(0);
    return;
  }
  if (message.type === "stop") {
    replay = null;
  }
  if (!session) return;
  if (message.type === "stop") {
    session = null;
    if (timer != null) clearTimeout(timer);
    timer = null;
  } else if (message.type === "grab") {
    session.grab(message.index, message.fx, message.fy);
    schedule(0);
  } else if (message.type === "move") {
    session.move(message.index, message.fx, message.fy);
  } else {
    session.release(message.index);
    schedule(0);
  }
};
