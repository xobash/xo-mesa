export interface DetachedWindowPlacement {
  x: number;
  y: number;
  width?: number;
  height?: number;
}

/**
 * A title/header drag becomes a native-window tear-off when released outside
 * the webview or directly against one of its edges. The small inside-edge
 * allowance matters because some webviews stop reporting pointer coordinates
 * the instant the cursor crosses their OS-window boundary.
 */
export function isWindowTearOffPoint(
  clientX: number,
  clientY: number,
  viewportWidth: number,
  viewportHeight: number,
  edgePx = 8
): boolean {
  if (![clientX, clientY, viewportWidth, viewportHeight, edgePx].every(Number.isFinite)) {
    return false;
  }
  if (viewportWidth <= 0 || viewportHeight <= 0 || edgePx < 0) return false;
  return (
    clientX <= edgePx ||
    clientY <= edgePx ||
    clientX >= viewportWidth - edgePx ||
    clientY >= viewportHeight - edgePx
  );
}

/** Keep the grabbed title-bar point under the cursor when the native window opens. */
export function detachedWindowPlacement(input: {
  screenX: number;
  screenY: number;
  grabOffsetX: number;
  grabOffsetY: number;
  width?: number;
  height?: number;
}): DetachedWindowPlacement {
  const width = finitePositive(input.width);
  const height = finitePositive(input.height);
  return {
    x: Math.round(input.screenX - Math.max(0, input.grabOffsetX)),
    y: Math.round(input.screenY - Math.max(0, input.grabOffsetY)),
    ...(width ? { width: Math.round(width) } : {}),
    ...(height ? { height: Math.round(height) } : {}),
  };
}

function finitePositive(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : undefined;
}
