import { clamp } from "./clamp";

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
