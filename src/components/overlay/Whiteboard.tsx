import { useEffect, useMemo, useRef, useState } from "react";
import { confirmAction } from "../../lib/confirmAction";
import { canvasBackingScale, currentDevicePixelRatio, onDevicePixelRatioChange } from "../../lib/devicePixelRatio";
import { parseBoardDocument, type BoardDocument } from "../../lib/overlayDraft";
import { useAppStore } from "../../store";
import { useOverlayDraft } from "../useOverlayDraft";

const WHITEBOARD_KEY = "mesa:whiteboard";
/** Whiteboard bitmap ceiling (32 MiB of RGBA) when scaling for the display. */
const WHITEBOARD_MAX_PIXELS = 8 * 1024 * 1024;

/** Overlay whiteboard; a vault switch remounts the draft. */
export function Whiteboard() {
  const identity = useAppStore(s => `${s.vaultPath}\0${s.getVaultGeneration()}`);
  return <WhiteboardDocument key={identity} />;
}

function WhiteboardDocument() {
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const draft = useOverlayDraft("whiteboard", "Whiteboard/Board.mesa-board.json", WHITEBOARD_KEY);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const active = useRef<{ color: string; points: Array<[number, number]> } | null>(null);
  const paintGeneration = useRef(0);
  const pixelScale = useRef(1);
  const [color, setColor] = useState("#e0a948");
  const { board, parseError } = useMemo((): { board: BoardDocument; parseError: string } => {
    try { return { board: parseBoardDocument(draft.content), parseError: "" }; }
    catch (error) { return { board: { version: 1, strokes: [] }, parseError: String(error) }; }
  }, [draft.content]);
  const boardRef = useRef(board);
  boardRef.current = board;
  const paint = () => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    const generation = ++paintGeneration.current;
    // Strokes are stored in CSS pixels; the bitmap is larger by `pixelScale`.
    const reset = () => {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.setTransform(pixelScale.current, 0, 0, pixelScale.current, 0, 0);
    };
    const draw = () => {
      if (generation !== paintGeneration.current) return;
      for (const stroke of [...boardRef.current.strokes, ...(active.current ? [active.current] : [])]) {
        if (!stroke.points.length) continue;
        ctx.beginPath(); ctx.moveTo(...stroke.points[0]);
        for (const point of stroke.points.slice(1)) ctx.lineTo(...point);
        ctx.strokeStyle = stroke.color; ctx.lineWidth = 2.5; ctx.lineCap = "round"; ctx.lineJoin = "round"; ctx.stroke();
      }
    };
    reset();
    const background = boardRef.current.background;
    if (!background) { draw(); return; }
    const image = new Image();
    image.onload = () => {
      if (generation !== paintGeneration.current) return;
      reset(); ctx.drawImage(image, 0, 0); draw();
    };
    image.src = background;
  };
  useEffect(() => {
    const canvas = canvasRef.current!;
    const generationRef = paintGeneration;
    const resize = () => {
      const width = Math.max(canvas.parentElement!.clientWidth, 1);
      const height = Math.max(canvas.parentElement!.clientHeight, 1);
      const scale = canvasBackingScale(width, height, currentDevicePixelRatio(), WHITEBOARD_MAX_PIXELS);
      pixelScale.current = scale;
      canvas.width = Math.floor(width * scale);
      canvas.height = Math.floor(height * scale);
      paint();
    };
    resize();
    const observer = new ResizeObserver(resize); observer.observe(canvas.parentElement!);
    const stopRatio = onDevicePixelRatioChange(resize);
    return () => { observer.disconnect(); stopRatio(); ++generationRef.current; };
  }, []);
  useEffect(() => { paint(); }, [draft.content]);
  const at = (e: React.PointerEvent): [number, number] => {
    const r = canvasRef.current!.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top];
  };
  const down = (e: React.PointerEvent) => {
    if (e.button !== 0 || parseError) return;
    // Mark dirty on pointer-down, before any pending initial read can arrive.
    active.current = { color, points: [at(e)] };
    draft.edit(JSON.stringify(boardRef.current));
    e.currentTarget.setPointerCapture?.(e.pointerId);
  };
  const move = (e: React.PointerEvent) => {
    if (!active.current) return;
    active.current.points.push(at(e)); paint();
  };
  const up = () => {
    if (!active.current) return;
    const next = { ...boardRef.current, strokes: [...boardRef.current.strokes, active.current] };
    active.current = null; boardRef.current = next; draft.edit(JSON.stringify(next));
  };
  // Closing or switching vaults can unmount the canvas before pointer-up.
  // Retain that final partial stroke in the originating local draft.
  const finishStroke = useRef(up);
  finishStroke.current = up;
  useEffect(() => () => finishStroke.current(), []);
  const clear = async () => {
    if (parseError) return;
    const before = boardRef.current;
    const root = useAppStore.getState().vaultPath;
    const generation = useAppStore.getState().getVaultGeneration();
    if (!(await confirmAction("Clear this whiteboard draft? The saved vault document remains available until you save again.", { okLabel: "Clear draft" }))) return;
    if (!mounted.current || active.current || boardRef.current !== before || useAppStore.getState().vaultPath !== root || useAppStore.getState().getVaultGeneration() !== generation) return;
    active.current = null; ++paintGeneration.current;
    draft.edit(JSON.stringify({ version: 1, strokes: [] }));
  };
  const COLORS = ["#e0a948", "#7259cc", "#3cae8b", "#ff6b6b", "#cfd6e6"];
  return <div className="ov-board">
    <div className="ov-board-bar">
      {COLORS.map(c => <button key={c} className={"ov-swatch" + (color === c ? " on" : "")}
        style={{ background: c }} onClick={() => setColor(c)} aria-label={"Pen " + c} />)}
      <button className="btn ghost" disabled={!!parseError || board.strokes.length === 0} onClick={() => { active.current = null; draft.edit(JSON.stringify({ ...boardRef.current, strokes: boardRef.current.strokes.slice(0, -1) })); }}>Undo stroke</button>
      <button className="btn ghost" onClick={clear} disabled={!!parseError}>Clear</button>
      <button className="btn ghost ov-save-vault" disabled={!draft.ready || draft.saving || !draft.root || !!parseError}
        onClick={() => { up(); void draft.save(); }}>{draft.saving ? "Saving…" : "Save editable board"}</button>
    </div>
    {draft.status && <p className="ov-vault-status" role="status">{draft.status}</p>}
    {(draft.error || parseError) && <p className="ov-local-warn" role="alert">{draft.error || parseError}</p>}
    <div className="ov-board-canvas"><canvas aria-label="Whiteboard drawing" ref={canvasRef}
      onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up} onLostPointerCapture={up} /></div>
  </div>;
}
