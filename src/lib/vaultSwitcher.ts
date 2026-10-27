export interface RectLike {
  left: number;
  bottom: number;
}

export function vaultMenuPosition(
  rect: RectLike,
  viewportWidth: number,
  menuWidth = 320,
  margin = 8
): { left: number; top: number } {
  return {
    left: Math.max(margin, Math.min(rect.left, viewportWidth - menuWidth - margin)),
    top: rect.bottom + margin,
  };
}
