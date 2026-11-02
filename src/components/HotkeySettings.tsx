import { useState } from "react";
import { useAppStore } from "../store";
import { formatHotkey, hotkeyConflict, hotkeyFromEvent } from "../lib/hotkeys";
import { PALETTE_COMMANDS, paletteCommandLabel } from "./paletteCommands";

/** Assign, change or clear a hotkey for each command-palette command. */
export function HotkeySettings() {
  const hotkeys = useAppStore((s) => s.settings.hotkeys) ?? {};
  const setSetting = useAppStore((s) => s.setSetting);
  const [recording, setRecording] = useState<string | null>(null);
  const [message, setMessage] = useState<{ id: string; text: string } | null>(null);

  const record = (id: string, event: React.KeyboardEvent) => {
    if (event.key === "Tab") return;
    event.preventDefault();
    event.stopPropagation();
    if (event.key === "Escape") { setRecording(null); setMessage(null); return; }
    const chord = hotkeyFromEvent(event.nativeEvent);
    if (!chord) return;
    const conflict = hotkeyConflict(hotkeys, id, chord, paletteCommandLabel);
    if (conflict) { setMessage({ id, text: conflict }); return; }
    setSetting("hotkeys", { ...hotkeys, [id]: chord });
    setRecording(null);
    setMessage(null);
  };

  const clear = (id: string) => {
    const next = { ...hotkeys };
    delete next[id];
    setSetting("hotkeys", next);
    setMessage(null);
  };

  return (
    <div className="setting-row hotkey-settings">
      <div className="setting-meta">
        <div className="setting-name">Hotkeys</div>
        <div className="setting-desc">
          Assign a shortcut to any command-palette command. Use Ctrl/Cmd or Alt with a key, or a function key. Press Escape to cancel.
        </div>
      </div>
      <div className="hotkey-list">
        {PALETTE_COMMANDS.map((command) => {
          const chord = hotkeys[command.id];
          const active = recording === command.id;
          return (
            <div className="hotkey-row" key={command.id}>
              <span>{command.label}</span>
              <span className="hotkey-actions">
                {chord ? <kbd>{formatHotkey(chord)}</kbd> : command.hint ? <kbd aria-label="Built-in shortcut">{command.hint}</kbd> : null}
                <button
                  type="button"
                  className={"seg-btn" + (active ? " on" : "")}
                  data-hotkey-recorder={active ? "" : undefined}
                  aria-pressed={active}
                  aria-label={active ? `Press a shortcut for ${command.label}` : `Set shortcut for ${command.label}`}
                  onClick={() => { setRecording(active ? null : command.id); setMessage(null); }}
                  onKeyDown={active ? (event) => record(command.id, event) : undefined}
                  onBlur={() => { if (active) setRecording(null); }}
                >
                  {active ? "Press keys…" : chord ? "Change" : "Set"}
                </button>
                {chord && !active && (
                  <button type="button" className="seg-btn" aria-label={`Clear shortcut for ${command.label}`} onClick={() => clear(command.id)}>
                    Clear
                  </button>
                )}
              </span>
              {message?.id === command.id && <span className="hotkey-conflict" role="alert">{message.text}</span>}
            </div>
          );
        })}
      </div>
    </div>
  );
}
