import type { Settings, SyncPeer } from "../types";
import { normalizeAutoSyncMinutes } from "./syncAutoSchedule";
import { generateDeviceName } from "./deviceName";
import { normalizeSyncPort } from "./pairing";
import { normalizeHotkeys } from "./hotkeys";
import { GRAPH_FORCE_DEFAULTS } from "./graphForceDefaults";
import { clamp } from "./clamp";
export const SETTINGS_KEY = "mesa:settings";
/** Bump when a graph setting changes units; stored values from an older version reset once. */
const GRAPH_SETTINGS_VERSION = 2;
const GRAPH_SETTING_RANGES: Partial<Record<keyof Settings, [number, number]>> = {
  graphTextFade: [-3, 3], graphNodeSize: [0.1, 5], graphLinkThickness: [0.1, 5],
  graphCenterForce: [0, 1], graphRepelForce: [0, 20], graphLinkForce: [0, 1], graphLinkDistance: [30, 500],
};
export const DEFAULT_SETTINGS: Settings = {
  hoverDelayMs: 450,
  hardwareAccel: true,
  animations: true,
  browserTextOnly: false,
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
  autoUpdate: true,
  dailyFolder: "Daily",
  templatesFolder: "Templates",
  hotkeys: {},
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
  // Graph filters, display and forces start at Obsidian's defaults. Markdown
  // files are notes; every other file is an attachment.
  graphShowTags: false,
  graphExistingFilesOnly: false,
  graphShowOrphans: true,
  graphShowAttachments: false,
  // Opt-in: every cataloged file as a node (not an Obsidian filter).
  graphShowAllFiles: false,
  graphArrows: false,
  graphTextFade: 0,
  graphNodeSize: 1,
  graphLinkThickness: 1,
  graphCenterForce: GRAPH_FORCE_DEFAULTS.center,
  graphRepelForce: GRAPH_FORCE_DEFAULTS.repel,
  graphLinkForce: GRAPH_FORCE_DEFAULTS.linkForce,
  graphLinkDistance: GRAPH_FORCE_DEFAULTS.linkDistance,
  graphLivingMotion: false,
  graphSettingsVersion: GRAPH_SETTINGS_VERSION,
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

/** Validate persisted shape. Graph values are clamped to `GRAPH_SETTING_RANGES`,
 *  and graph settings saved by an older version reset to the defaults. */
export function normalizeSettings(value: unknown): Settings {
  const next: Settings = { ...DEFAULT_SETTINGS, peers: [], bookmarks: [], hotkeys: {}, rightStack: [...DEFAULT_SETTINGS.rightStack] };
  if (!record(value)) return next;
  for (const key of Object.keys(DEFAULT_SETTINGS) as (keyof Settings)[]) {
    const candidate = value[key], fallback = DEFAULT_SETTINGS[key];
    if (Array.isArray(fallback)) continue;
    if (typeof candidate === typeof fallback && (typeof candidate !== 'number' || Number.isFinite(candidate))) {
      Object.assign(next, { [key]: candidate });
    }
  }
  // Graph settings saved before the Obsidian-parity units (different slider
  // curves, text fade and filters) would misread; they restart at the defaults.
  if (value.graphSettingsVersion !== GRAPH_SETTINGS_VERSION) {
    for (const key of Object.keys(DEFAULT_SETTINGS) as (keyof Settings)[]) {
      if (key.startsWith('graph')) Object.assign(next, { [key]: DEFAULT_SETTINGS[key] });
    }
  }
  for (const [key, [lo, hi]] of Object.entries(GRAPH_SETTING_RANGES)) {
    const k = key as keyof Settings;
    Object.assign(next, { [k]: clamp(next[k] as number, lo, hi) });
  }
  const enums: Partial<Record<keyof Settings, string[]>> = {
    sortMode: ['name', 'modified', 'size', 'links', 'type'], sortDir: ['asc', 'desc'], dockSide: ['left', 'right'],
    centerView: ['empty', 'doc', 'agent', 'preview', 'graph', 'tasks'], researchContextScope: ['workspace', 'vault'],
    researchDepth: ['quick', 'standard', 'deep'],
  };
  for (const [key, allowed] of Object.entries(enums)) {
    const k = key as keyof Settings;
    if (!allowed.includes(String(next[k]))) Object.assign(next, { [k]: k === 'centerView' && next[k] === 'doc2' ? 'doc' : DEFAULT_SETTINGS[k] });
  }
  next.hotkeys = normalizeHotkeys(value.hotkeys);
  if (Array.isArray(value.bookmarks)) next.bookmarks = value.bookmarks.filter((v): v is string => typeof v === 'string');
  if (Array.isArray(value.retiredSyncPeers)) next.retiredSyncPeers = [...new Set(value.retiredSyncPeers.filter((v): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v)))];
  // Split view: keep one side pane, never a duplicate of the center view.
  // The side-by-side file is session state, so a saved second document pane
  // ("doc2") loads as the document pane unless that pane is already shown.
  if (Array.isArray(value.rightStack)) next.rightStack = [...new Set(value.rightStack.map((v) => (v === 'doc2' ? 'doc' : v)).filter((v): v is Settings['rightStack'][number] => ['doc', 'agent', 'preview', 'graph', 'tasks'].includes(v as string) && v !== next.centerView))].slice(0, 1);
  const peers = Array.isArray(value.peers) ? value.peers : [];
  next.peers = peers.filter((peer): peer is SyncPeer => record(peer) && typeof peer.id === 'string' && typeof peer.address === 'string' && typeof peer.name === 'string')
    .map(peer => ({ ...peer, favorite: peer.favorite === true, token: typeof peer.token === 'string' ? peer.token : undefined, fingerprint: typeof peer.fingerprint === 'string' ? peer.fingerprint : undefined }));
  next.syncDiscovery = false;
  next.syncBindAddress = typeof value.syncBindAddress === "string" ? value.syncBindAddress : "127.0.0.1";
  next.syncPort = normalizeSyncPort(next.syncPort, DEFAULT_SETTINGS.syncPort);
  next.syncAutoMinutes = normalizeAutoSyncMinutes(next.syncAutoMinutes);
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

/**
 * localStorage replaces one value atomically. Preserve unreadable data before a repair.
 * With `previous`, only keys that differ from it are written over the stored value, so
 * a second window's stale copy never reverts a key it did not change.
 */
export function persistSettings(settings: Settings, storage?: StorageAccess, previous?: Settings): string {
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
    const partial = previous !== undefined && existing.graphSettingsVersion === settings.graphSettingsVersion;
    const changed = partial ? changedSettings(publicSettings, previous) : publicSettings;
    const next: Record<string, unknown> = {
      ...existing, ...changed,
      peers: partial && Object.is(previous.peers, settings.peers) && Array.isArray(existing.peers) ? existing.peers : peers,
    };
    if (typeof existing.syncToken !== 'string') delete next.syncToken;
    target.setItem(SETTINGS_KEY, JSON.stringify(next));
    return '';
  } catch {
    return 'Settings are active for this session but could not be saved. Free local storage, then Retry settings.';
  }
}

function changedSettings(current: Record<string, unknown>, previous: Settings): Record<string, unknown> {
  const before = previous as unknown as Record<string, unknown>;
  return Object.fromEntries(Object.entries(current).filter(([key, value]) => !Object.is(value, before[key])));
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
