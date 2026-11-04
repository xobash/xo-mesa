import { useEffect, useMemo, useRef, useState } from "react";
import { forceCenter, forceCollide, forceLink, forceManyBody, forceSimulation, forceX, forceY, type SimulationNodeDatum } from "d3-force";
import type { MiniGraph as MiniGraphData, MiniGraphPalette } from "../lib/trayPopover";

interface Point extends SimulationNodeDatum { i: number; r: number; degree: number }

/** Settles fully before the first paint, so the mini graph opens still. */
const LAYOUT_TICKS = 300;
const PAD = 14;

/** Same node size as the real graph (`graphGeometry.nodeRadius`). */
const radius = (degree: number) => Math.min(24, 2.4 + 1.75 * Math.sqrt(degree));

/**
 * The real graph's default forces (link distance from node sizes plus the
 * default 250 setting, degree-scaled link strength, repel 10, centre 0.5),
 * run to rest once instead of animating.
 */
export function layoutMiniGraph(graph: MiniGraphData): Point[] {
  const points: Point[] = graph.nodes.map((n, i) => ({ i, r: radius(n.degree), degree: n.degree }));
  const links = graph.links.map(([source, target]) => ({ source, target }));
  forceSimulation(points)
    .force("link", forceLink<Point, { source: number | Point; target: number | Point }>(links)
      .distance((l) => (l.source as Point).r + (l.target as Point).r + 25)
      .strength((l) => 1 / Math.max(1, Math.min((l.source as Point).degree, (l.target as Point).degree))))
    .force("charge", forceManyBody().strength(-240).distanceMax(900))
    .force("center", forceCenter(0, 0).strength(0.05))
    .force("x", forceX(0).strength(0.02))
    .force("y", forceY(0).strength(0.02))
    .force("collide", forceCollide<Point>((p) => p.r + 6))
    .stop()
    .tick(LAYOUT_TICKS);
  return points;
}

export function MiniGraph({ graph, palette, onOpen }: { graph: MiniGraphData; palette: MiniGraphPalette; onOpen: (rel: string) => void }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [hover, setHover] = useState(-1);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const shape = graph.nodes.map((n) => n.id).join("\0") + "|" + graph.links.length;
  // eslint-disable-next-line react-hooks/exhaustive-deps -- relayout only when the graph's shape changes
  const points = useMemo(() => layoutMiniGraph(graph), [shape]);
  const view = useRef({ k: 1, x: 0, y: 0 });

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => setSize({ w: canvas.clientWidth, h: canvas.clientHeight }));
    observer.observe(canvas);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    const { w, h } = size;
    if (!canvas || !ctx || !w || !h) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of points) {
      minX = Math.min(minX, p.x! - p.r); maxX = Math.max(maxX, p.x! + p.r);
      minY = Math.min(minY, p.y! - p.r); maxY = Math.max(maxY, p.y! + p.r);
    }
    const k = points.length ? Math.min(1.6, (w - PAD * 2) / Math.max(1, maxX - minX), (h - PAD * 2) / Math.max(1, maxY - minY)) : 1;
    const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
    view.current = { k, x: w / 2 - cx * k, y: h / 2 - cy * k };
    ctx.setTransform(dpr * k, 0, 0, dpr * k, dpr * view.current.x, dpr * view.current.y);
    ctx.clearRect(minX - w, minY - h, (maxX - minX) + 2 * w, (maxY - minY) + 2 * h);
    if (!points.length) return;

    const glow = palette.glowRgb;
    // The real graph's quiet bloom behind the cluster.
    const spread = Math.max(maxX - minX, maxY - minY) / 2;
    const bloom = ctx.createRadialGradient(cx, cy, Math.max(4, spread * 0.12), cx, cy, spread * 1.25);
    bloom.addColorStop(0, `rgba(${glow},${(0.09 * palette.bloomAlpha).toFixed(3)})`);
    bloom.addColorStop(0.45, `rgba(${glow},${(0.035 * palette.bloomAlpha).toFixed(3)})`);
    bloom.addColorStop(1, `rgba(${glow},0)`);
    ctx.fillStyle = bloom;
    ctx.fillRect(cx - spread * 1.3, cy - spread * 1.3, spread * 2.6, spread * 2.6);

    const near = new Set<number>();
    if (hover >= 0) for (const [s, t] of graph.links) if (s === hover || t === hover) { near.add(s); near.add(t); }
    ctx.lineWidth = 0.8 / Math.max(k, 0.4);
    ctx.strokeStyle = palette.link;
    ctx.beginPath();
    for (const [s, t] of graph.links) {
      if (near.has(s) && near.has(t) && (s === hover || t === hover)) continue;
      ctx.moveTo(points[s].x!, points[s].y!);
      ctx.lineTo(points[t].x!, points[t].y!);
    }
    ctx.stroke();
    if (hover >= 0) {
      ctx.strokeStyle = `rgba(${glow},0.55)`;
      ctx.beginPath();
      for (const [s, t] of graph.links) {
        if (s !== hover && t !== hover) continue;
        ctx.moveTo(points[s].x!, points[s].y!);
        ctx.lineTo(points[t].x!, points[t].y!);
      }
      ctx.stroke();
    }
    // Fitting a whole vault shrinks leaf nodes below a pixel; keep them visible.
    const minR = 1.7 / k;
    for (const p of points) {
      const r = Math.max(p.r, minR);
      const active = p.i === graph.active;
      if (active) {
        const halo = ctx.createRadialGradient(p.x!, p.y!, r, p.x!, p.y!, r + 11);
        halo.addColorStop(0, `rgba(${glow},0.3)`);
        halo.addColorStop(1, `rgba(${glow},0)`);
        ctx.fillStyle = halo;
        ctx.beginPath();
        ctx.arc(p.x!, p.y!, r + 14, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = hover >= 0 && !near.has(p.i) && p.i !== hover && !active ? 0.45 : 1;
      ctx.fillStyle = active ? palette.nodeActive : p.degree > 0 ? palette.node : palette.nodeIsolated;
      ctx.beginPath();
      ctx.arc(p.x!, p.y!, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
      if (p.i === hover) {
        ctx.strokeStyle = `rgba(${glow},0.6)`;
        ctx.lineWidth = 1.4 / k;
        ctx.beginPath();
        ctx.arc(p.x!, p.y!, r + 3 / k, 0, Math.PI * 2);
        ctx.stroke();
      }
    }
  }, [points, graph.links, graph.active, hover, palette, size]);

  const nearest = (event: React.PointerEvent | React.MouseEvent): number => {
    const rect = canvasRef.current!.getBoundingClientRect();
    const { k, x, y } = view.current;
    const mx = (event.clientX - rect.left - x) / k, my = (event.clientY - rect.top - y) / k;
    let best = -1, bestD = Infinity;
    for (const p of points) {
      const d = Math.hypot(p.x! - mx, p.y! - my) - p.r;
      if (d < bestD) { bestD = d; best = p.i; }
    }
    return bestD * k <= 6 ? best : -1;
  };

  const label = hover >= 0 ? graph.nodes[hover]?.title : null;
  return (
    <div className="tp-graph">
      <canvas
        ref={canvasRef}
        className="tp-graph-canvas"
        role="img"
        aria-label={`Graph of ${graph.nodes.length} of ${graph.total} files`}
        onPointerMove={(e) => setHover(nearest(e))}
        onPointerLeave={() => setHover(-1)}
        onClick={(e) => { const i = nearest(e); if (i >= 0) onOpen(graph.nodes[i].id); }}
      />
      <div className="tp-graph-caption">
        {label ?? (graph.pending ? "Indexing…" : graph.total > graph.nodes.length ? `${graph.nodes.length} of ${graph.total} files` : `${graph.total} files`)}
      </div>
    </div>
  );
}
