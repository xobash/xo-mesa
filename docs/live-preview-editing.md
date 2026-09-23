# Live Preview Editing

Markdown editing stays source-first so Mesa never loses source fidelity.

The editor has two modes:

- `Source` shows the CodeMirror Markdown editor only.
- `Live` keeps CodeMirror on the left and renders the same Markdown on the
  right as you type.

The rendered pane is intentionally read-only. Source remains the canonical
document because arbitrary rendered HTML cannot be reliably converted back into
the original Markdown without losing formatting, comments, raw HTML, or plugin
syntax. Edits from other Mesa surfaces, such as Kanban task movement, refresh the
active CodeMirror document as long as they modify the same note.

Wiki links can open every text file Mesa supports. An exact target such as
`[[Notes/Log.txt]]` opens that file without changing its extension. A bare
target first uses a Markdown file when names are ambiguous. It then uses another
text file, such as `Log.txt`. Binary files do not resolve as text links.

Hover preview cards use the same rendered Markdown path as the editor preview.
When the pointer enters a sidebar file, Mesa starts a safe read-only cache warmup
immediately, while the card itself still respects the configured hover delay.
Opening that file, the hover card, and read-only viewers then share the same
in-flight content read instead of starting duplicate vault reads. Markdown HTML
is prepared during render so a visible preview does not wait for a later effect
before showing the first content.
