import { describe, expect, it } from "vitest";
import settingsSource from "../components/SettingsModal.tsx?raw";
import syncSource from "../components/SyncModal.tsx?raw";
import overlaySource from "../components/Overlay.tsx?raw";
import searchSource from "../components/SearchSurface.tsx?raw";
import modalSource from "../components/Modal.tsx?raw";
import topBarSource from "../components/TopBar.tsx?raw";
import fileTreeSource from "../components/FileTree.tsx?raw";
import agentPanelSource from "../components/AgentPanel.tsx?raw";
import deepResearchSource from "../components/DeepResearchPanel.tsx?raw";
import deepResearchPhaseChipSource from "../components/DeepResearchPhaseChip.tsx?raw";

describe("interactive control accessibility contracts", () => {
  it("requires every reusable switch to receive an accessible label", () => {
    for (const source of [settingsSource, syncSource, overlaySource]) {
      expect(source).toContain("label: string");
      expect(source).toContain("aria-label={label}");
    }

    for (const label of [
      "Tabs",
      "Graph canvas smoothing",
      "Animations",
      "Auto-hide sidebar",
    ]) {
      expect(settingsSource).toContain(`label="${label}"`);
      expect(overlaySource).toContain(`label="${label}"`);
    }
    for (const label of ["Sync", "Receive", "LAN discovery"]) {
      expect(syncSource).toContain(`label="${label}"`);
    }
  });

  it("labels sync fields and exposes invalid peer feedback", () => {
    expect(syncSource).toContain('aria-label="Sync port"');
    expect(syncSource).toContain('aria-label="Auto-sync interval in minutes"');
    expect(syncSource).toContain('aria-label="Device address or pairing code"');
    expect(syncSource).toContain('aria-invalid={peerError ? true : undefined}');
    expect(syncSource).toContain('role="alert"');
    expect(syncSource).toContain("Retry failed files");
    expect(syncSource).toContain("Retry sync");
    expect(syncSource).toContain("failedFiles.length > 0");
    expect(syncSource).toContain("void syncNow(lastPeerId)");
  });

  it("renders calendar dates as a keyboard-operable grid", () => {
    expect(overlaySource).toContain('role="grid"');
    expect(overlaySource).toContain('role="columnheader"');
    expect(overlaySource).toContain('role="gridcell"');
    expect(overlaySource).toContain("calendarGridKeyTarget(date, event.key)");
    expect(overlaySource).toContain("tabIndex={date === selected ? 0 : -1}");
    expect(overlaySource).toContain("aria-selected={date === selected}");
  });

  it("keeps modal focus inside the named dialog and restores the trigger", () => {
    expect(modalSource).toContain('role="dialog"');
    expect(modalSource).toContain('aria-modal="true"');
    expect(modalSource).toContain("title = \"Mesa dialog\"");
    expect(modalSource).toContain("aria-label={title}");
    expect(modalSource).toContain("restoreFocus.current.focus()");
    expect(modalSource).toContain("trapDialogFocus");
    expect(overlaySource).toContain('aria-label="Mesa overlay"');
    expect(overlaySource).toContain("trapDialogFocus(e.currentTarget, e)");
    expect(overlaySource).toContain("restoreFocus.current?.focus()");
  });

  it("keeps equivalent controls keyboard-operable", () => {
    expect(topBarSource).toContain("onPanelKeyDown");
    expect(topBarSource).toContain('e.key !== \"Enter\" && e.key !== \" \"');
    expect(topBarSource).toContain("aria-pressed={shows(\"tasks\")}");
    expect(settingsSource).toContain("aria-pressed={t.id === theme}");
    expect(fileTreeSource).toContain('e.key !== \"Enter\" && e.key !== \" \"');
  });

  it("keeps search return-to-document focus predictable", () => {
    expect(searchSource).toContain("focusOpenedDocument");
    expect(searchSource).toContain(".editor-host .cm-content");
    expect(searchSource).toContain("[data-testid='pdf-editor']");
    expect(searchSource).toContain("void openFile(rel).then(focusOpenedDocument)");
    expect(searchSource).toContain("setSearchSeed(next)");
    expect(searchSource).toContain("mesa:savedSearches:v1");
    expect(searchSource).toContain('aria-label="Saved searches"');
    expect(searchSource).toContain('aria-label="Save this search"');
    expect(searchSource).toContain("HighlightedSnippet");
    expect(searchSource).toContain("<mark");
  });

  it("exposes floating-window, dock, Pi-toggle, and graph actions to the keyboard", () => {
    expect(overlaySource).toContain("keyboardWinPatch(");
    expect(overlaySource).toContain("aria-pressed={d.id === \"research\"");
    expect(overlaySource).toContain('aria-label={`${d.label} window`}');
    expect(overlaySource).toContain('aria-hidden="true">{d.icon}');
    expect(overlaySource).toContain('if (!deepResearchSurface || deepResearchSurface === "overlay"');
    expect(overlaySource).toContain('wins.research.open && deepResearchSurface === "overlay"');
    expect(overlaySource).toContain('setDeepResearchSurface("overlay")');
    expect(overlaySource).toContain('openWindow("research")');
    expect(overlaySource).toContain('if (id === "research") setDeepResearchSurface(null)');
    expect(agentPanelSource).toContain("onTitleBarKeyDown={handleTitleBarKeyDown}");
    expect(agentPanelSource).toContain("aria-pressed={researchOpen}");
    expect(agentPanelSource).toContain("aria-pressed={browserOpen}");
    expect(deepResearchSource).toContain('event.key === "Enter" || event.key === " "');
    expect(deepResearchSource).toContain("aria-pressed={selectedId === node.id}");
    expect(deepResearchSource).toContain('querySelector<HTMLButtonElement>("button")?.focus()');
    expect(deepResearchPhaseChipSource).toContain('className="dr-phase-context-cue"');
    expect(deepResearchPhaseChipSource).toContain("contextPinnedRef.current = !contextPinnedRef.current");
    expect(deepResearchSource).toContain('aria-label="Fine-tune research depth"');
  });

  it("gives Escape one capture-phase owner before xterm", () => {
    expect(agentPanelSource).toContain('window.addEventListener("keydown", onKey, { capture: true })');
    expect(agentPanelSource).toContain("claimKeyboardShortcut(e)");
    expect(overlaySource).toContain('window.addEventListener("keydown", onKey, { capture: true })');
    expect(agentPanelSource).toContain('closest?.("[data-escape-layer]")');
    expect(overlaySource).toContain('closest?.("[data-escape-layer]")');
  });
});
