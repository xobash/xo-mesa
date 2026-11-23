// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { GlLinkRenderer, parseCssColor, type GlLinkFrame } from "./graphLinkGl";

afterEach(() => vi.restoreAllMocks());

function fakeGl() {
  const calls = { ends: new Int32Array(0), endUploads: 0, texels: new Float32Array(0), nodeUploads: 0, drawn: 0, drawScale: 0, scale: [0, 0], offset: [0, 0], color: [0, 0, 0, 0], clears: 0 };
  const noop = () => {};
  const gl: Record<string, unknown> = {
    VERTEX_SHADER: 1, FRAGMENT_SHADER: 2, COMPILE_STATUS: 3, LINK_STATUS: 4, ARRAY_BUFFER: 5, STATIC_DRAW: 6, INT: 7, FLOAT: 8, COLOR_BUFFER_BIT: 9, BLEND: 10, ONE: 11, ONE_MINUS_SRC_ALPHA: 12, LINES: 13,
    TEXTURE_2D: 14, TEXTURE_MIN_FILTER: 15, TEXTURE_MAG_FILTER: 16, NEAREST: 17, RGBA32F: 18, RGBA: 19, TEXTURE0: 20,
    createShader: () => ({}), shaderSource: noop, compileShader: noop, getShaderParameter: () => true,
    createProgram: () => ({}), attachShader: noop, linkProgram: noop, getProgramParameter: () => true,
    createVertexArray: () => ({}), bindVertexArray: noop, createBuffer: () => ({}), createTexture: () => ({}), bindTexture: noop, texParameteri: noop, activeTexture: noop,
    getAttribLocation: () => 0, enableVertexAttribArray: noop, vertexAttribIPointer: noop, getUniformLocation: (_p: unknown, name: string) => name,
    viewport: noop, clearColor: noop, clear: () => { calls.clears++; }, useProgram: noop, bindBuffer: noop, enable: noop, blendFunc: noop,
    bufferData: (_t: number, data: Int32Array) => { calls.ends = data.slice(); calls.endUploads++; },
    texImage2D: (...a: unknown[]) => { calls.texels = (a[8] as Float32Array).slice(); calls.nodeUploads++; },
    texSubImage2D: (...a: unknown[]) => { calls.texels = (a[8] as Float32Array).slice(); calls.nodeUploads++; },
    uniform1i: noop, uniform1f: (_n: string, v: number) => { calls.drawScale = v; },
    uniform2f: (name: string, a: number, b: number) => { if (name === "u_scale") calls.scale = [a, b]; else calls.offset = [a, b]; },
    uniform4f: (_n: string, ...c: number[]) => { calls.color = c; },
    drawArrays: (_mode: number, _first: number, count: number) => { calls.drawn = count; },
    getExtension: () => null,
  };
  return { gl, calls };
}

it("uploads node-index pairs once and node centres on movement; pan and zoom are uniforms", () => {
  const { gl, calls } = fakeGl();
  const glCanvas = document.createElement("canvas");
  vi.spyOn(glCanvas, "getContext").mockReturnValue(gl as never);
  const target = document.createElement("canvas");
  target.width = 200; target.height = 100; target.style.width = "100px"; target.style.height = "50px";
  const renderer = new GlLinkRenderer(() => glCanvas);
  expect(renderer.ready()).toBe(true);
  const f64 = (xs: number[]) => Float64Array.from(xs);
  const skipNodes = Uint8Array.from([0, 0, 0, 1]);
  const frame: GlLinkFrame = {
    s: Int32Array.from([0, 1, 2, -1]), t: Int32Array.from([1, 2, 3, 0]), count: 4,
    x: f64([0, 10, 3, NaN]), y: f64([0, 20, 3, 0]), base: f64([4, 5, 6, 7]), nodeCount: 4, drawScale: 0.5,
    skipNodes, skipKey: "n3", moved: true, linksChanged: true,
    k: 2, panX: 5, panY: 10, dpr: 2, color: "rgba(150, 158, 164, 0.5)", alpha: 0.5,
  };
  expect(renderer.draw(target, frame)).toBe(true);
  // Link 2 touches highlighted node 3; link 3 has an undrawn end. Each link is two vertices.
  expect([...calls.ends]).toEqual([0, 1, 1, 0, 1, 2, 2, 1]);
  expect(calls.drawn).toBe(4);
  // Node 3 has no finite position: radius -1 hides its links in the shader.
  expect([...calls.texels.slice(0, 16)]).toEqual([0, 0, 4, 0, 10, 20, 5, 0, 3, 3, 6, 0, 0, 0, -1, 0]);
  expect([glCanvas.width, glCanvas.height, glCanvas.style.width]).toEqual([200, 100, "100px"]);
  // World (0, 0) lands at device (dpr * pan) = (10, 20): clip (-0.9, -0.6).
  expect(calls.scale).toEqual([2 * 2 * 2 / 200, 2 * 2 * 2 / 100]);
  expect(calls.offset[0]).toBeCloseTo(-0.9);
  expect(calls.offset[1]).toBeCloseTo(-0.6);
  expect(calls.drawScale).toBe(0.5);
  expect(calls.color.map((c) => +c.toFixed(4))).toEqual([+(150 / 255 * 0.25).toFixed(4), +(158 / 255 * 0.25).toFixed(4), +(164 / 255 * 0.25).toFixed(4), 0.25]);
  // Pan and zoom with nothing moved upload nothing.
  renderer.draw(target, { ...frame, moved: false, linksChanged: false, panX: 50, drawScale: 0.25 });
  expect([calls.endUploads, calls.nodeUploads]).toEqual([1, 1]);
  expect(calls.drawScale).toBe(0.25);
  // Moved nodes upload only the node texture.
  renderer.draw(target, { ...frame, moved: true, linksChanged: false });
  expect([calls.endUploads, calls.nodeUploads]).toEqual([1, 2]);
  // A different highlight rebuilds only the pairs.
  renderer.draw(target, { ...frame, moved: false, linksChanged: false, skipNodes: null, skipKey: "" });
  expect([calls.endUploads, calls.nodeUploads]).toEqual([2, 2]);
  expect(calls.drawn).toBe(6);
  const before = calls.clears;
  renderer.clear();
  expect(calls.clears).toBe(before + 1);
});

it("reports no WebGL2 so the 2D canvas draws the links", () => {
  const glCanvas = document.createElement("canvas");
  vi.spyOn(glCanvas, "getContext").mockReturnValue(null);
  expect(new GlLinkRenderer(() => glCanvas).ready()).toBe(false);
  expect(parseCssColor("#ff0000", 1)).toEqual([1, 0, 0, 1]);
  expect(parseCssColor("var(--x)", 1)).toBeNull();
});
