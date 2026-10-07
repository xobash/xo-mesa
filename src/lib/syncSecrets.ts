import { invoke } from '@tauri-apps/api/core';
import type { Settings } from '../types';
import { scrubStoredSyncSecrets } from './settings';

interface SyncSecrets { syncToken: string; peers: Record<string, string> }
export interface SyncSecretStore {
  read: () => Promise<string | null>;
  write: (value: string) => Promise<string>;
}

export const nativeSyncSecretStore: SyncSecretStore = {
  read: async () => {
    return invoke<string | null>('sync_secrets_read');
  },
  write: async value => {
    return invoke<string>('sync_secrets_write', { value });
  },
};

function parseSecrets(raw: string | null): SyncSecrets {
  if (raw === null) return { syncToken: '', peers: {} };
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Invalid saved sync credentials');
  const data = parsed as Record<string, unknown>;
  if (typeof data.syncToken !== 'string' || !data.peers || typeof data.peers !== 'object' || Array.isArray(data.peers)) {
    throw new Error('Invalid saved sync credentials');
  }
  const peers: Record<string, string> = Object.create(null);
  for (const [id, token] of Object.entries(data.peers)) {
    if (typeof token !== 'string') throw new Error('Invalid saved sync credentials');
    peers[id] = token;
  }
  return { syncToken: data.syncToken, peers };
}

export function syncSecretsFromSettings(settings: Settings): SyncSecrets {
  const peers: Record<string, string> = Object.create(null);
  for (const peer of settings.peers) if (peer.token) peers[peer.id] = peer.token;
  return { syncToken: settings.syncToken, peers };
}

export function syncSecretSignature(settings: Settings): string {
  return JSON.stringify(syncSecretsFromSettings(settings));
}

/** The credential store takes precedence when both it and old browser storage have a key. */
export async function hydrateSyncSecrets(
  settings: Settings,
  store: SyncSecretStore = nativeSyncSecretStore,
  storage?: Pick<Storage, 'getItem' | 'setItem'>
): Promise<Settings> {
  let saved = parseSecrets(await store.read());
  const legacy = syncSecretsFromSettings(settings);
  const merged: SyncSecrets = {
    syncToken: saved.syncToken || legacy.syncToken,
    peers: { ...legacy.peers, ...saved.peers },
  };
  if (JSON.stringify(saved) !== JSON.stringify(merged)) {
    saved = parseSecrets(await store.write(JSON.stringify(merged)));
  }
  // Even an existing credential-store record requires a confirmed successful
  // read before removing the old settings copy.
  scrubStoredSyncSecrets(storage);
  return {
    ...settings,
    syncToken: saved.syncToken,
    peers: settings.peers.map(peer => ({ ...peer, token: saved.peers[peer.id] || undefined })),
  };
}

export async function persistSyncSecrets(
  settings: Settings,
  store: SyncSecretStore = nativeSyncSecretStore,
  storage?: Pick<Storage, 'getItem' | 'setItem'>
): Promise<Settings> {
  const saved = parseSecrets(await store.write(syncSecretSignature(settings)));
  scrubStoredSyncSecrets(storage);
  return { ...settings, syncToken: saved.syncToken, peers: settings.peers.map(peer => ({ ...peer, token: saved.peers[peer.id] || undefined })) };
}

/** Import an explicitly entered key once; subsequent network commands receive only its reference. */
export async function nativeCredential(value: string): Promise<string> {
  if (value.startsWith('credential:')) return value;
  return invoke<string>('sync_secrets_import', { value });
}
