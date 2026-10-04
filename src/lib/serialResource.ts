/** Serial setup/teardown for an async resource whose old stop must precede a new start. */
export function createSerialResource() {
  let tail = Promise.resolve();
  return (start: () => Promise<() => void | Promise<void>>, onError: (error: unknown) => void = () => {}) => {
    let disposed = false;
    let stop: (() => void | Promise<void>) | undefined;
    const acquire = tail.then(async () => {
      if (disposed) return;
      stop = await start();
    });
    tail = acquire.catch(onError);
    return () => {
      if (disposed) return;
      disposed = true;
      const release = tail.then(async () => { await stop?.(); stop = undefined; });
      tail = release.catch(onError);
    };
  };
}
