# Keyboard Navigation

Mesa has a lightweight Vim-style navigation layer for workspace chrome. It is
active only when the user is not typing in an input, textarea, contenteditable
area, or CodeMirror editor.

## File Navigation

- `j` opens the next file in the current sidebar sort/filter order.
- `k` opens the previous file in the current sidebar sort/filter order.
- `gg` opens the first file.
- `G` opens the last file.
- `/` opens Mesa search.

## Window Navigation

- `h` moves focus left: right stack -> center -> sidebar.
- `l` moves focus right: sidebar -> center -> right stack.
- In the right stack, `j` and `k` move focus down/up between stacked panes.
- `Ctrl-W` or `Cmd-W` starts a window command:
  - `h/j/k/l` changes focused region or focused right-stack pane.
  - `Shift-H` moves the focused right-stack pane into the center.
  - `Shift-L` moves the center pane into the right stack.
  - `Shift-J` / `Shift-K` reorders the focused right-stack pane.
  - `q` or `c` closes the focused center/right view.
  - `f` flips the side stack between the left and right of the center.
- On a focused floating-window title bar, Arrow keys move the window and
  Shift+Arrow resizes it. Geometry remains contained in the visible viewport.
- On a focused Pi or Deep Research transfer bar, `Ctrl/Cmd+Shift+Enter` tears
  the surface out or docks it back. The same bar states the shortcut while
  focused; there is no separate pop-out or Dock button.

## View Commands

- `p` focuses or opens Preview.
- `t` focuses or opens Tasks.
- `v` returns the editor to the center.
- `b` toggles the sidebar.
- `Ctrl/Cmd+Left Shift+Space` opens the dedicated Pi overlay while Mesa is
  focused. The desktop app registers the closest native global equivalent,
  `Ctrl/Cmd+Shift+Space`, because the global shortcut plugin exposes generic
  Shift rather than left/right Shift.
- `Ctrl+Shift+Tab` rotates Pi's reasoning level while Pi is focused in Mesa
  (Control, not Command). `Alt+Shift+Tab` is also accepted as an alternate.
  Plain `Shift+Tab` opens the Mesa overlay. These bindings are the same on
  Windows, macOS, and Linux; `Cmd+Shift+Tab` is intentionally left to the OS.

The pure ordering and focus logic lives in `src/lib/keyboardNav.ts` with tests
in `src/lib/keyboardNav.test.ts`.

## Command Palette

`Ctrl/Cmd+P` opens the palette for note jumping. Type `>` to switch to task
commands. Command mode includes real workflow entries for search, tasks, sync,
diagnostics, recovery storage, revision history, Pi, Deep Research, settings,
graph, themes, daily notes, and opening a vault.

## Overlay Calendar

Calendar month dates form a keyboard-operable grid:

- `Tab` enters the grid at the selected date.
- Arrow keys move one day or one week.
- `Home` and `End` move to the Sunday or Saturday of the current row.
- `Enter` or `Space` selects the focused date.

Each date exposes its full date, selected/today state, and event/task/holiday
labels to assistive technology.

## Deep Research Evidence Graph

- `Tab` reaches each real evidence node and identifies it as a button.
- `Enter` or `Space` selects the node, keeps its preview open, and moves focus
  to the first available card action.
- `Escape` closes the selected preview.

## Dialogs and sync review

Dialog Tab navigation skips unavailable controls and includes disclosure summaries
such as **Advanced**, excluding controls inside collapsed sections. Plain
Shift+Tab retains its global overlay shortcut. Empty dialogs retain focus. Escape closes only the topmost
dialog and respects an already-handled event; closing restores a connected trigger.
Sync comparison focuses **Reviewed text** after reading both copies, and returns
to **Compare** after save or **Keep both**. All review actions have keyboard buttons.
The help tour describes header dragging and the Pi/Research
`Ctrl/Cmd+Shift+Enter` transfer shortcut using both platform modifier names.
