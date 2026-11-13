/** Status-line port for `lib/` modules that must not import the store.
 *  The store registers the sink when it is created; before that, reports are dropped. */
let sink: ((status: string) => void) | null = null;

export function setStatusSink(next: ((status: string) => void) | null): void {
  sink = next;
}

export function reportStatus(status: string): void {
  sink?.(status);
}
