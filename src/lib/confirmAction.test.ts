// @vitest-environment jsdom
import { expect, it, vi } from 'vitest';
vi.mock('./vault', () => ({ IN_TAURI: true }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ confirm: async () => { throw new Error('dialog plugin missing'); } }));
import { confirmAction } from './confirmAction';
import { useAppStore } from '../store';

it('denies and explains when the native confirmation dialog fails', async () => {
  await expect(confirmAction('Move "a" to recovery?')).resolves.toBe(false);
  expect(useAppStore.getState().status).toBe('Confirmation dialog unavailable, so nothing was changed: Error: dialog plugin missing');
});
