/** Coalesce a burst of mutable interaction updates into one publication per
 * animation frame. The newest value wins; callers choose when to snapshot it. */
export function createFramePublisher<T>(
  requestFrame: (callback: FrameRequestCallback) => number,
  cancelFrame: (handle: number) => void,
  publish: (value: T) => void
) {
  let frame: number | null = null;
  let latest: T | null = null;
  return {
    schedule(value: T) {
      latest = value;
      if (frame !== null) return;
      frame = requestFrame(() => {
        frame = null;
        const valueToPublish = latest;
        latest = null;
        if (valueToPublish !== null) publish(valueToPublish);
      });
    },
    cancel() {
      if (frame !== null) cancelFrame(frame);
      frame = null;
      latest = null;
    },
  };
}
