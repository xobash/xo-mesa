import { useEffect, useState, type ReactNode } from "react";
import { appVersion } from "../../lib/appVersion";
import { SettingRow } from "../SettingsControls";

/** The running version, then the Updates section passed in as `children`. */
export function UpdatesGroup({ children }: { children?: ReactNode }) {
  const [version, setVersion] = useState("");
  useEffect(() => {
    let current = true;
    void appVersion().then((v) => { if (current) setVersion(v); });
    return () => { current = false; };
  }, []);
  return (
    <>
      <SettingRow name="Version" desc="The Mesa build you are running.">
        <span className="settings-version">{version || "…"}</span>
      </SettingRow>
      {children}
    </>
  );
}
