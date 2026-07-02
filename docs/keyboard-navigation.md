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
