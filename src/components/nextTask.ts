/**
 * Run `task` in a new macrotask without the 4 ms minimum that browsers apply
 * to nested zero-delay timers, so a chain of short steps keeps the page
 * painting between steps without idling. Falls back to a timer where
 * MessageChannel is missing.
 */
let channel: MessageChannel | null = null;
const queue: (() => void)[] = [];

export function nextTask(task: () => void): void {
  if (typeof MessageChannel === "undefined") {
    setTimeout(task, 0);
    return;
  }
  if (!channel) {
    channel = new MessageChannel();
    channel.port1.onmessage = () => {
      const run = queue.shift();
      run?.();
    };
  }
  queue.push(task);
  channel.port2.postMessage(0);
}
