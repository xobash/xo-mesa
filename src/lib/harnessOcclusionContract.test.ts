import { describe, expect, it } from "vitest";
import browserHarnessSrc from "../components/BrowserHarness.tsx?raw";
import agentPanelSrc from "../components/AgentPanel.tsx?raw";
import overlaySrc from "../components/Overlay.tsx?raw";
import researchSrc from "../components/DeepResearchPanel.tsx?raw";
import phaseChipSrc from "../components/DeepResearchPhaseChip.tsx?raw";
import previewCardSrc from "../components/PreviewCard.tsx?raw";
import modalSrc from "../components/Modal.tsx?raw";

describe("native browser harness occlusion contract", () => {
  it("makes native visibility follow intersecting Mesa surfaces", () => {
    expect(browserHarnessSrc).toContain(
      'const NATIVE_WEBVIEW_OCCLUDER = "[data-native-webview-occluder]"'
    );
    expect(browserHarnessSrc).toContain("harnessOccluded(");
    expect(browserHarnessSrc).toContain(
      'invoke("harness_visibility", { visible: requested })'
    );
    expect(browserHarnessSrc).toContain("visibleOccluderRects(el, occluders)");
  });

  it("does not keep a layout loop alive while the native browser is idle", () => {
    expect(browserHarnessSrc).toContain("new ResizeObserver(schedule)");
    expect(browserHarnessSrc).toContain('window.addEventListener("scroll", schedule, true)');
    expect(browserHarnessSrc).toContain('document.addEventListener("transitionrun", startAnimation, true)');
    expect(browserHarnessSrc).toContain("if (animating) raf = window.requestAnimationFrame(animate)");
    expect(browserHarnessSrc).not.toContain("raf = window.requestAnimationFrame(tick)");
  });

  it("marks both Pi window systems and their sibling research surface", () => {
    expect(agentPanelSrc).toMatch(
      /className=\{"pi-overlay-window"[\s\S]{0,240}data-native-webview-occluder/
    );
    expect(agentPanelSrc).toMatch(
      /data-native-webview-occluder=""[\s\S]{0,80}className=\{\s*"dr-wing"/
    );
    expect(overlaySrc).toMatch(
      /className=\{"ov-win pi-ov-win"[\s\S]{0,180}data-native-webview-occluder/
    );
    expect(overlaySrc).toMatch(
      /className="ov-win"[\s\S]{0,120}data-native-webview-occluder/
    );
  });

  it("marks blocking cards and modal layers but keeps context preview passive", () => {
    expect(researchSrc).toMatch(
      /className="dr-graph-hover-card"\s+data-native-webview-occluder/
    );
    expect(phaseChipSrc).toContain('className="dr-context-popover"');
    expect(phaseChipSrc).toContain('role="status"');
    expect(phaseChipSrc).not.toContain("data-native-webview-occluder");
    expect(previewCardSrc).toMatch(
      /className=\{"hover-card"[\s\S]{0,160}data-native-webview-occluder/
    );
    expect(modalSrc).toMatch(
      /className=\{"modal-overlay align-"[\s\S]{0,120}data-native-webview-occluder/
    );
  });
});
