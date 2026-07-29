import { describe, expect, it } from "vitest";
import settingsSource from "../components/SettingsModal.tsx?raw";
import syncSource from "../components/SyncModal.tsx?raw";
import overlaySource from "../components/Overlay.tsx?raw";

describe("interactive control accessibility contracts", () => {
  it("requires every reusable switch to receive an accessible label", () => {
    for (const source of [settingsSource, syncSource, overlaySource]) {
      expect(source).toContain("label: string");
      expect(source).toContain("aria-label={label}");
    }

    for (const label of [
      "Tabs",
      "Hardware acceleration",
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
  });

  it("renders calendar dates as a keyboard-operable grid", () => {
    expect(overlaySource).toContain('role="grid"');
    expect(overlaySource).toContain('role="columnheader"');
    expect(overlaySource).toContain('role="gridcell"');
    expect(overlaySource).toContain("calendarGridKeyTarget(date, event.key)");
    expect(overlaySource).toContain("tabIndex={date === selected ? 0 : -1}");
    expect(overlaySource).toContain("aria-selected={date === selected}");
  });
});
