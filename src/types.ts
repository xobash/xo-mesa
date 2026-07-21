import type { SimulationNodeDatum, SimulationLinkDatum } from "d3-force";

/** A file discovered inside the vault (note or asset). */
export interface VaultFile {
  /** Absolute path on disk (forward-slash normalized). */
  path: string;
  /** Path relative to the vault root — used as a stable id. */
  relPath: string;
  /** File name without extension. */
  name: string;
  /** Lower-cased extension without the dot ("md", "png", ...). */
  ext: string;
  /** True for markdown notes. */
  isMarkdown: boolean;
  /** Last-modified time (epoch ms), when available — used for sorting. */
  mtime?: number;
  /** File size in bytes, when available — used for sorting. */
  size?: number;
}

/** Parsed metadata for a single note. */
export interface NoteMeta {
  relPath: string;
  title: string;
  /** Raw [[targets]] referenced by the note, in document order. */
  rawLinks: string[];
  /** #tags found in the note (without the leading #). */
  tags: string[];
  /** Frontmatter aliases, so [[alias]] resolves to this note. */
  aliases: string[];
  /** Absolute path to the first image referenced by the note, if any. */
  firstImagePath?: string;
}

/** A saved sync peer — another of the user's own devices. */
export interface SyncPeer {
  /** Stable local id. */
  id: string;
  /** Friendly, user-chosen name (e.g. "Studio iMac"). */
  name: string;
  /** Address to reach it: host:port or an http(s) URL. */
  address: string;
  /** Pinned to the top of the list. */
  favorite: boolean;
  /** Optional per-peer sync key; falls back to the global sync key. */
  token?: string;
  /**
   * Pinned TLS certificate fingerprint (lowercase hex SHA-256). Set on first
   * successful contact (trust-on-first-use); afterward a changed certificate
   * aborts sync. Compare it out-of-band with the peer to defeat a first-contact
   * man-in-the-middle.
   */
  fingerprint?: string;
  /** Last successful sync (epoch ms). */
  lastSync?: number;
  /** Last health check / sync attempt (epoch ms). */
  lastChecked?: number;
  /** Most recent peer health state. */
  lastStatus?: "ok" | "error";
  /** Last sync/check error message, shown in the peer card. */
  lastError?: string;
}

/** User-adjustable settings (persisted to localStorage). */
export interface Settings {
  /** Delay before the graph hover-preview card appears (ms). */
  hoverDelayMs: number;
  /** GPU/desynchronized canvas + compositing hints. */
  hardwareAccel: boolean;
  /** Master switch for UI transitions/animations. */
  animations: boolean;
  /** Multiple open documents with a tab strip. Off by default. */
  enableTabs: boolean;
  /** Port the embedded LAN/Tailscale sync server listens on. */
  syncPort: number;
  /** Master switch: false disables listening, discovery, manual sync, and schedules. */
  syncEnabled: boolean;
  /** Announce/listen for nearby Mesa devices while sync is open or listening. */
  syncDiscovery: boolean;
  /** Sync key required to read/write this device's vault over sync. */
  syncToken: string;
  /** How this device introduces itself to nearby devices (LocalSend-style
   *  "Toasty Lemon"; generated once at first launch, user-editable). */
  syncDeviceName: string;
  /** Automatically sync all peers every N minutes. 0 disables scheduling. */
  syncAutoMinutes: number;
  /** Saved peer devices to sync with. */
  peers: SyncPeer[];
  /** Sidebar sort order. */
  sortMode: SortMode;
  /** Sidebar sort direction (reverses the mode's natural order). */
  sortDir: "asc" | "desc";
  /** Keep folders grouped above files (vs. interleaving everything by mode). */
  foldersFirst: boolean;
  /** Show only files of this extension in the sidebar ("all" = no filter). */
  typeFilter: string;
  /** Folder where daily notes live (relative to the vault). */
  dailyFolder: string;
  /** Folder Mesa looks in for note templates. */
  templatesFolder: string;
  /** Note file where the user's personal (+ added) tasks live. */
  tasksFile: string;
  /** Vault folder Deep Research writes generated notes into. */
  researchFolder: string;
  /** Default Deep Research thoroughness preset (quick | standard | deep). */
  researchDepth: string;
  /** Whether the left sidebar is shown. */
  sidebarOpen: boolean;
  /** Resizable pane widths in px. */
  sidebarWidth: number;
  rightWidth: number;
  /** Collapsed state of the sidebar Tags section. */
  tagsCollapsed: boolean;
  /** Bookmarked file/folder relPaths shown in the sidebar Bookmarks section. */
  bookmarks: string[];
  /** Collapsed state of the sidebar Bookmarks section. */
  bookmarksCollapsed: boolean;
  /** Auto-hide the sidebar, revealing it on a left-edge hover. */
  sidebarAutoHide: boolean;
  /** Show #tag nodes (and note→tag edges) in the graph. */
  graphShowTags: boolean;
  /** Only graph files that exist — hide placeholder nodes for unresolved [[links]]. */
  graphExistingFilesOnly: boolean;
  /** Show orphan notes (markdown notes with no links) in the graph. */
  graphShowOrphans: boolean;
  /** Show attachment nodes (every non-markdown vault file) in the graph.
   *  Attachments join the same force layout as notes, like Obsidian. */
  graphShowAttachments: boolean;
  /** View shown in the center region. Can be empty after the user closes it. */
  centerView: WorkspaceView;
  /** Views stacked in the right region (any number visible at once). */
  rightStack: PaneView[];
  /** Which side of the center the side stack docks to. Flippable so the
   *  workspace is a constrained snap workspace, not hard-coded left/right. */
  dockSide: "left" | "right";
  /** Pi agent provider configuration, used only when the user sends a prompt. */
  agentProvider: AgentProvider;
  agentModel: string;
  agentEndpoint: string;
  agentApiKey: string;
}

/** A node in the force-directed graph. d3-force mutates x/y/vx/vy in place. */
export interface GraphNode extends SimulationNodeDatum {
  id: string;
  title: string;
  degree: number;
  /** Absolute path of a thumbnail image, if the note embeds one. */
  thumbPath?: string;
  /** File kind for visual differentiation in the graph. */
  kind: GraphNodeKind;
  /** Lower-cased extension (e.g. "md", "png", "zip"). */
  ext: string;
  /** Stable visual phase used for subtle graph breathing without reheating d3. */
  renderPhase?: number;
  /** Render-only position/radius; hit testing and force layout use x/y/radius. */
  renderX?: number;
  renderY?: number;
  renderRadius?: number;
  /** Render-only transient impulse from panning/window movement. */
  renderKickX?: number;
  renderKickY?: number;
  renderKickVx?: number;
  renderKickVy?: number;
}

/** Visual category of a graph node — determines shape and colour. */
export type GraphNodeKind =
  | "note"        // markdown notes — the primary graph content
  | "tag"         // a #tag, shown as its own node with edges from notes
  | "phantom"     // a placeholder for an unresolved [[link]] (no file yet)
  | "attachment"; // a non-markdown vault file (pdf, html, css, images, …)

/** A directed link between two notes. */
export interface GraphLink extends SimulationLinkDatum<GraphNode> {
  source: string | GraphNode;
  target: string | GraphNode;
}

export type RightPanel = "preview" | "graph" | "tasks";

export type PaneView = "doc" | "agent" | RightPanel;

export type WorkspaceView = "empty" | PaneView;

export type AgentProvider =
  | "openai"
  | "openrouter"
  | "anthropic"
  | "custom"
  | "manual";

/** Sidebar file sort order. */
export type SortMode = "name" | "modified" | "size" | "links" | "type";

/**
 * What a floating preview card is showing. One card renderer handles all three
 * so the graph, sidebar files, sidebar folders, and tag chips look identical.
 */
export type PreviewTarget =
  | { kind: "note"; id: string }
  | { kind: "folder"; path: string; title: string }
  | { kind: "tag"; tag: string };
