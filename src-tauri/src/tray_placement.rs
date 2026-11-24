// Where the tray popover opens: beside its status item, on the side away from
// the bar that holds the item (macOS menu bar, Windows taskbar on any edge),
// and inside that monitor's work area. Plain arithmetic in physical pixels, so
// tests on every platform reach the Windows and macOS placement alike.

/// A screen rectangle in physical pixels.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct Rect {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

impl Rect {
    pub fn new(x: f64, y: f64, w: f64, h: f64) -> Self {
        Self { x, y, w, h }
    }
    /// The same rectangle in other units (`factor` = 1 / scale for points).
    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    pub fn scaled(self, factor: f64) -> Self {
        Self::new(
            self.x * factor,
            self.y * factor,
            self.w * factor,
            self.h * factor,
        )
    }
    fn right(&self) -> f64 {
        self.x + self.w
    }
    fn bottom(&self) -> f64 {
        self.y + self.h
    }
    fn center(&self) -> (f64, f64) {
        (self.x + self.w / 2.0, self.y + self.h / 2.0)
    }
}

/// The monitor edge the bar holding the status item is docked to.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Edge {
    Top,
    Bottom,
    Left,
    Right,
}

/// Distances in logical pixels; callers scale them per monitor.
#[derive(Clone, Copy, Debug)]
pub(crate) struct Spacing {
    /// From the item to the popover.
    pub gap: f64,
    /// From the bar's work-area edge to the popover (0 lets the popover reach
    /// up to the bar, as the macOS menu bar popover does).
    pub bar_gap: f64,
    /// From the popover to the other work-area edges.
    pub margin: f64,
}

/// A bar that reserves space leaves the item outside the work area on its
/// side. An item inside the work area (the Windows 11 overflow flyout) belongs
/// to the inset side nearest it; with no inset at all (an auto-hidden bar) the
/// nearest monitor edge is the bar's edge.
pub(crate) fn bar_edge(icon: Rect, monitor: Rect, area: Rect) -> Edge {
    let (cx, cy) = icon.center();
    if cy < area.y {
        return Edge::Top;
    }
    if cy > area.bottom() {
        return Edge::Bottom;
    }
    if cx < area.x {
        return Edge::Left;
    }
    if cx > area.right() {
        return Edge::Right;
    }
    // (edge, inset of the work area on that side, item distance to that side)
    let sides = [
        (Edge::Top, area.y - monitor.y, cy - monitor.y),
        (
            Edge::Bottom,
            monitor.bottom() - area.bottom(),
            monitor.bottom() - cy,
        ),
        (Edge::Left, area.x - monitor.x, cx - monitor.x),
        (
            Edge::Right,
            monitor.right() - area.right(),
            monitor.right() - cx,
        ),
    ];
    let inset = sides.iter().any(|side| side.1 > 0.5);
    let mut best: Option<(Edge, f64)> = None;
    for (edge, side_inset, distance) in sides {
        if inset && side_inset <= 0.5 {
            continue;
        }
        if best.is_none_or(|(_, nearest)| distance < nearest) {
            best = Some((edge, distance));
        }
    }
    best.map_or(Edge::Bottom, |(edge, _)| edge)
}

/// The popover's height limit (physical pixels) between the bar and the far
/// side of the work area.
pub(crate) fn room(icon: Rect, area: Rect, edge: Edge, space: Spacing, scale: f64) -> f64 {
    let gap = space.gap * scale;
    let margin = space.margin * scale;
    let bar_gap = space.bar_gap * scale;
    let room = match edge {
        Edge::Top => area.bottom() - margin - (icon.bottom() + gap).max(area.y + bar_gap),
        Edge::Bottom => (icon.y - gap).min(area.bottom() - bar_gap) - (area.y + margin),
        Edge::Left | Edge::Right => area.h - 2.0 * margin,
    };
    room.max(0.0)
}

/// Top-left corner for a `size` popover: `gap` off the item and `bar_gap` off
/// the bar,
/// centred on the item along the bar, and kept inside the work area.
pub(crate) fn origin(
    icon: Rect,
    area: Rect,
    edge: Edge,
    size: (f64, f64),
    space: Spacing,
    scale: f64,
) -> (f64, f64) {
    let gap = space.gap * scale;
    let bar_gap = space.bar_gap * scale;
    let margin = space.margin * scale;
    let (w, h) = size;
    let (cx, cy) = icon.center();
    // Along the bar the popover centres on the item, `margin` from the ends.
    let along_x = clamp(cx - w / 2.0, area.x + margin, area.right() - w - margin);
    let along_y = clamp(cy - h / 2.0, area.y + margin, area.bottom() - h - margin);
    // Across the bar it keeps both gaps, never outside the work area.
    let (x, y) = match edge {
        Edge::Top => (along_x, (icon.bottom() + gap).max(area.y + bar_gap)),
        Edge::Bottom => (along_x, (icon.y - gap).min(area.bottom() - bar_gap) - h),
        Edge::Left => ((icon.right() + gap).max(area.x + bar_gap), along_y),
        Edge::Right => ((icon.x - gap).min(area.right() - bar_gap) - w, along_y),
    };
    (
        clamp(x, area.x, area.right() - w),
        clamp(y, area.y, area.bottom() - h),
    )
}

/// `value` within `[low, high]`; a popover larger than the span keeps `low`.
fn clamp(value: f64, low: f64, high: f64) -> f64 {
    value.min(high).max(low)
}

#[cfg(test)]
mod tests {
    use super::*;

    const MAC: Spacing = Spacing {
        gap: 6.0,
        bar_gap: 0.0,
        margin: 8.0,
    };
    const WIN: Spacing = Spacing {
        gap: 12.0,
        bar_gap: 12.0,
        margin: 12.0,
    };

    /// A 1920x1080 monitor at `x` with a 48 px taskbar on `edge`.
    fn screen(x: f64, edge: Edge, scale: f64) -> (Rect, Rect) {
        let (w, h, bar) = (1920.0 * scale, 1080.0 * scale, 48.0 * scale);
        let monitor = Rect::new(x, 0.0, w, h);
        let area = match edge {
            Edge::Bottom => Rect::new(x, 0.0, w, h - bar),
            Edge::Top => Rect::new(x, bar, w, h - bar),
            Edge::Left => Rect::new(x + bar, 0.0, w - bar, h),
            Edge::Right => Rect::new(x, 0.0, w - bar, h),
        };
        (monitor, area)
    }

    fn inside(origin: (f64, f64), size: (f64, f64), area: Rect) -> bool {
        origin.0 >= area.x
            && origin.1 >= area.y
            && origin.0 + size.0 <= area.right() + 1e-9
            && origin.1 + size.1 <= area.bottom() + 1e-9
    }

    #[test]
    fn macos_popover_hangs_under_the_menu_bar_item() {
        let monitor = Rect::new(0.0, 0.0, 1440.0, 900.0);
        let area = Rect::new(0.0, 25.0, 1440.0, 875.0);
        let icon = Rect::new(700.0, 0.0, 30.0, 24.0);
        assert_eq!(bar_edge(icon, monitor, area), Edge::Top);
        assert_eq!(
            origin(icon, area, Edge::Top, (340.0, 620.0), MAC, 1.0),
            (545.0, 30.0)
        );
        // An item at the right end keeps the popover on screen.
        let icon = Rect::new(1420.0, 0.0, 30.0, 24.0);
        assert_eq!(
            origin(icon, area, Edge::Top, (340.0, 620.0), MAC, 1.0),
            (1092.0, 30.0)
        );
        assert_eq!(room(icon, area, Edge::Top, MAC, 1.0), 900.0 - 8.0 - 30.0);
    }

    #[test]
    fn windows_popover_opens_off_each_taskbar_edge() {
        let size = (620.0, 400.0);
        // Bottom taskbar, item near the clock: above the bar, right end kept 12 px in.
        let (monitor, area) = screen(0.0, Edge::Bottom, 1.0);
        let icon = Rect::new(1700.0, 1040.0, 32.0, 32.0);
        assert_eq!(bar_edge(icon, monitor, area), Edge::Bottom);
        assert_eq!(
            origin(icon, area, Edge::Bottom, size, WIN, 1.0),
            (1920.0 - 620.0 - 12.0, 1032.0 - 12.0 - 400.0)
        );
        assert_eq!(room(icon, area, Edge::Bottom, WIN, 1.0), 1032.0 - 24.0);
        // Top taskbar: below the bar.
        let (monitor, area) = screen(0.0, Edge::Top, 1.0);
        let icon = Rect::new(900.0, 8.0, 32.0, 32.0);
        assert_eq!(bar_edge(icon, monitor, area), Edge::Top);
        assert_eq!(
            origin(icon, area, Edge::Top, size, WIN, 1.0),
            (916.0 - 310.0, 48.0 + 12.0)
        );
        // Left taskbar: right of the bar, centred on the item vertically.
        let (monitor, area) = screen(0.0, Edge::Left, 1.0);
        let icon = Rect::new(8.0, 600.0, 32.0, 32.0);
        assert_eq!(bar_edge(icon, monitor, area), Edge::Left);
        assert_eq!(
            origin(icon, area, Edge::Left, size, WIN, 1.0),
            (48.0 + 12.0, 616.0 - 200.0)
        );
        assert_eq!(room(icon, area, Edge::Left, WIN, 1.0), 1080.0 - 24.0);
        // Right taskbar, item at the bottom corner: left of the bar, kept on screen.
        let (monitor, area) = screen(0.0, Edge::Right, 1.0);
        let icon = Rect::new(1880.0, 1040.0, 32.0, 32.0);
        assert_eq!(bar_edge(icon, monitor, area), Edge::Right);
        assert_eq!(
            origin(icon, area, Edge::Right, size, WIN, 1.0),
            (1872.0 - 12.0 - 620.0, 1080.0 - 12.0 - 400.0)
        );
    }

    #[test]
    fn hidden_taskbar_and_overflow_items_use_the_nearest_edge() {
        // Auto-hide: the work area is the whole monitor.
        let monitor = Rect::new(0.0, 0.0, 1920.0, 1080.0);
        let bottom = Rect::new(1700.0, 1046.0, 32.0, 32.0);
        assert_eq!(bar_edge(bottom, monitor, monitor), Edge::Bottom);
        let left = Rect::new(2.0, 500.0, 32.0, 32.0);
        assert_eq!(bar_edge(left, monitor, monitor), Edge::Left);
        // Windows 11 overflow flyout: the item floats above a bottom taskbar.
        let (monitor, area) = screen(0.0, Edge::Bottom, 1.0);
        let overflow = Rect::new(1600.0, 900.0, 32.0, 32.0);
        assert_eq!(bar_edge(overflow, monitor, area), Edge::Bottom);
        let at = origin(overflow, area, Edge::Bottom, (620.0, 400.0), WIN, 1.0);
        assert_eq!(at.1, 900.0 - 12.0 - 400.0);
        // An overflow item near the right end is nearer the right monitor edge
        // than the bottom one, but only the bottom has a taskbar.
        let corner = Rect::new(1840.0, 960.0, 32.0, 32.0);
        assert_eq!(bar_edge(corner, monitor, area), Edge::Bottom);
        // macOS: the menu bar and a bottom Dock both inset the work area; an
        // item in neither strip goes to the nearer inset side.
        let mac = Rect::new(0.0, 0.0, 1440.0, 900.0);
        let mac_area = Rect::new(0.0, 25.0, 1440.0, 800.0);
        let floating = Rect::new(700.0, 60.0, 30.0, 24.0);
        assert_eq!(bar_edge(floating, mac, mac_area), Edge::Top);
    }

    #[test]
    fn scale_factor_and_second_monitor_keep_the_popover_on_that_monitor() {
        // A 150% monitor to the right of a 100% primary, taskbar at its bottom.
        let scale = 1.5;
        let (monitor, area) = screen(1920.0, Edge::Bottom, scale);
        let icon = Rect::new(1920.0 + 2700.0, 1560.0, 48.0, 48.0);
        assert_eq!(bar_edge(icon, monitor, area), Edge::Bottom);
        let size = (620.0 * scale, 560.0 * scale);
        let at = origin(icon, area, Edge::Bottom, size, WIN, scale);
        assert!(inside(at, size, area), "{at:?}");
        // Margins and gaps scale with the monitor.
        assert_eq!(at.0, area.right() - size.0 - 12.0 * scale);
        assert_eq!(at.1, area.bottom() - 12.0 * scale - size.1);
        // A monitor left of the primary has negative coordinates.
        let (monitor, area) = screen(-1920.0, Edge::Bottom, 1.0);
        let icon = Rect::new(-1900.0, 1040.0, 32.0, 32.0);
        assert_eq!(bar_edge(icon, monitor, area), Edge::Bottom);
        let at = origin(icon, area, Edge::Bottom, (620.0, 400.0), WIN, 1.0);
        assert_eq!(at.0, -1920.0 + 12.0);
        assert!(inside(at, (620.0, 400.0), area));
    }

    #[test]
    fn a_popover_larger_than_the_work_area_stays_at_its_top_left() {
        let area = Rect::new(0.0, 0.0, 500.0, 300.0);
        let icon = Rect::new(400.0, 300.0, 32.0, 32.0);
        assert_eq!(
            origin(icon, area, Edge::Bottom, (620.0, 560.0), WIN, 1.0),
            (0.0, 0.0)
        );
        // No room at all is zero, never negative.
        let squeezed = Rect::new(0.0, 0.0, 500.0, 10.0);
        let icon = Rect::new(400.0, 10.0, 32.0, 32.0);
        assert_eq!(room(icon, squeezed, Edge::Bottom, WIN, 1.0), 0.0);
    }
}
