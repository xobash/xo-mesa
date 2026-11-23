import { memo, useEffect, useState, type CSSProperties, type ReactNode } from "react";
import type { Box, Fill, RenderShape, RenderSlide, TextBodyRef } from "../lib/pptx/pptxRender";
import type { RenderParagraph, RenderText } from "../lib/pptx/pptxText";

// Positioned HTML for one slide render model. Coordinates are EMU scaled to
// CSS pixels (9525 EMU per pixel at 96 dpi), then the whole slide is scaled
// to the requested width. All text goes through React (escaped); images are
// blob URLs of package parts only.

const EMU_PER_PX = 9525;
export const SLIDE_THUMB_WIDTH = 168;
const MAIN_SLIDE_MAX_WIDTH = 1280;

/** Width for the main slide. A callback ref, because the pane mounts only after
 *  the deck loads: an observer attached on the first render never saw it. */
export function useMainSlideWidth(): [(el: HTMLDivElement | null) => void, number] {
  const [el, setEl] = useState<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(720);
  useEffect(() => {
    if (!el || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => setWidth(Math.max(240, Math.min(MAIN_SLIDE_MAX_WIDTH, Math.floor(entry.contentRect.width) - 32))));
    observer.observe(el);
    return () => observer.disconnect();
  }, [el]);
  return [setEl, width];
}
const px = (emu: number) => emu / EMU_PER_PX;
/** Hundredths of a point → CSS pixels. */
const fontPx = (size: number) => size / 75;

export type ImageUrl = (part: string) => string | null;

function boxStyle(box: Box): CSSProperties {
  const flips = `${box.flipH ? " scaleX(-1)" : ""}${box.flipV ? " scaleY(-1)" : ""}`;
  return {
    left: px(box.x), top: px(box.y), width: px(box.w), height: px(box.h),
    transform: box.rot || flips ? `rotate(${box.rot}deg)${flips}` : undefined,
  };
}

function fillStyle(fill: Fill, imageUrl: ImageUrl): CSSProperties {
  if (!fill) return {};
  if ("color" in fill) return { background: fill.color };
  const url = imageUrl(fill.image);
  return url ? { backgroundImage: `url("${url}")`, backgroundSize: "100% 100%" } : {};
}

function paragraph(p: RenderParagraph, key: number): ReactNode {
  const firstSize = p.runs[0]?.size ?? p.emptySize;
  const style: CSSProperties = {
    textAlign: p.align, marginLeft: px(p.marginLeft), textIndent: px(p.indent),
    fontSize: fontPx(firstSize), minHeight: fontPx(p.emptySize) * 1.2,
  };
  return (
    <p key={key} className="pptx-para" style={style}>
      {p.bullet && <span className="pptx-bullet" style={{ color: p.bullet.color ?? undefined }}>{p.bullet.text}</span>}
      {p.runs.map((r, i) => r.text === "\n" ? <br key={i} /> : (
        <span key={i} style={{
          fontSize: fontPx(r.size), fontWeight: r.bold ? 700 : undefined, fontStyle: r.italic ? "italic" : undefined,
          textDecoration: [r.underline && "underline", r.strike && "line-through"].filter(Boolean).join(" ") || undefined,
          color: r.color ?? undefined, fontFamily: r.font ? `"${r.font.replace(/["\\]/g, "")}", var(--font)` : undefined,
        }}>{r.text}</span>
      ))}
    </p>
  );
}

function textBlock(text: RenderText): ReactNode {
  const [l, t, r, b] = text.insets;
  return (
    <div className={`pptx-text pptx-anchor-${text.anchor}${text.wrap ? "" : " pptx-nowrap"}`}
      style={{ padding: `${px(t)}px ${px(r)}px ${px(b)}px ${px(l)}px` }}>
      <div>{text.paragraphs.map(paragraph)}</div>
    </div>
  );
}

const sameBody = (a: TextBodyRef | null, b: TextBodyRef | null | undefined) => !!a && !!b && a.part === b.part && a.index === b.index;

function shapeNode(shape: RenderShape, imageUrl: ImageUrl, selected: TextBodyRef | null | undefined, onSelect?: (shape: RenderShape) => void): ReactNode {
  const style = boxStyle(shape.box);
  if (shape.kind === "shape") {
    const pick = onSelect && shape.body ? () => onSelect(shape) : undefined;
    return (
      <div key={shape.key} className={`pptx-shape pptx-geom-${shape.geometry}${pick ? " is-editable" : ""}${sameBody(shape.body, selected) ? " is-selected" : ""}`}
        title={shape.geometry === "other" ? `Shape drawn as a box (${shape.geometryName})` : undefined}
        style={{ ...style, ...fillStyle(shape.fill, imageUrl), border: shape.line ? `${Math.max(1, px(shape.line.width))}px solid ${shape.line.color}` : undefined }}
        onClick={pick}>
        {shape.text && textBlock(shape.text)}
      </div>
    );
  }
  if (shape.kind === "picture") {
    const url = shape.image ? imageUrl(shape.image) : null;
    return (
      <div key={shape.key} className={`pptx-picture${url ? "" : " pptx-missing"}`} style={style}>
        {url && <img src={url} alt="" draggable={false} loading="lazy" decoding="async" />}
        {shape.label && <span className="pptx-label">{shape.label}</span>}
      </div>
    );
  }
  if (shape.kind === "line") {
    const w = Math.max(1, px(shape.box.w)); const h = Math.max(1, px(shape.box.h));
    const [x1, x2] = shape.box.flipH ? [w, 0] : [0, w];
    const [y1, y2] = shape.box.flipV ? [h, 0] : [0, h];
    return (
      <svg key={shape.key} className="pptx-line" style={{ ...style, transform: shape.box.rot ? `rotate(${shape.box.rot}deg)` : undefined, width: w, height: h }} viewBox={`0 0 ${w} ${h}`} aria-hidden="true">
        <line x1={x1} y1={y1} x2={x2} y2={y2} stroke={shape.color} strokeWidth={Math.max(1, px(shape.width))} />
      </svg>
    );
  }
  if (shape.kind === "table") {
    return (
      <div key={shape.key} className="pptx-table" style={style}>
        <table><tbody>{shape.rows.map((row, i) => <tr key={i}>{row.map((cell, j) => <td key={j}>{cell}</td>)}</tr>)}</tbody></table>
      </div>
    );
  }
  return <div key={shape.key} className="pptx-placeholder" style={style}><span className="pptx-label">{shape.label}</span></div>;
}

/** One slide scaled to `width` CSS pixels. */
export const PresentationSlide = memo(function PresentationSlide({ slide, width, imageUrl, selected, onSelect, label }: {
  slide: RenderSlide;
  width: number;
  imageUrl: ImageUrl;
  selected?: TextBodyRef | null;
  onSelect?: (shape: RenderShape) => void;
  label?: string;
}) {
  const naturalW = px(slide.width);
  const naturalH = px(slide.height);
  const scale = width / naturalW;
  return (
    <div className="pptx-slide-frame" style={{ width, height: naturalH * scale }} role="img" aria-label={label}>
      <div className="pptx-slide" style={{ width: naturalW, height: naturalH, transform: `scale(${scale})`, ...fillStyle(slide.background, imageUrl) }}>
        {slide.shapes.map((shape) => shapeNode(shape, imageUrl, selected, onSelect))}
        {slide.omitted > 0 && <div className="pptx-placeholder pptx-omitted"><span className="pptx-label">{slide.omitted} more shapes not shown</span></div>}
      </div>
    </div>
  );
});
