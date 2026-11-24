import { useId, useState, type ReactNode } from "react";
import { UI_STYLES } from "../store";
import type { UiStyleId } from "../lib/persistedUi";

/** One Settings row: name, optional description, and its control on the right. */
export function SettingRow({ name, desc, className = "", children }: { name: string; desc?: ReactNode; className?: string; children: ReactNode }) {
  return (
    <div className={"setting-row" + (className ? " " + className : "")}>
      <div className="setting-meta">
        <div className="setting-name">{name}</div>
        {desc ? <div className="setting-desc">{desc}</div> : null}
      </div>
      {children}
    </div>
  );
}

/** Inner "More" disclosure for rarely used options. Closed content is not mounted. */
export function MoreSettings({ label = "More", children }: { label?: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  return (
    <div className="settings-more">
      <button
        type="button"
        className="settings-more-toggle"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="settings-more-chevron" aria-hidden="true">{open ? "\u25BE" : "\u25B8"}</span>
        {label}
      </button>
      <div id={panelId} className="settings-more-body" hidden={!open}>
        {open ? children : null}
      </div>
    </div>
  );
}

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
