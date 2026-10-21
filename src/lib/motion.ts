const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';
export function prefersReducedMotion(): boolean {
  return typeof matchMedia === 'function' && matchMedia(REDUCED_MOTION_QUERY).matches;
}
export function onReducedMotionChange(listener: (reduce: boolean) => void): () => void {
  if (typeof matchMedia !== 'function') return () => {};
  const query = matchMedia(REDUCED_MOTION_QUERY);
  const handler = (event: MediaQueryListEvent) => listener(event.matches);
  query.addEventListener('change', handler);
  return () => query.removeEventListener('change', handler);
}
