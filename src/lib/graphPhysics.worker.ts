import { GraphPhysicsSession, type GraphPhysicsRequest, type GraphPhysicsResponse } from "./graphPhysics";

// One physics step per display frame at most, matching GraphView's one tick per frame.
const STEP_MS = 1000 / 60;
let session: GraphPhysicsSession | null = null;
let sessionId = 0;
let timer: ReturnType<typeof setTimeout> | null = null;

const post = (message: GraphPhysicsResponse) =>
  (self as unknown as Worker).postMessage(message, [message.state.buffer]);

function schedule(delay: number): void {
  if (timer == null) timer = setTimeout(run, delay);
}

function run(): void {
  timer = null;
  if (!session) return;
  const started = performance.now();
  session.step();
  const settled = session.settled;
  post({ type: settled ? "idle" : "state", session: sessionId, state: session.state(), alpha: session.sim.alpha() });
  // A settled session pauses; a later grab resumes it, a stop discards it.
  if (!settled) schedule(Math.max(0, STEP_MS - (performance.now() - started)));
}

self.onmessage = (event: MessageEvent<GraphPhysicsRequest>) => {
  const message = event.data;
  if (message.type === "start") {
    session = new GraphPhysicsSession(message.init);
    sessionId = message.session;
    schedule(0);
    return;
  }
  if (!session || message.session !== sessionId) return;
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
