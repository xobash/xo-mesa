/** The popover opens on macOS and Windows only; WebView2 reports "Windows". */
export type TrayPlatform = "mac" | "windows";

export function trayPlatform(userAgent: string): TrayPlatform {
  return /Windows/.test(userAgent) ? "windows" : "mac";
}
