import {
  IN_TAURI,
  stripExt
} from "../lib/vault";
import type {
  Settings
} from "../types";

import { invoke } from "@tauri-apps/api/core";
import { emitTo, listen } from "@tauri-apps/api/event";
import { buildAgentContext } from "../lib/agent";
import {
  discardGraphWindowBootstrap,
  saveGraphWindowBootstrap,
} from "../lib/graphWindowBootstrap";
import {
  AGENT_CONTEXT_EVENT,
  AGENT_WINDOW_READY_EVENT,
  getPiSessionSnapshot
} from "../lib/piSessionBridge";
import { MESA_WINDOW_CHROME } from "../lib/windowChrome";
import { createWorkspaceActions } from "../lib/workspaceActions";

import type { StoreApi } from "zustand";
import type { AppState } from "../store";
type Port = { get: () => AppState; set: StoreApi<AppState>["setState"] };
/** Secondary windows may create only native-validated peer document surfaces. */
export async function createSurfaceWindow(
  WindowClass: typeof import("@tauri-apps/api/webviewWindow").WebviewWindow,
  label: string,
  options: NonNullable<ConstructorParameters<typeof WindowClass>[1]>,
) {
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  if (getCurrentWindow().label === "main") return new WindowClass(label, options);
  await invoke("workspace_open_surface", { request: {
    label, url: options.url, title: options.title, width: options.width, height: options.height,
    minWidth: options.minWidth, minHeight: options.minHeight, x: options.x, y: options.y,
    dark: options.theme === "dark", overlay: options.titleBarStyle === "overlay",
    background: Array.isArray(options.backgroundColor) ? options.backgroundColor.slice(0, 3) : undefined,
  } });
  const window = await WindowClass.getByLabel(label);
  if (!window) throw new Error("Secondary window could not open");
  return window;
}

async function reclaimMainPiResizeOwnership(): Promise<void> {
  const session = getPiSessionSnapshot();
  if (!session.sessionId) return;
  try {
    await invoke("terminal_attach", {
      sessionId: session.sessionId,
      cols: session.cols,
      rows: session.rows,
      reclaim: true,
    });
  } catch {
    // Best effort: the fallback AgentSurface will claim on focus/mount too.
  }
}

interface Dependencies extends Port {
  commitSettings: (settings: Settings) => void;
}
export function createWorkspaceController({ get, set, commitSettings }: Dependencies) {

  const actions: Pick<AppState, 'openDocWindow' | 'openAgentWindow' | 'openResearchWindow' | 'openPanelWindow'> & ReturnType<typeof createWorkspaceActions> = {
    ...createWorkspaceActions({ get, set: (patch) => set(patch as Partial<AppState>), commitSettings, setSetting: (key, value) => get().setSetting(key as never, value as never) }),
    openDocWindow: async (relPath) => {
      if (IN_TAURI) {
        try {
          const { WebviewWindow } = await import(
            "@tauri-apps/api/webviewWindow"
          );
          const vault = get().vaultPath ?? "";
          const theme = get().theme;
          const label =
            "doc-" +
            relPath.replace(/[^a-zA-Z0-9]/g, "_").slice(0, 36) +
            "-" +
            Date.now().toString(36);
          const url = `index.html?doc=${encodeURIComponent(
            relPath
          )}&vault=${encodeURIComponent(vault)}&theme=${theme}`;
          const win = await createSurfaceWindow(WebviewWindow, label, {
            url,
            title: stripExt(relPath.replace(/.*[\\/]/, "")),
            width: 760,
            height: 860,
            resizable: true,
            ...MESA_WINDOW_CHROME,
          });
          // WebviewWindow creation is asynchronous. A constructor catch does
          // not catch a native failure such as an unavailable WebView2.
          void win.once("tauri://error", (event) => {
            console.warn("[mesa] document window creation failed:", event.payload ?? event);
            set({
              popoutDoc: relPath,
              status: "Document window could not open; restored inside Mesa.",
            });
          });
          return;
        } catch {
          /* fall back to in-app modal */
        }
      }
      set({ popoutDoc: relPath });
    },

    openAgentWindow: async (placement) => {
      if (IN_TAURI) {
        try {
          const { WebviewWindow } = await import(
            "@tauri-apps/api/webviewWindow"
          );
          const vault = get().vaultPath ?? "";
          const theme = get().theme;
          const active = get().activePath;
          const docParam = active ? `&sel=${encodeURIComponent(active)}` : "";
          // Transfer the existing PTY session. Keep the source mounted until session startup and adoption finish.
          let liveSession = getPiSessionSnapshot();
          for (
            let attempt = 0;
            attempt < 40 &&
            (!liveSession.sessionId || liveSession.vaultPath !== vault);
            attempt++
          ) {
            await new Promise<void>((resolve) => window.setTimeout(resolve, 50));
            liveSession = getPiSessionSnapshot();
          }
          if (!liveSession.sessionId || liveSession.vaultPath !== vault) {
            throw new Error("Pi is still starting.");
          }
          const sessionParam = `&piSession=${encodeURIComponent(
            liveSession.sessionId
          )}`;
          const label = `agent-${Date.now().toString(36)}`;
          const handoffToken = await invoke<string>("terminal_prepare_handoff", { sessionId: liveSession.sessionId, targetLabel: label });
          const titleOverlay = /Macintosh|Mac OS X/i.test(navigator.userAgent);
          const url = `index.html?agent=1&vault=${encodeURIComponent(
            vault
          )}&theme=${theme}&agentLabel=${encodeURIComponent(label)}${titleOverlay ? "&titleOverlay=1" : ""
            }${docParam}${sessionParam}&piHandoff=${encodeURIComponent(handoffToken)}`;
          let resolveReady: (ready: boolean) => void = () => undefined;
          const ready = new Promise<boolean>((resolve) => {
            resolveReady = resolve;
          });
          let creationFailed = false;
          const stopReadyListener = await listen<{
            label?: string;
            sessionId?: string;
          }>(AGENT_WINDOW_READY_EVENT, (event) => {
            if (
              event.payload?.label === label &&
              typeof event.payload.sessionId === "string"
            ) {
              resolveReady(true);
            }
          });
          try {
            const win = new WebviewWindow(label, {
              url,
              title: `Pi agent — ${get().vaultName || "Mesa"}`,
              width: Math.max(520, placement?.width ?? 980),
              height: Math.max(360, placement?.height ?? 760),
              minWidth: 520,
              minHeight: 360,
              ...(placement ? { x: placement.x, y: placement.y } : {}),
              resizable: true,
              decorations: true,
              ...MESA_WINDOW_CHROME,
              ...(titleOverlay
                ? {
                  titleBarStyle: "overlay" as const,
                  hiddenTitle: true,
                }
                : {}),
              shadow: true,
              // Create the OS window visibly. The source Pi remains mounted
              // until the child acknowledges PTY adoption, but visibility
              // must not depend on a post-create `show()` mutation or on the
              // detached realm finishing a full vault scan.
              visible: true,
            });
            void win.once("tauri://error", (e) => {
              creationFailed = true;
              console.warn("[mesa] Pi window creation failed:", e.payload ?? e);
              resolveReady(false);
            });
            const timeout = window.setTimeout(
              () => resolveReady(false),
              15_000
            );
            const adopted = await ready;
            window.clearTimeout(timeout);
            if (!adopted) {
              if (creationFailed) {
                await win.close().catch(() => undefined);
                await reclaimMainPiResizeOwnership();
                set({
                  agentOpen: true,
                  status: "Pi window creation failed; restored inside Mesa.",
                });
              } else {
                // A lost/delayed app event is not proof that the visible child
                // failed. Never destroy a potentially adopted, interactive Pi
                // window on a timer; keep the source mounted as the fail-safe.
                set({
                  status:
                    "Pi handoff was not confirmed; both Pi surfaces were kept open.",
                });
              }
              return false;
            }
            // PTY adoption is the handoff boundary. Focus and the initial
            // context mirror are conveniences after that boundary; a stale
            // runtime capability or transient focus denial must never close a
            // visible, adopted Pi window.
            await win.setFocus().catch((error) => {
              console.warn("[mesa] detached Pi focus request failed:", error);
            });
            const current = get();
            await emitTo(
              label,
              AGENT_CONTEXT_EVENT,
              buildAgentContext({
                vaultName: current.vaultName,
                vaultPath: current.vaultPath,
                activePath: current.activePath,
                openTabs: current.openTabs,
                settings: current.settings,
              })
            ).catch((error) => {
              console.warn("[mesa] initial detached Pi context mirror failed:", error);
            });
            return true;
          } finally {
            stopReadyListener();
          }
        } catch (error) {
          await reclaimMainPiResizeOwnership();
          console.warn("[mesa] Pi native window launch failed:", error);
          set({
            status: `Pi tear-out failed: ${error instanceof Error ? error.message : String(error)
              }`,
          });
          /* fall back to the in-app floating Pi window */
        }
      }
      set({ agentOpen: true });
      return false;
    },

    openResearchWindow: async (placement) => {
      get().openDeepResearch(false);
      if (!IN_TAURI) return false;
      try {
        const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
        const currentSurface = get().deepResearchSurface;
        if (currentSurface?.startsWith("native:")) {
          const existing = await WebviewWindow.getByLabel(currentSurface.slice("native:".length));
          if (existing) {
            await existing.setFocus();
            return true;
          }
        }
        const vault = get().vaultPath ?? "";
        const theme = get().theme;
        const label = `research-${Date.now().toString(36)}`;
        const surface = `native:${label}`;
        const url = `index.html?research=1&vault=${encodeURIComponent(vault)}&theme=${theme}&researchLabel=${encodeURIComponent(label)}`;
        const titleOverlay = /Macintosh|Mac OS X/i.test(navigator.userAgent);
        const win = await createSurfaceWindow(WebviewWindow, label, {
          url,
          title: `Deep Research — ${get().vaultName || "Mesa"}`,
          width: Math.max(520, placement?.width ?? 760),
          height: Math.max(420, placement?.height ?? 820),
          minWidth: 520,
          minHeight: 420,
          ...(placement ? { x: placement.x, y: placement.y } : {}),
          resizable: true,
          decorations: true,
          ...MESA_WINDOW_CHROME,
          ...(titleOverlay ? { titleBarStyle: "overlay" as const, hiddenTitle: true } : {}),
          shadow: true,
          visible: true,
        });
        get().setDeepResearchSurface(surface);
        // Native creation reports errors asynchronously. Restore the shared
        // Research surface in Mesa so a failed WebView2/WKWebView creation
        // cannot leave the run with no visible presentation.
        void win.once("tauri://error", (event) => {
          if (get().deepResearchSurface !== surface) return;
          console.warn("[mesa] Deep Research window creation failed:", event.payload ?? event);
          set({ status: "Deep Research window could not open; restored inside Mesa." });
          get().openDeepResearch(true);
        });
        void win.once("tauri://destroyed", () => {
          if (get().deepResearchSurface === surface) set({ deepResearchSurface: null });
        });
        return true;
      } catch (error) {
        set({ status: `Deep Research tear-out failed: ${String(error)}` });
        return false;
      }
    },

    openPanelWindow: async (panel, placement) => {
      if (!IN_TAURI) return;
      const dockPanel = () => {
        /* fall back: just dock it in the right stack */
        const settings = get().settings;
        get().setSetting(
          "centerView",
          settings.centerView === "empty" ? panel : settings.centerView
        );
        if (settings.centerView !== "empty" && !settings.rightStack.includes(panel)) {
          get().setSetting("rightStack", [...settings.rightStack, panel]);
        } else if (settings.centerView === "empty") {
          get().setSetting("rightStack", []);
        }
      };
      try {
        const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
        const vault = get().vaultPath ?? "";
        const theme = get().theme;
        // A panel is a singleton surface. Timestamped labels made every
        // repeated tear-out create another Mesa window, which macOS then
        // displayed as a second app thumbnail. Reuse the stable panel label.
        const label = `panel-${panel}`;
        const existing = await WebviewWindow.getByLabel(label);
        if (existing) {
          await existing.setFocus();
          return;
        }
        // Preview/Tasks/Calendar follow the active note — carry it so the popped
        // window shows the SAME document, not the vault's first note.
        const active = get().activePath;
        const docParam = active ? `&sel=${encodeURIComponent(active)}` : "";
        const graphBootstrapSaved =
          panel === "graph" && vault
            ? saveGraphWindowBootstrap(label, {
              vaultPath: vault,
              vaultName: get().vaultName,
              files: get().files,
              notes: get().notes,
              settings: {
                hardwareAccel: get().settings.hardwareAccel,
                animations: get().settings.animations,
                graphShowTags: get().settings.graphShowTags,
                graphExistingFilesOnly: get().settings.graphExistingFilesOnly,
                graphShowOrphans: get().settings.graphShowOrphans,
                graphShowAttachments: get().settings.graphShowAttachments,
                graphArrows: get().settings.graphArrows,
                graphTextFadeThreshold: get().settings.graphTextFadeThreshold,
                graphNodeSize: get().settings.graphNodeSize,
                graphLinkThickness: get().settings.graphLinkThickness,
                graphCenterForce: get().settings.graphCenterForce,
                graphRepelForce: get().settings.graphRepelForce,
                graphLinkForce: get().settings.graphLinkForce,
                graphLinkDistance: get().settings.graphLinkDistance,
              },
            })
            : false;
        const bootstrapParam = graphBootstrapSaved
          ? `&graphBootstrap=${encodeURIComponent(label)}`
          : "";
        if (graphBootstrapSaved) {
          window.setTimeout(() => discardGraphWindowBootstrap(label), 30_000);
        }
        const url = `index.html?panel=${panel}&vault=${encodeURIComponent(
          vault
        )}&theme=${theme}${docParam}${bootstrapParam}`;
        const win = await createSurfaceWindow(WebviewWindow, label, {
          url,
          title: panel[0].toUpperCase() + panel.slice(1),
          width: Math.max(360, placement?.width ?? 720),
          height: Math.max(280, placement?.height ?? 820),
          ...(placement ? { x: placement.x, y: placement.y } : {}),
          resizable: true,
          // Graph keeps the OS-following chrome contract. Other Mesa-owned
          // panel windows need the same dark launch background as the main
          // window so WebView2 does not flash white before React paints.
          ...(panel === "graph" ? {} : MESA_WINDOW_CHROME),
        });
        // The constructor only starts the native request. Handle a real
        // creation error as well as the synchronous import/constructor path.
        void win.once("tauri://error", (event) => {
          console.warn(`[mesa] ${panel} window creation failed:`, event.payload ?? event);
          dockPanel();
        });
      } catch {
        dockPanel();
      }
    },

  };
  return { actions };
}
