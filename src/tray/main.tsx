import ReactDOM from "react-dom/client";
import { TrayPopover } from "./TrayPopover";
import { trayPlatform } from "./platform";
import "./tray.css";

// Selects the Windows 11 flyout look in tray.css before the first paint.
document.documentElement.dataset.platform = trayPlatform(navigator.userAgent);
ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(<TrayPopover />);
