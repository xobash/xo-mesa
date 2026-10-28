// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type React from 'react';

const io = vi.hoisted(() => ({ inTauri: true, store: {} as Record<string, ReturnType<typeof vi.fn> | unknown> }));
vi.mock('../lib/vault', () => ({ get IN_TAURI() { return io.inTauri; } }));
vi.mock('../store', () => ({ getStore: () => io.store }));
import { startViewDrag } from './panelDrag';
import { startFileDrag } from './fileDrag';

const W = 1024, H = 768;
function rect(el: Element, r: { left: number; top: number; width: number; height: number }) {
  el.getBoundingClientRect = () => ({ ...r, x: r.left, y: r.top, right: r.left + r.width, bottom: r.top + r.height, toJSON: () => r }) as DOMRect;
}
function press(target: HTMLElement, x = 100, y = 100, button = 0) {
  return { button, clientX: x, clientY: y, pointerId: 1, currentTarget: target, preventDefault: vi.fn(), stopPropagation: vi.fn() } as unknown as React.PointerEvent;
}
const pointer = (type: string, x: number, y: number) =>
  window.dispatchEvent(new MouseEvent(type, { clientX: x, clientY: y, screenX: x + 1000, screenY: y + 500 }));

let handle: HTMLElement;
beforeEach(() => {
  io.inTauri = true;
  io.store = {
    setDragGhost: vi.fn(), setDragView: vi.fn(), setDraggingFile: vi.fn(), dropViewInCenter: vi.fn(), dropViewAt: vi.fn(),
    openDocWindow: vi.fn(async () => {}), openAgentWindow: vi.fn(async () => {}), openPanelWindow: vi.fn(async () => {}),
    removeViewFromWorkspace: vi.fn(), openFileInRegion: vi.fn(async () => {}), selectFile: vi.fn(async () => {}),
    docSplit: { active: 'doc', other: 'Other.md' }, activePath: 'Active.md', settings: { rightStack: ['graph', 'tasks'] },
  };
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: W });
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: H });
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { cb(0); return 0; });
  document.body.innerHTML = `
    <div data-region="center"></div>
    <div data-region="right"><div class="stack-pane" data-stack-index="0"><span id="h"></span></div><div data-stack-index="1"></div></div>`;
  rect(document.querySelector("[data-region='center']")!, { left: 0, top: 0, width: 600, height: H });
  rect(document.querySelector("[data-region='right']")!, { left: 600, top: 0, width: 424, height: H });
  const panes = document.querySelectorAll('[data-stack-index]');
  rect(panes[0], { left: 600, top: 0, width: 424, height: 400 });
  rect(panes[1], { left: 600, top: 400, width: 424, height: 368 });
  handle = document.getElementById('h')!;
  handle.setPointerCapture = vi.fn();
});
afterEach(() => { vi.unstubAllGlobals(); document.body.className = ''; });
const s = () => io.store as Record<string, ReturnType<typeof vi.fn>>;

describe('startViewDrag', () => {
  it('ignores non-primary buttons', () => {
    const e = press(handle, 100, 100, 2);
    startViewDrag('graph', 'stack', e);
    expect(e.preventDefault).not.toHaveBeenCalled();
    expect(document.body.classList.contains('is-dragging')).toBe(false);
  });

  it('treats a release within the drag threshold as a click', () => {
    const click = vi.fn();
    startViewDrag('graph', 'handle', press(handle), click);
    expect(document.body.classList.contains('is-dragging')).toBe(true);
    pointer('pointermove', 103, 102);
    pointer('pointerup', 103, 102);
    expect(click).toHaveBeenCalledOnce();
    expect(s().setDragView).toHaveBeenLastCalledWith(null);
    expect(document.body.classList.contains('is-dragging')).toBe(false);
    expect(s().setDragGhost).toHaveBeenLastCalledWith(null);
  });

  it('drops into the center region', () => {
    startViewDrag('graph', 'stack', press(handle));
    pointer('pointermove', 300, 300);
    expect(s().setDragView).toHaveBeenCalledWith({ view: 'graph', from: 'stack' });
    expect(s().setDragGhost).toHaveBeenCalledWith({ kind: 'view', label: 'Graph', x: 300, y: 300 });
    pointer('pointerup', 300, 300);
    expect(s().dropViewInCenter).toHaveBeenCalledOnce();
  });

  it('inserts into the stack before or after the pane under the pointer', () => {
    document.elementFromPoint = vi.fn(() => document.querySelectorAll('[data-stack-index]')[1] as Element);
    startViewDrag('tasks', 'stack', press(handle));
    pointer('pointermove', 700, 700); pointer('pointerup', 700, 700);
    expect(s().dropViewAt).toHaveBeenLastCalledWith(2);
    startViewDrag('tasks', 'stack', press(handle));
    pointer('pointermove', 700, 420); pointer('pointerup', 700, 420);
    expect(s().dropViewAt).toHaveBeenLastCalledWith(1);
    document.elementFromPoint = vi.fn(() => null);
    startViewDrag('tasks', 'stack', press(handle));
    pointer('pointermove', 700, 420); pointer('pointerup', 700, 420);
    expect(s().dropViewAt).toHaveBeenLastCalledWith(2);
  });

  it('labels the edge target and tears views out into native windows', () => {
    startViewDrag('graph', 'stack', press(handle, 700, 100));
    pointer('pointermove', 1020, 100);
    expect(s().setDragGhost).toHaveBeenCalledWith(expect.objectContaining({ label: 'Graph · release to pop out' }));
    pointer('pointerup', 1020, 100);
    expect(s().openPanelWindow).toHaveBeenCalledWith('graph', expect.objectContaining({ x: 2020 - 100, y: 600 - 100 }));
    expect(s().removeViewFromWorkspace).toHaveBeenCalledWith('graph');

    startViewDrag('agent', 'handle', press(handle, 700, 100));
    pointer('pointermove', 1020, 100); pointer('pointerup', 1020, 100);
    expect(s().openAgentWindow).toHaveBeenCalledOnce();
    expect(s().removeViewFromWorkspace).not.toHaveBeenCalledWith('agent');

    startViewDrag('doc2', 'stack', press(handle, 700, 100));
    pointer('pointermove', 1020, 100); pointer('pointerup', 1020, 100);
    expect(s().openDocWindow).toHaveBeenCalledWith('Other.md');
    expect(s().removeViewFromWorkspace).toHaveBeenCalledWith('doc2');
  });

  it('does not open native windows in the browser preview', () => {
    io.inTauri = false;
    startViewDrag('graph', 'stack', press(handle, 700, 100));
    pointer('pointermove', 1020, 100); pointer('pointerup', 1020, 100);
    expect(s().openPanelWindow).not.toHaveBeenCalled();
    expect(s().setDragView).toHaveBeenLastCalledWith(null);
  });

  it('cancels on blur and stops listening', () => {
    const click = vi.fn();
    startViewDrag('graph', 'stack', press(handle), click);
    pointer('pointermove', 300, 300);
    window.dispatchEvent(new Event('blur'));
    expect(s().setDragView).toHaveBeenLastCalledWith(null);
    pointer('pointerup', 300, 300);
    expect(s().dropViewInCenter).not.toHaveBeenCalled();
    expect(click).not.toHaveBeenCalled();
  });
});

describe('startFileDrag', () => {
  it('opens on a plain click', () => {
    const click = vi.fn();
    startFileDrag('Notes/A.md', press(handle), click);
    pointer('pointerup', 101, 101);
    expect(click).toHaveBeenCalledOnce();
    expect(s().setDraggingFile).toHaveBeenLastCalledWith(null);
  });

  it('opens the file in the region under the pointer', () => {
    startFileDrag('Notes/A.md', press(handle), vi.fn());
    pointer('pointermove', 700, 300);
    expect(s().setDraggingFile).toHaveBeenCalledWith('Notes/A.md');
    expect(s().setDragGhost).toHaveBeenCalledWith({ kind: 'file', label: 'A.md', x: 700, y: 300 });
    pointer('pointerup', 700, 300);
    expect(s().openFileInRegion).toHaveBeenCalledWith('Notes/A.md', 'right');
  });

  it('opens a document window when released outside the app', () => {
    startFileDrag('A.md', press(handle), vi.fn());
    pointer('pointermove', 1200, 300); pointer('pointerup', 1200, 300);
    expect(s().openDocWindow).toHaveBeenCalledWith('A.md');
  });

  it('falls back to the editor inside the window but outside both regions', () => {
    rect(document.querySelector("[data-region='center']")!, { left: 0, top: 100, width: 600, height: 600 });
    startFileDrag('A.md', press(handle), vi.fn());
    pointer('pointermove', 300, 20); pointer('pointerup', 300, 20);
    expect(s().selectFile).toHaveBeenCalledWith('A.md');
  });

  it('cancels without opening anything', () => {
    const click = vi.fn();
    startFileDrag('A.md', press(handle), click);
    pointer('pointermove', 300, 300);
    window.dispatchEvent(new Event('pointercancel'));
    pointer('pointerup', 300, 300);
    expect(click).not.toHaveBeenCalled();
    expect(s().openFileInRegion).not.toHaveBeenCalled();
    expect(document.body.classList.contains('is-dragging')).toBe(false);
  });
});
