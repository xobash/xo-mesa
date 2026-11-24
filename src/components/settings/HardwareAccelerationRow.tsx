import { useEffect, useState } from "react";
import { readGraphicsAcceleration, saveGraphicsAcceleration, type GraphicsState } from "../../lib/graphicsAcceleration";
import { SettingRow, SettingToggle } from "../SettingsControls";

const NAME = "Hardware acceleration";

function description(state: GraphicsState): string {
  if (!state.controllable) return "macOS always draws Mesa with the graphics processor (Metal). Apple gives apps no switch for it.";
  return "Draw Mesa with the graphics processor. Turn it off if windows flicker, stay blank or draw wrongly. Applies after you restart Mesa.";
}

/** Launch-time GPU switch (WebView2 on Windows, WebKitGTK on Linux). Hidden in the browser preview. */
export function HardwareAccelerationRow() {
  const [state, setState] = useState<GraphicsState | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let current = true;
    readGraphicsAcceleration().then(
      (next) => { if (current) setState(next); },
      (err: unknown) => { if (current) setError(String(err)); },
    );
    return () => { current = false; };
  }, []);
  if (!state) return error ? <SettingRow name={NAME} desc={<span className="setting-error">{error}</span>}><span /></SettingRow> : null;
  const change = (enabled: boolean) => {
    setError("");
    saveGraphicsAcceleration(enabled).then(
      (next) => { if (next) setState(next); },
      (err: unknown) => setError(String(err)),
    );
  };
  const pending = state.controllable && state.saved !== state.active;
  return (
    <SettingRow
      name={NAME}
      desc={
        <>
          {description(state)}
          {pending ? <span role="status"> Restart Mesa to apply this change.</span> : null}
          {error ? <span className="setting-error" role="alert"> {error}</span> : null}
        </>
      }
    >
      {state.controllable
        ? <SettingToggle label={NAME} on={state.saved} onChange={change} />
        : <span className="settings-version">Always on</span>}
    </SettingRow>
  );
}
