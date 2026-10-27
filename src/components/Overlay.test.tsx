// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { FloatingWindow } from './Overlay';

vi.mock('./AgentPanel', () => ({ AgentSurface: () => null }));
vi.mock('./DeepResearchPanel', () => ({ DeepResearchPanel: () => null }));
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
const change = vi.fn(), transfer = vi.fn(), close = vi.fn();
beforeEach(() => {
  vi.clearAllMocks();
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  act(() => root.render(<FloatingWindow title="Deep Research" rec={{ open: true, x: 100, y: 100, w: 500, h: 400 }} z={1}
    onChange={change} onClose={close} onFocus={() => {}} onTearOff={transfer}>Research evidence</FloatingWindow>));
});
afterEach(() => {
  act(() => { window.dispatchEvent(new Event('pointercancel')); });
  act(() => root.unmount()); host.remove();
});
const header = () => host.querySelector<HTMLElement>('.ov-win-bar')!;
function key(target: HTMLElement, modifiers: KeyboardEventInit) {
  const event = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, ...modifiers });
  act(() => target.dispatchEvent(event)); return event;
}
function pointer(target: EventTarget, type: string, input: MouseEventInit) {
  act(() => target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, ...input })));
}
it('keeps both transfer shortcuts on the docked Research header while preserving geometry controls', () => {
  expect(header().getAttribute('aria-label')).toContain('Control or Command plus Shift plus Enter');
  expect(key(header(), { ctrlKey: true, shiftKey: true }).defaultPrevented).toBe(true);
  expect(key(header(), { metaKey: true, shiftKey: true }).defaultPrevented).toBe(true);
  expect(transfer).toHaveBeenCalledTimes(2);
  expect(key(header(), { shiftKey: true }).defaultPrevented).toBe(false);
  key(header(), { key: 'ArrowRight' });
  expect(change).toHaveBeenLastCalledWith({ x: 116 });
  key(header(), { key: 'ArrowRight', shiftKey: true });
  expect(change).toHaveBeenLastCalledWith({ w: 516 });
});
it('tears out only on edge release and preserves the grabbed screen position', () => {
  pointer(header(), 'pointerdown', { clientX: 160, clientY: 120 });
  expect(document.activeElement).toBe(header());
  pointer(window, 'pointermove', { clientX: 500, clientY: 150 });
  expect(transfer).not.toHaveBeenCalled();
  expect(change).toHaveBeenLastCalledWith({ x: 440, y: 130 });
  pointer(window, 'pointerup', { clientX: window.innerWidth, clientY: 150, screenX: 1600, screenY: 300 });
  expect(transfer).toHaveBeenCalledWith({ x: 1540, y: 280, width: 500, height: 400 });
  expect(document.body.style.userSelect).toBe('');
});
it('lets a pointer-focused header claim the keyboard transfer instead of leaving focus in its former input', () => {
  const input = document.createElement('textarea'); host.append(input); input.focus();
  pointer(header(), 'pointerdown', { clientX: 160, clientY: 120 });
  pointer(window, 'pointerup', { clientX: 160, clientY: 120 });
  expect(document.activeElement).toBe(header());
  key(document.activeElement as HTMLElement, { metaKey: true, shiftKey: true });
  expect(transfer).toHaveBeenCalledOnce();
});
it('preserves normal movement and cancels a drag without creating a native window', () => {
  pointer(header(), 'pointerdown', { clientX: 160, clientY: 120 });
  pointer(window, 'pointerup', { clientX: 500, clientY: 150 });
  expect(transfer).not.toHaveBeenCalled();
  pointer(header(), 'pointerdown', { clientX: 160, clientY: 120 });
  pointer(window, 'pointercancel', {});
  pointer(window, 'pointerup', { clientX: 0, clientY: 150 });
  expect(transfer).not.toHaveBeenCalled();
  expect(document.body.style.userSelect).toBe('');
});
it('leaves header buttons and secondary pointer presses out of transfer gestures', () => {
  const button = host.querySelector<HTMLButtonElement>('button')!;
  key(button, { ctrlKey: true, shiftKey: true });
  pointer(button, 'pointerdown', { clientX: 160, clientY: 120 });
  pointer(window, 'pointerup', { clientX: 0, clientY: 150 });
  pointer(header(), 'pointerdown', { button: 2, clientX: 160, clientY: 120 });
  pointer(window, 'pointerup', { clientX: 0, clientY: 150 });
  expect(transfer).not.toHaveBeenCalled();
  act(() => button.click()); expect(close).toHaveBeenCalledOnce();
});
