/** User-assigned hotkeys for command-palette commands, stored in settings as
 * command id -> canonical chord ("Mod+Shift+K"). `Mod` is Cmd on macOS and
 * Ctrl elsewhere, so one setting works on every platform without taking the
 * other key (terminal and text-field Ctrl chords on macOS stay free). */

type KeyLike = Pick<KeyboardEvent, "key" | "code" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey"> &
  Partial<Pick<KeyboardEvent, "getModifierState">>;

export const IS_MAC = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

const MODIFIERS = ["Mod", "Alt", "Shift"] as const;
const NAMED_KEYS = new Set([
  "Enter", "Escape", "Tab", "Space", "Backspace", "Delete", "Home", "End", "PageUp", "PageDown",
  "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight",
  ...Array.from({ length: 12 }, (_, index) => `F${index + 1}`),
]);
const PUNCTUATION = new Set([",", ".", "/", ";", "'", "[", "]", "\\", "-", "=", "`"]);
const CODE_PUNCTUATION: Record<string, string> = {
  Comma: ",", Period: ".", Slash: "/", Semicolon: ";", Quote: "'", BracketLeft: "[",
  BracketRight: "]", Backslash: "\\", Minus: "-", Equal: "=", Backquote: "`",
};

/** Chords Mesa or the editor already own. Assigning one would shadow it. */
export const RESERVED_HOTKEYS: Readonly<Record<string, string>> = {
  "Mod+P": "Command palette",
  "Mod+N": "New note",
  "Mod+,": "Settings",
  "Mod+Shift+F": "Search in all notes",
  "Mod+F": "Find in note",
  "Mod+W": "Window commands",
  "Mod+Z": "Undo",
  "Mod+Shift+Z": "Redo",
  "Mod+Y": "Redo",
  "Mod+A": "Select all",
  "Mod+C": "Copy",
  "Mod+X": "Cut",
  "Mod+V": "Paste",
  "Mod+Q": "Quit",
  "Mod+Shift+Enter": "Move surface between windows",
  "Shift+Tab": "Overlay",
  // CodeMirror default keymap (basicSetup).
  "Mod+D": "Select next match",
  "Mod+/": "Toggle comment",
  "Mod+[": "Outdent",
  "Mod+]": "Indent",
  "Mod+Enter": "Insert blank line",
  "Mod+G": "Find next",
  "Mod+Shift+G": "Find previous",
  "Mod+Shift+K": "Delete line",
  "Mod+Shift+L": "Select all matches",
  "Mod+L": "Select line",
  "Mod+I": "Select syntax parent",
  "Mod+Shift+\\": "Go to matching bracket",
  "Mod+Alt+[": "Fold",
  "Mod+Alt+]": "Unfold",
  "Mod+Space": "Autocomplete",
};

// Mesa's own handlers match these keys with Mod whatever other modifiers are
// held; caret movement and deletion keys belong to the editor and text fields.
const RESERVED_WITH_MOD: Readonly<Record<string, string>> = {
  P: "Command palette", N: "New note", ",": "Settings", W: "Window commands", Q: "Quit",
};
const EDITING_KEYS = new Set(["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End", "Backspace", "Delete", "PageUp", "PageDown"]);

/** What already owns `chord`, or null when it is free to assign. */
export function reservedBy(chord: string): string | null {
  if (RESERVED_HOTKEYS[chord]) return RESERVED_HOTKEYS[chord];
  const parts = chord.split("+");
  const key = parts[parts.length - 1];
  if (parts.includes("Mod") && RESERVED_WITH_MOD[key]) return RESERVED_WITH_MOD[key];
  if ((parts.includes("Mod") || parts.includes("Alt")) && EDITING_KEYS.has(key)) return "Text editing";
  return null;
}

/** The key part of a chord from a keyboard event, layout-independent for
 * letters, digits and punctuation (Alt on macOS changes `key`, not `code`). */
function keyName(event: KeyLike): string | null {
  if (/^Key[A-Z]$/.test(event.code)) return event.code.slice(3);
  if (/^Digit[0-9]$/.test(event.code)) return event.code.slice(5);
  if (CODE_PUNCTUATION[event.code]) return CODE_PUNCTUATION[event.code];
  if (event.key === " ") return "Space";
  if (NAMED_KEYS.has(event.key)) return event.key;
  if (event.key.length === 1) return event.key.toUpperCase();
  return null;
}

/** Canonical chord for a keydown, or null for a bare modifier press. */
export function hotkeyFromEvent(event: KeyLike, mac = IS_MAC): string | null {
  if (["Meta", "Control", "Alt", "AltGraph", "Shift", "OS"].includes(event.key)) return null;
  // AltGr (Ctrl+Alt on Windows) types characters on many layouts; never a chord.
  if (event.getModifierState?.("AltGraph")) return null;
  // The non-Mod key (Ctrl on macOS, Win/Super elsewhere) is not part of any chord.
  if (mac ? event.ctrlKey : event.metaKey) return null;
  const key = keyName(event);
  if (!key) return null;
  const parts: string[] = [];
  if (mac ? event.metaKey : event.ctrlKey) parts.push("Mod");
  if (event.altKey) parts.push("Alt");
  if (event.shiftKey) parts.push("Shift");
  parts.push(key);
  return parts.join("+");
}

/** Canonical form of a stored chord, or null when it is not a usable chord.
 * A chord needs Mod or Alt, or a function key, so plain typing never runs a command. */
export function normalizeHotkey(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const raw = value.split("+").map((part) => part.trim());
  // "Mod++" names the plus key, which Mesa does not bind.
  if (raw.length < 1 || raw.some((part) => !part)) return null;
  const key = raw[raw.length - 1];
  const mods = new Set<string>();
  for (const part of raw.slice(0, -1)) {
    const name = /^(cmd|ctrl|meta|control|mod)$/i.test(part) ? "Mod" : /^(alt|option)$/i.test(part) ? "Alt" : /^shift$/i.test(part) ? "Shift" : null;
    if (!name || mods.has(name)) return null;
    mods.add(name);
  }
  const named = [...NAMED_KEYS].find((name) => name.toLowerCase() === key.toLowerCase());
  const keyPart = named ?? (/^[a-z0-9]$/i.test(key) ? key.toUpperCase() : PUNCTUATION.has(key) ? key : null);
  if (!keyPart) return null;
  if (!mods.has("Mod") && !mods.has("Alt") && !/^F\d+$/.test(keyPart)) return null;
  return [...MODIFIERS.filter((name) => mods.has(name)), keyPart].join("+");
}

/** Validate the persisted map: known shape, canonical chords, one command per chord. */
export function normalizeHotkeys(value: unknown): Record<string, string> {
  const result: Record<string, string> = {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return result;
  const used = new Set<string>();
  for (const [id, chord] of Object.entries(value as Record<string, unknown>)) {
    const normalized = normalizeHotkey(chord);
    if (!/^[a-z0-9-]{1,64}$/.test(id) || !normalized || used.has(normalized) || reservedBy(normalized)) continue;
    used.add(normalized);
    result[id] = normalized;
  }
  return result;
}

/** Why `chord` cannot be assigned to `commandId`, or null when it can. */
export function hotkeyConflict(
  hotkeys: Readonly<Record<string, string>>,
  commandId: string,
  chord: string,
  labelFor: (id: string) => string = (id) => id
): string | null {
  if (!normalizeHotkey(chord)) return "Use Ctrl/Cmd or Alt with a key, or a function key.";
  const reserved = reservedBy(chord);
  if (reserved) return `${formatHotkey(chord)} is used by ${reserved}.`;
  const owner = Object.entries(hotkeys).find(([id, value]) => value === chord && id !== commandId)?.[0];
  return owner ? `${formatHotkey(chord)} is assigned to ${labelFor(owner)}.` : null;
}

/** Command id bound to the event's chord, if any. */
export function commandForEvent(hotkeys: Readonly<Record<string, string>>, event: KeyLike, mac = IS_MAC): string | null {
  const chord = hotkeyFromEvent(event, mac);
  if (!chord) return null;
  return Object.entries(hotkeys).find(([, value]) => value === chord)?.[0] ?? null;
}

/** Display form: ⌘⇧K on macOS, Ctrl+Shift+K elsewhere. */
export function formatHotkey(chord: string, mac = IS_MAC): string {
  const parts = chord.split("+");
  const key = parts.pop() ?? "";
  if (mac) {
    const symbols: Record<string, string> = { Mod: "⌘", Alt: "⌥", Shift: "⇧" };
    return parts.map((part) => symbols[part] ?? part).join("") + key;
  }
  return [...parts.map((part) => (part === "Mod" ? "Ctrl" : part)), key].join("+");
}
