import { useLayoutEffect, useState, type RefObject } from "react";

interface ScrollViewport {
  scrollTop: number;
  height: number;
  /** Always 0 unless the hook was asked to track the horizontal axis. */
  scrollLeft: number;
  /** Always the fallback width unless the horizontal axis is tracked. */
  width: number;
}

const FALLBACK_HEIGHT = 600;
const FALLBACK_WIDTH = 1200;

/**
 * Scroll position and size of `ref`, sampled at most once per frame.
 * `horizontal` also tracks `scrollLeft` and `width`.
 */
export function useScrollViewport(
  ref: RefObject<HTMLElement | null>,
  key: unknown,
  horizontal = false,
): ScrollViewport {
  const [viewport, setViewport] = useState<ScrollViewport>({
    scrollTop: 0,
    height: FALLBACK_HEIGHT,
    scrollLeft: 0,
    width: FALLBACK_WIDTH,
  });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    let raf = 0;
    const measure = () => {
      raf = 0;
      const next: ScrollViewport = {
        scrollTop: el.scrollTop,
        height: el.clientHeight || FALLBACK_HEIGHT,
        scrollLeft: horizontal ? el.scrollLeft : 0,
        width: horizontal ? el.clientWidth || FALLBACK_WIDTH : FALLBACK_WIDTH,
      };
      setViewport((prev) =>
        prev.scrollTop === next.scrollTop &&
        prev.height === next.height &&
        prev.scrollLeft === next.scrollLeft &&
        prev.width === next.width
          ? prev
          : next,
      );
    };
    const schedule = () => {
      if (!raf) raf = requestAnimationFrame(measure);
    };
    measure();
    el.addEventListener("scroll", schedule, { passive: true });
    const ro = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(schedule);
    ro?.observe(el);
    return () => {
      if (raf) cancelAnimationFrame(raf);
      el.removeEventListener("scroll", schedule);
      ro?.disconnect();
    };
  }, [ref, key, horizontal]);
  return viewport;
}
