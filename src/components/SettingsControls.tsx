import { UI_STYLES } from "../store";
import type { UiStyleId } from "../lib/persistedUi";

/** On/off switch shared by the Settings modal and the overlay settings. */
export function SettingToggle({
  label,
  on,
  onChange,
}: {
  label: string;
  on: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <button
      className={"toggle" + (on ? " on" : "")}
      role="switch"
      aria-checked={on}
      aria-label={label}
      onClick={() => onChange(!on)}
    >
      <span className="toggle-knob" />
    </button>
  );
}

/** Segmented "Interface style" picker; one pressed button per UI style. */
export function InterfaceStyleChoice({ value, onChange }: { value: UiStyleId; onChange: (style: UiStyleId) => void }) {
  return (
    <div className="seg theme-seg" aria-label="Interface style">
      {UI_STYLES.map((u) => (
        <button
          key={u.id}
          className={"seg-btn" + (u.id === value ? " on" : "")}
          title={u.blurb}
          aria-pressed={u.id === value}
          onClick={() => onChange(u.id)}
        >
          {u.label}
        </button>
      ))}
    </div>
  );
}
