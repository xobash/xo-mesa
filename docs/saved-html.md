# Saved HTML

Mesa opens saved, imported, synced, and agent-written HTML offline by default.
The viewer and hover/search previews prepare a complete `srcDoc` document with
a dedicated policy before saved markup. An empty sandbox blocks scripts,
forms, popups, and origin access. DOMPurify removes executable markup, refresh
metadata, frames, base elements, and navigation links. The frame policy blocks
network connections and remote resources, including CSS imports, images,
fonts, media, nested frames, and objects. Local styles and scoped asset images
remain available; local stylesheet links are hydrated without loading scripts.
Referrer policy is always `no-referrer`.

**Enable active content** asks for confirmation that scripts and remote
resources may contact websites and transmit data already in this document.
Consent applies only to this open viewer, vault generation, file path, and
loaded version. Navigation, file changes, reopening, or disabling active
content returns to offline rendering. Active frames retain an opaque origin:
`allow-same-origin` is never granted. Mesa's parent CSP remains in effect, so
some remote or module scripts may still be blocked. Consent does not grant
Tauri commands or read access to Mesa's asset origin. Detached HTML windows use
the same viewer and policy. Hover previews never enable active content.

Both the Pi browser's Archive action and accepted Deep Research sources use
`src/lib/webArchive.ts`. Capture is an explicit network operation. It writes
through verified vault persistence under `Web Archives/`, preserves a
saved-from marker and original-URL base for opt-in interactive rendering, and
writes a source-link record when fetching fails. The offline renderer removes
that base and disables the link until active content is approved. Capture
metadata does not grant networking permission on reopen.

The shared rendering boundary is `src/lib/html.ts`. Preview cards decline
files larger than four million characters and never use truncated text as a
complete HTML document. Tests cover hydration, hostile metadata and links,
offline policy, confirmation, consent revocation, detached files, archive
metadata, and stale preview reads.
