// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Modal, trapDialogFocus } from './Modal';
let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.spyOn(HTMLElement.prototype, 'getClientRects').mockReturnValue([{}] as unknown as DOMRectList);
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); document.body.replaceChildren(); vi.restoreAllMocks(); });
describe('dialog keyboard behavior', () => {
  it('skips disabled, hidden and negative-tabindex controls; restores its trigger', () => {
    const trigger = document.createElement('button'); document.body.prepend(trigger); trigger.focus();
    act(() => root.render(<Modal onClose={() => {}}><button disabled>Disabled</button><div hidden><button>Hidden</button></div><button tabIndex={-1}>Programmatic</button><button>First</button><button>Last</button></Modal>));
    expect(document.activeElement?.textContent).toBe('First');
    const dialog = host.querySelector<HTMLElement>('[role=dialog]')!;
    const buttons = dialog.querySelectorAll('button');
    buttons[4].focus();
    const event = { key: 'Tab', shiftKey: false, preventDefault: vi.fn() };
    trapDialogFocus(dialog, event);
    expect(event.preventDefault).toHaveBeenCalled(); expect(document.activeElement?.textContent).toBe('First');
    dialog.focus(); trapDialogFocus(dialog, { ...event, shiftKey: true });
    expect(document.activeElement?.textContent).toBe('Last');
    act(() => root.render(null)); expect(document.activeElement).toBe(trigger);
  });
  it('Escape closes only the topmost dialog and leaves a consumed Escape alone', () => {
    const outer = vi.fn(), inner = vi.fn();
    act(() => root.render(<><Modal onClose={outer}><button>Outer</button></Modal><Modal onClose={inner}><button>Inner</button></Modal></>));
    act(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })));
    expect(inner).toHaveBeenCalledOnce(); expect(outer).not.toHaveBeenCalled();
    const consumed = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true }); consumed.preventDefault();
    act(() => window.dispatchEvent(consumed)); expect(inner).toHaveBeenCalledOnce();
  });
  it('keeps focus in an empty dialog', () => {
    act(() => root.render(<Modal onClose={() => {}}>No actions</Modal>));
    const dialog = host.querySelector<HTMLElement>('[role=dialog]')!;
    expect(document.activeElement).toBe(dialog);
    const preventDefault = vi.fn(); trapDialogFocus(dialog, { key: 'Tab', shiftKey: false, preventDefault });
    expect(preventDefault).toHaveBeenCalledOnce(); expect(document.activeElement).toBe(dialog);
  });
});

it('keeps disclosure summaries in the keyboard cycle', () => {
  act(() => root.render(<Modal onClose={() => {}}><button>First</button><details><summary>Advanced</summary><button>Inside</button></details></Modal>));
  const dialog = host.querySelector<HTMLElement>('[role=dialog]')!, summary = host.querySelector('summary')!;
  summary.focus(); const preventDefault = vi.fn();
  trapDialogFocus(dialog, { key: 'Tab', shiftKey: false, preventDefault });
  // Closed-details descendants can still have rectangles in WebKit.
  expect(preventDefault).toHaveBeenCalledOnce();
  expect(document.activeElement?.textContent).toBe('First');
});
