import { useLayoutEffect, useState, type RefObject } from "react";

export interface ScrollViewport {
  scrollTop: number;
  height: number;
}

/** Scroll position and height of `ref`, sampled at most once per frame. */
export function useScrollViewport(ref: RefObject<HTMLElement | null>, key: unknown): ScrollViewport {
  const [viewport, setViewport] = useState<ScrollViewport>({ scrollTop: 0, height: 600 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    let raf = 0;
    const measure = () => {
      raf = 0;
      const next = { scrollTop: el.scrollTop, height: el.clientHeight || 600 };
      setViewport((prev) => (prev.scrollTop === next.scrollTop && prev.height === next.height ? prev : next));
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
  }, [ref, key]);
  return viewport;
}
