export interface MenuPoint {
  x: number;
  y: number;
}

export interface MenuSize {
  width: number;
  height: number;
}

export interface ViewportSize {
  width: number;
  height: number;
}

function clamp(value: number, min: number, max: number): number {
  if (max < min) return min;
  return Math.min(Math.max(value, min), max);
}

export function clampFloatingMenuPosition(
  point: MenuPoint,
  viewport: ViewportSize,
  menu: MenuSize,
  margin = 8
): { left: number; top: number } {
  return {
    left: clamp(point.x, margin, viewport.width - menu.width - margin),
    top: clamp(point.y, margin, viewport.height - menu.height - margin),
  };
}
