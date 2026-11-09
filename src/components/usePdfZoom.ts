import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

/**
 * PDF zoom: the compositor preview (`--pdf-zoom` once per animation frame, no
 * React commit per sample), cursor-anchored scroll correction, and trackpad
 * pinch (ctrl+wheel). The settled `scale` reaches the editor hook, which
 * debounces the pdf.js repaint into `renderScale`.
 */
export function usePdfZoom(
  scale: number,
  renderScale: number,
  setScale: (scale: number) => void
) {
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const pagesRef = useRef<HTMLDivElement | null>(null);
  const pagesInnerRef = useRef<HTMLDivElement | null>(null);
  const scaleRef = useRef(scale);
  const renderScaleRef = useRef(renderScale);
  const zoomPreviewFrameRef = useRef<number | null>(null);
  const zoomSettleTimerRef = useRef<number | null>(null);
  const zoomAnchorRef = useRef<{
    x: number;
    y: number;
    prevRect: DOMRect;
  } | null>(null);

  useEffect(() => {
    scaleRef.current = scale;
  }, [scale]);
  useEffect(() => {
    renderScaleRef.current = renderScale;
  }, [renderScale]);

  useEffect(() => {
    return () => {
      if (zoomPreviewFrameRef.current !== null) {
        cancelAnimationFrame(zoomPreviewFrameRef.current);
      }
      if (zoomSettleTimerRef.current !== null) {
        window.clearTimeout(zoomSettleTimerRef.current);
      }
    };
  }, []);

  // The scroll containers are tracked in state so observers rebuild when they remount.
  const [pagesEl, setPagesEl] = useState<HTMLDivElement | null>(null);
  const [pagesInnerEl, setPagesInnerEl] = useState<HTMLDivElement | null>(null);
  const manualZoomRef = useRef(false);
  const bindPages = useCallback((el: HTMLDivElement | null) => {
    pagesRef.current = el;
    setPagesEl(el);
  }, []);
  const bindPagesInner = useCallback((el: HTMLDivElement | null) => {
    pagesInnerRef.current = el;
    if (el) {
      const factor = renderScaleRef.current > 0
        ? scaleRef.current / renderScaleRef.current
        : 1;
      el.style.setProperty("--pdf-zoom", String(factor));
    }
    setPagesInnerEl(el);
  }, []);

  const correctZoomAnchor = useCallback((clear = false) => {
    const pending = zoomAnchorRef.current;
    if (!pending) return;
    const pagesEl = pagesRef.current;
    const innerEl = pagesInnerRef.current;
    if (!pagesEl || !innerEl) {
      zoomAnchorRef.current = null;
      return;
    }
    const nextRect = innerEl.getBoundingClientRect();
    if (nextRect.width <= 0 || nextRect.height <= 0) {
      zoomAnchorRef.current = null;
      return;
    }
    const fx = (pending.x - pending.prevRect.left) / pending.prevRect.width;
    const fy = (pending.y - pending.prevRect.top) / pending.prevRect.height;
    const targetX = nextRect.left + fx * nextRect.width;
    const targetY = nextRect.top + fy * nextRect.height;
    pagesEl.scrollLeft += targetX - pending.x;
    pagesEl.scrollTop += targetY - pending.y;
    if (clear) {
      zoomAnchorRef.current = null;
    } else {
      // Keep the visual anchor current while several wheel samples are
      // coalesced into the next compositor frame.
      pending.prevRect = nextRect;
    }
  }, []);

  const flushZoomPreview = useCallback(() => {
    zoomPreviewFrameRef.current = null;
    const innerEl = pagesInnerRef.current;
    if (!innerEl) return;
    const factor = renderScaleRef.current > 0
      ? scaleRef.current / renderScaleRef.current
      : 1;
    innerEl.style.setProperty("--pdf-zoom", String(factor));
    correctZoomAnchor();
  }, [correctZoomAnchor]);

  const queueZoomPreview = useCallback(() => {
    if (zoomPreviewFrameRef.current !== null) return;
    zoomPreviewFrameRef.current = requestAnimationFrame(flushZoomPreview);
  }, [flushZoomPreview]);

  const captureZoomAnchor = useCallback((anchor?: { x: number; y: number }) => {
    const pagesEl = pagesRef.current;
    const innerEl = pagesInnerRef.current;
    const viewport = pagesEl?.getBoundingClientRect();
    const focus =
      anchor && viewport &&
      anchor.x >= viewport.left &&
      anchor.x <= viewport.right &&
      anchor.y >= viewport.top &&
      anchor.y <= viewport.bottom
        ? anchor
        : viewport
        ? { x: viewport.left + viewport.width / 2, y: viewport.top + viewport.height / 2 }
        : null;
    if (pagesEl && innerEl && focus) {
      const prevRect = innerEl.getBoundingClientRect();
      if (prevRect.width > 0 && prevRect.height > 0) {
        zoomAnchorRef.current = { x: focus.x, y: focus.y, prevRect };
        return;
      }
    }
    zoomAnchorRef.current = null;
  }, []);

  const zoomTo = useCallback(
    (
      nextScale: number,
      anchor?: { x: number; y: number },
      source: "button" | "pinch" = "button"
    ) => {
      const clamped = Math.min(3, Math.max(0.5, nextScale));
      if (clamped === scaleRef.current) return;
      manualZoomRef.current = true;
      captureZoomAnchor(anchor);
      scaleRef.current = clamped;
      queueZoomPreview();
      if (zoomSettleTimerRef.current !== null) {
        window.clearTimeout(zoomSettleTimerRef.current);
        zoomSettleTimerRef.current = null;
      }

      if (source === "pinch") {
        // Trackpad pinch emits many ctrl+wheel samples. Keep the transient
        // scale out of React so input is painted once per frame, then let the
        // existing hook debounce the expensive pdf.js repaint after release.
        zoomSettleTimerRef.current = window.setTimeout(() => {
          zoomSettleTimerRef.current = null;
          setScale(scaleRef.current);
        }, 100);
      } else {
        setScale(clamped);
      }
    },
    [captureZoomAnchor, queueZoomPreview, setScale]
  );

  useLayoutEffect(() => {
    if (!zoomAnchorRef.current || scale !== renderScale) return;
    const innerEl = pagesInnerRef.current;
    if (!innerEl) {
      zoomAnchorRef.current = null;
      return;
    }
    // Read the settled raster geometry without the transient compositor
    // preview, then make one final cursor-preserving scroll correction.
    innerEl.style.setProperty("--pdf-zoom", "1");
    correctZoomAnchor(true);
  }, [scale, renderScale, correctZoomAnchor]);

  // Trackpad pinch-to-zoom: a pinch gesture arrives as a wheel event with
  // ctrlKey set. Handle it non-passively so we can preventDefault (otherwise the
  // browser zooms the whole page) and drive the PDF scale instead.
  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return; // ordinary scroll → let it through
      e.preventDefault();
      const pageSize = bodyRef.current?.clientHeight ?? 800;
      const normalizedDelta = Math.max(
        -120,
        Math.min(
          120,
          e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? pageSize : 1)
        )
      );
      const factor = Math.exp(-normalizedDelta * 0.003);
      zoomTo(
        scaleRef.current * factor,
        { x: e.clientX, y: e.clientY },
        "pinch"
      );
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [zoomTo]);

  return {
    bodyRef,
    scaleRef,
    manualZoomRef,
    pagesEl,
    pagesInnerEl,
    bindPages,
    bindPagesInner,
    zoomTo,
  };
}
