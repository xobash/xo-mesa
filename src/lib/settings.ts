import type { Settings, SyncPeer } from "../types";
import { generateDeviceName } from "./deviceName";
import { normalizeSyncPort } from "./pairing";
export const SETTINGS_KEY = "mesa:settings";
export const DEFAULT_SETTINGS: Settings = {
  hoverDelayMs: 450,
  hardwareAccel: true,
  animations: true,
  enableTabs: false,
  syncPort: 8787,
  syncEnabled: false,
  syncDiscovery: false,
  syncBindAddress: "127.0.0.1",
  syncToken: "",
  syncDeviceName: "",
  syncAutoMinutes: 0,
  peers: [],
  sortMode: "name",
  sortDir: "asc",
  foldersFirst: true,
  typeFilter: "all",
  hideGeneratedFiles: false,
  dailyFolder: "Daily",
  templatesFolder: "Templates",
  tasksFile: "Tasks.md",
  researchFolder: "Research",
  researchDepth: "standard",
  researchContextScope: "workspace",
  sidebarOpen: true,
  sidebarWidth: 240,
  rightWidth: 380,
  tagsCollapsed: false,
  bookmarks: [],
  bookmarksCollapsed: false,
  sidebarAutoHide: false,
  graphShowTags: false,
  graphExistingFilesOnly: true,
  graphShowOrphans: true,
  // Mesa's graph includes the complete vault by default; this differs from
  // Obsidian's Markdown-only graph. Users can still hide non-Markdown files.
  graphShowAttachments: true,
  graphArrows: false,
  graphTextFadeThreshold: 0.42,
  graphNodeSize: 1,
  graphLinkThickness: 1,
  graphCenterForce: 0.5,
  graphRepelForce: 10,
  graphLinkForce: 1,
  graphLinkDistance: 250,
  centerView: "doc",
  rightStack: ["preview"],
  dockSide: "right",
};

type StorageAccess = Pick<Storage, 'getItem' | 'setItem'>;
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const LEGACY_AGENT_SETTING_KEYS = ['agentProvider', 'agentModel', 'agentEndpoint', 'agentApiKey'] as const;

function withoutLegacyAgentSettings(value: Record<string, unknown>): { value: Record<string, unknown>; changed: boolean } {
  const next = { ...value };
  let changed = false;
  for (const key of LEGACY_AGENT_SETTING_KEYS) {
    if (key in next) {
      delete next[key];
      changed = true;
    }
  }
  return { value: next, changed };
}

/** Validate persisted shape without changing any valid setting or its numeric value. */
export function normalizeSettings(value: unknown): Settings {
  const next: Settings = { ...DEFAULT_SETTINGS, peers: [], bookmarks: [], rightStack: [...DEFAULT_SETTINGS.rightStack] };
  if (!record(value)) return next;
  for (const key of Object.keys(DEFAULT_SETTINGS) as (keyof Settings)[]) {
    const candidate = value[key], fallback = DEFAULT_SETTINGS[key];
    if (Array.isArray(fallback)) continue;
    if (typeof candidate === typeof fallback && (typeof candidate !== 'number' || Number.isFinite(candidate))) {
      Object.assign(next, { [key]: candidate });
    }
  }
  const enums: Partial<Record<keyof Settings, string[]>> = {
    sortMode: ['name', 'modified', 'size', 'links', 'type'], sortDir: ['asc', 'desc'], dockSide: ['left', 'right'],
    centerView: ['empty', 'doc', 'agent', 'preview', 'graph', 'tasks'], researchContextScope: ['workspace', 'vault'],
    researchDepth: ['quick', 'standard', 'deep'],
  };
  for (const [key, allowed] of Object.entries(enums)) {
    const k = key as keyof Settings;
    if (!allowed.includes(String(next[k]))) Object.assign(next, { [k]: DEFAULT_SETTINGS[k] });
  }
  if (Array.isArray(value.bookmarks)) next.bookmarks = value.bookmarks.filter((v): v is string => typeof v === 'string');
  if (Array.isArray(value.retiredSyncPeers)) next.retiredSyncPeers = [...new Set(value.retiredSyncPeers.filter((v): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v)))];
  if (Array.isArray(value.rightStack)) next.rightStack = [...new Set(value.rightStack.filter((v): v is Settings['rightStack'][number] => ['doc', 'agent', 'preview', 'graph', 'tasks'].includes(v as string)))];
  const peers = Array.isArray(value.peers) ? value.peers : [];
  next.peers = peers.filter((peer): peer is SyncPeer => record(peer) && typeof peer.id === 'string' && typeof peer.address === 'string' && typeof peer.name === 'string')
    .map(peer => ({ ...peer, favorite: peer.favorite === true, token: typeof peer.token === 'string' ? peer.token : undefined, fingerprint: typeof peer.fingerprint === 'string' ? peer.fingerprint : undefined }));
  next.syncDiscovery = false;
  next.syncBindAddress = typeof value.syncBindAddress === "string" ? value.syncBindAddress : "127.0.0.1";
  next.syncPort = normalizeSyncPort(next.syncPort, DEFAULT_SETTINGS.syncPort);
  if (next.syncAutoMinutes < 0) next.syncAutoMinutes = 0;
  return next;
}

export function loadSettings(storage?: StorageAccess): { settings: Settings; issue: string } {
  let settings = normalizeSettings(null), issue = '';
  try {
    const source = storage ?? localStorage;
    const raw = source.getItem(SETTINGS_KEY);
    let stored: Record<string, unknown> = {};
    if (raw) {
      const parsed: unknown = JSON.parse(raw);
      if (!record(parsed)) throw new Error('Settings are not an object');
      const scrubbed = withoutLegacyAgentSettings(parsed);
      stored = scrubbed.value;
      settings = normalizeSettings(parsed);
      if (scrubbed.changed) source.setItem(SETTINGS_KEY, JSON.stringify(stored));
    }
    if (!settings.syncDeviceName.trim()) {
      settings.syncDeviceName = generateDeviceName();
      // Preserve the original valid object, including unknown future-version fields.
      source.setItem(SETTINGS_KEY, JSON.stringify(raw ? { ...stored, syncDeviceName: settings.syncDeviceName } : settings));
    }
  } catch {
    issue = 'Settings could not be fully loaded or saved. Saved data has been preserved; review your settings and retry.';
  }
  if (!settings.syncDeviceName) settings.syncDeviceName = generateDeviceName();
  return { settings, issue };
}

/** localStorage replaces one value atomically. Preserve unreadable data before a repair. */
export function persistSettings(settings: Settings, storage?: StorageAccess): string {
  try {
    const target = storage ?? localStorage;
    const raw = target.getItem(SETTINGS_KEY);
    let existing: Record<string, unknown> = {};
    if (raw) {
      try {
        const parsed: unknown = JSON.parse(raw);
        if (!record(parsed)) throw new Error();
        existing = withoutLegacyAgentSettings(parsed).value;
      }
      catch {
        // Refuse replacement if the original cannot be preserved, including full quota.
        target.setItem(`${SETTINGS_KEY}:recovery`, raw);
      }
    }
    // Keep only credentials that were already present in an older settings
    // value until the OS credential-store migration confirms a durable copy.
    // New keys never enter browser storage.
    const { syncToken: _token, peers: _peers, ...publicSettings } = settings;
    const legacyPeers = new Map(
      (Array.isArray(existing.peers) ? existing.peers : [])
        .filter(record)
        .map(peer => [peer.id, peer.token])
    );
    const peers = settings.peers.map(({ token: _peerToken, ...peer }) => {
      const legacyToken = legacyPeers.get(peer.id);
      return typeof legacyToken === 'string' ? { ...peer, token: legacyToken } : peer;
    });
    const next: Record<string, unknown> = { ...existing, ...publicSettings, peers };
    if (typeof existing.syncToken !== 'string') delete next.syncToken;
    target.setItem(SETTINGS_KEY, JSON.stringify(next));
    return '';
  } catch {
    return 'Settings are active for this session but could not be saved. Free local storage, then Retry settings.';
  }
}

/** Remove migrated legacy keys only after the OS credential store confirms them. */
export function scrubStoredSyncSecrets(storage?: StorageAccess): void {
  const target = storage ?? localStorage;
  const raw = target.getItem(SETTINGS_KEY);
  if (!raw) return;
  const parsed: unknown = JSON.parse(raw);
  if (!record(parsed)) throw new Error('Settings are not an object');
  const next = { ...parsed };
  delete next.syncToken;
  if (Array.isArray(next.peers)) {
    next.peers = next.peers.map(peer => {
      if (!record(peer)) return peer;
      const clean = { ...peer };
      delete clean.token;
      return clean;
    });
  }
  target.setItem(SETTINGS_KEY, JSON.stringify(next));
}
