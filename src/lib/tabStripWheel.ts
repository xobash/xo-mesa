/** Horizontal scroll, in pixels, for a wheel event over the tab strip, or 0
 * when the event should keep its native behavior. The strip hides its
 * scrollbar, so a vertical mouse wheel is its only scroll control off macOS;
 * a horizontal trackpad gesture already scrolls it natively. */
export function tabStripWheelDelta(
  event: Pick<WheelEvent, "deltaX" | "deltaY" | "deltaMode" | "ctrlKey">,
  stripWidth: number
): number {
  // Ctrl+wheel is zoom; horizontal-dominant gestures scroll natively.
  if (event.ctrlKey || Math.abs(event.deltaX) >= Math.abs(event.deltaY)) return 0;
  if (event.deltaMode === 1) return event.deltaY * 16;
  if (event.deltaMode === 2) return event.deltaY * stripWidth;
  return event.deltaY;
}

/** Map vertical wheel turns on `strip` to horizontal scrolling. Returns the remover. */
export function installTabStripWheel(strip: HTMLElement): () => void {
  const onWheel = (event: WheelEvent) => {
    const delta = tabStripWheelDelta(event, strip.clientWidth);
    if (!delta || strip.scrollWidth <= strip.clientWidth) return;
    event.preventDefault();
    strip.scrollLeft += delta;
  };
  strip.addEventListener("wheel", onWheel, { passive: false });
  return () => strip.removeEventListener("wheel", onWheel);
}
