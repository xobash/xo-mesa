// @vitest-environment jsdom
import { expect, it, vi } from 'vitest';
vi.mock('./vault', () => ({ IN_TAURI: true }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ confirm: async () => { throw new Error('dialog plugin missing'); } }));
vi.mock('../store', () => { throw new Error('confirmAction must not import the store'); });
import { confirmAction } from './confirmAction';
import { setStatusSink } from './statusReport';

it('reports a failed dialog through the registered status sink without loading the store', async () => {
  const sink = vi.fn();
  setStatusSink(sink);
  try {
    await expect(confirmAction('Delete "a"?')).resolves.toBe(false);
    expect(sink).toHaveBeenCalledWith('Confirmation dialog unavailable, so nothing was changed: Error: dialog plugin missing');
  } finally {
    setStatusSink(null);
  }
});
