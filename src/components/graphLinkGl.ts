/**
 * WebGL2 drawing of a heavy graph's plain links (draw batch 1), behind the 2D
 * canvas. WebKit's 2D canvas costs 26 to 40 ms to stroke 92,775 links, so a
 * 10,000-note graph dragged at 19 to 22 fps and panned at 33 fps in Safari
 * 27.2 (Measured, `tmp/qa/graphbench`, real GraphView). Owner sign-off
 * 2026-11-19: links of graphs with `LINK_LAYER_MIN_LINKS` or more links draw
 * here; where two links cross, the crossing is slightly darker, as in
 * Obsidian's WebGL graph. Highlighted and active links, nodes and labels stay
 * on the 2D canvas above. Non-default link thickness, arrows and a missing
 * WebGL2 context use the 2D link layer instead; living motion keeps these
 * nodes in place, so it uses this path too.
 *
 * The link buffer holds only node-index pairs and changes with the links or
 * the excluded (highlighted) links. Node centres, layout radii and pulse
 * phases go to a float texture each time nodes move (10,000 x 4 floats); the
 * shader trims each line to the two drawn circle edges, living-motion pulse
 * included (`pulsedRadius`), so pan, zoom, dimming and the pulse are uniforms.
 */
import { clamp } from "../lib/clamp";

const VERTEX = `#version 300 es
in ivec2 a_ends;
uniform highp sampler2D u_nodes;
uniform int u_width;
uniform vec2 u_scale;
uniform vec2 u_offset;
uniform float u_draw;
// Living-motion pulse: x = angle (one turn), y = amplitude (0 when off).
uniform vec2 u_pulse;
vec4 node(int i) { return texelFetch(u_nodes, ivec2(i % u_width, i / u_width), 0); }
// The node's drawn radius, as graphLinkGeometry.pulsedRadius computes it.
float drawn(vec4 n) { return n.z * u_draw * (1.0 + sin(u_pulse.x + n.w) * u_pulse.y); }
void main() {
  vec4 a = node(a_ends.x);
  vec4 b = node(a_ends.y);
  // z < 0 marks a node without a finite position: both ends leave the view.
  if (a.z < 0.0 || b.z < 0.0) { gl_Position = vec4(2.0, 2.0, 0.0, 1.0); return; }
  vec2 d = b.xy - a.xy;
  float len = length(d);
  float r = drawn(a);
  // A link too short to show collapses both ends onto its midpoint.
  vec2 w = len > r + drawn(b) ? a.xy + d / len * r : (a.xy + b.xy) * 0.5;
  vec2 p = w * u_scale + u_offset;
  gl_Position = vec4(p.x, -p.y, 0.0, 1.0);
}`;

const FRAGMENT = `#version 300 es
precision mediump float;
uniform vec4 u_color;
out vec4 color;
void main() { color = u_color; }`;

/** Premultiplied RGBA in 0..1 from a hex or rgb(a) CSS colour. */
export function parseCssColor(color: string, alpha: number): [number, number, number, number] | null {
  const m = /^#([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i.exec(color.trim());
  let r: number, g: number, b: number, a = 1;
  if (m) {
    r = parseInt(m[1], 16); g = parseInt(m[2], 16); b = parseInt(m[3], 16);
  } else {
    const rgba = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/i.exec(color.trim());
    if (!rgba) return null;
    r = +rgba[1]; g = +rgba[2]; b = +rgba[3]; a = rgba[4] === undefined ? 1 : +rgba[4];
  }
  const k = clamp(a * alpha, 0, 1);
  return [(r / 255) * k, (g / 255) * k, (b / 255) * k, k];
}

/** Texture width: rows of up to this many nodes. */
const TEXTURE_WIDTH = 2048;

export interface GlLinkFrame {
  /** Node index of each link's ends (-1: not drawn). */
  s: Int32Array; t: Int32Array;
  count: number;
  /** Node centres, layout radii and pulse phases (`renderPhase`). */
  x: Float64Array; y: Float64Array; base: Float64Array; phase: Float64Array;
  nodeCount: number;
  /** Drawn radius per layout radius at this zoom (`nodeDrawScale`). */
  drawScale: number;
  /** Living-motion pulse angle (`pulseAngle`) and amplitude; 0 amplitude when off. */
  pulseAngle: number; pulseAmp: number;
  /** Per node, 1 when its links draw elsewhere (highlighted or active); null when none do. */
  skipNodes: Uint8Array | null;
  /** Identifies `skipNodes`; a change rebuilds the link buffer. */
  skipKey: string;
  /** Node centres or layout radii changed (re-upload the node texture). */
  moved: boolean;
  /** The link array changed (rebuild the link buffer). */
  linksChanged: boolean;
  /** Zoom and pan (CSS px) and device pixel ratio. */
  k: number; panX: number; panY: number; dpr: number;
  color: string;
  alpha: number;
}

type Uniforms = Record<"scale" | "offset" | "color" | "draw" | "pulse" | "width" | "nodes", WebGLUniformLocation | null>;

export class GlLinkRenderer {
  private gl: WebGL2RenderingContext | null = null;
  private failed = false;
  private program: WebGLProgram | null = null;
  private vao: WebGLVertexArrayObject | null = null;
  private buffer: WebGLBuffer | null = null;
  private texture: WebGLTexture | null = null;
  private uniforms: Uniforms | null = null;
  private ends = new Int32Array(0);
  private texels = new Float32Array(0);
  private textureRows = 0;
  private vertexCount = 0;
  private drawn = false;
  private skipKey: string | null = null;
  private links: unknown = null;

  constructor(private readonly canvas: () => HTMLCanvasElement | null) {}

  private init(): WebGL2RenderingContext | null {
    if (this.gl || this.failed) return this.gl;
    const canvas = this.canvas();
    const gl = canvas?.getContext("webgl2", { antialias: true, alpha: true, premultipliedAlpha: true, depth: false, stencil: false, preserveDrawingBuffer: false }) as WebGL2RenderingContext | null | undefined;
    if (!gl || typeof gl.createShader !== "function" || typeof gl.createVertexArray !== "function") { this.failed = true; return null; }
    const shader = (type: number, source: string) => {
      const s = gl.createShader(type);
      if (!s) return null;
      gl.shaderSource(s, source);
      gl.compileShader(s);
      return gl.getShaderParameter(s, gl.COMPILE_STATUS) ? s : null;
    };
    const vs = shader(gl.VERTEX_SHADER, VERTEX), fs = shader(gl.FRAGMENT_SHADER, FRAGMENT);
    const program = gl.createProgram();
    if (!vs || !fs || !program) { this.failed = true; return null; }
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) { this.failed = true; return null; }
    this.program = program;
    this.vao = gl.createVertexArray();
    this.buffer = gl.createBuffer();
    this.texture = gl.createTexture();
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
    const loc = gl.getAttribLocation(program, "a_ends");
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribIPointer(loc, 2, gl.INT, 0, 0);
    gl.bindVertexArray(null);
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    this.uniforms = {
      scale: gl.getUniformLocation(program, "u_scale"),
      offset: gl.getUniformLocation(program, "u_offset"),
      color: gl.getUniformLocation(program, "u_color"),
      draw: gl.getUniformLocation(program, "u_draw"),
      pulse: gl.getUniformLocation(program, "u_pulse"),
      width: gl.getUniformLocation(program, "u_width"),
      nodes: gl.getUniformLocation(program, "u_nodes"),
    };
    this.gl = gl;
    return gl;
  }

  /** True when `links` is not the array the previous frame drew. */
  linksChanged(links: unknown): boolean {
    const changed = links !== this.links;
    this.links = links;
    return changed;
  }

  /** True when a WebGL2 context exists or could be created for the links canvas. */
  ready(): boolean {
    return this.init() !== null;
  }

  private uploadEnds(gl: WebGL2RenderingContext, frame: GlLinkFrame): void {
    if (this.ends.length < frame.count * 4) this.ends = new Int32Array(frame.count * 4);
    const e = this.ends, { s, t, skipNodes } = frame;
    let n = 0;
    for (let i = 0; i < frame.count; i++) {
      const a = s[i], b = t[i];
      if (a < 0 || b < 0 || (skipNodes !== null && (skipNodes[a] === 1 || skipNodes[b] === 1))) continue;
      e[n++] = a; e[n++] = b; e[n++] = b; e[n++] = a;
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
    gl.bufferData(gl.ARRAY_BUFFER, e.subarray(0, n), gl.STATIC_DRAW);
    this.vertexCount = n / 2;
  }

  private uploadNodes(gl: WebGL2RenderingContext, frame: GlLinkFrame): void {
    const rows = Math.max(1, Math.ceil(frame.nodeCount / TEXTURE_WIDTH));
    const size = rows * TEXTURE_WIDTH * 4;
    if (this.texels.length < size) this.texels = new Float32Array(size);
    const v = this.texels, { x, y, base, phase } = frame;
    for (let i = 0; i < frame.nodeCount; i++) {
      const fine = Number.isFinite(x[i]) && Number.isFinite(y[i]);
      v[i * 4] = fine ? x[i] : 0; v[i * 4 + 1] = fine ? y[i] : 0; v[i * 4 + 2] = fine ? base[i] : -1; v[i * 4 + 3] = phase[i];
    }
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    if (rows !== this.textureRows) {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, TEXTURE_WIDTH, rows, 0, gl.RGBA, gl.FLOAT, v.subarray(0, size));
      this.textureRows = rows;
    } else {
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, TEXTURE_WIDTH, rows, gl.RGBA, gl.FLOAT, v.subarray(0, size));
    }
  }

  /** Draw the plain links; false when WebGL2 is unavailable (the caller draws them in 2D). */
  draw(target: HTMLCanvasElement, frame: GlLinkFrame): boolean {
    const gl = this.init();
    const canvas = this.canvas();
    const color = parseCssColor(frame.color, frame.alpha);
    if (!gl || !canvas || !color || !this.program || !this.uniforms) return false;
    // Same backing store and box as the 2D canvas it sits under.
    if (canvas.width !== target.width || canvas.height !== target.height) { canvas.width = target.width; canvas.height = target.height; }
    if (canvas.style.width !== target.style.width) canvas.style.width = target.style.width;
    if (canvas.style.height !== target.style.height) canvas.style.height = target.style.height;
    if (!this.drawn || frame.linksChanged || frame.skipKey !== this.skipKey) {
      this.uploadEnds(gl, frame);
      this.skipKey = frame.skipKey;
    }
    if (!this.drawn || frame.moved || frame.linksChanged) this.uploadNodes(gl, frame);
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(this.program);
    gl.bindVertexArray(this.vao);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.uniform1i(this.uniforms.nodes, 0);
    gl.uniform1i(this.uniforms.width, TEXTURE_WIDTH);
    gl.uniform1f(this.uniforms.draw, frame.drawScale);
    gl.uniform2f(this.uniforms.pulse, frame.pulseAngle, frame.pulseAmp);
    // Device px = dpr * (k * world + pan); clip = device / size * 2 - 1.
    gl.uniform2f(this.uniforms.scale, (2 * frame.dpr * frame.k) / canvas.width, (2 * frame.dpr * frame.k) / canvas.height);
    gl.uniform2f(this.uniforms.offset, (2 * frame.dpr * frame.panX) / canvas.width - 1, (2 * frame.dpr * frame.panY) / canvas.height - 1);
    gl.uniform4f(this.uniforms.color, color[0], color[1], color[2], color[3]);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.drawArrays(gl.LINES, 0, this.vertexCount);
    gl.bindVertexArray(null);
    this.drawn = true;
    return true;
  }

  /** Clear any links this renderer drew (the 2D canvas draws them now). */
  clear(): void {
    if (!this.drawn || !this.gl) return;
    this.gl.clearColor(0, 0, 0, 0);
    this.gl.clear(this.gl.COLOR_BUFFER_BIT);
    this.drawn = false;
    this.skipKey = null;
  }

  /** Give the GPU context back (unmount). */
  release(): void {
    this.gl?.getExtension("WEBGL_lose_context")?.loseContext();
    this.gl = null;
    this.drawn = false;
    this.skipKey = null;
    this.textureRows = 0;
  }
}
