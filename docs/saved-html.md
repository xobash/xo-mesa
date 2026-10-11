# Saved HTML

Mesa opens saved, imported, synced, and agent-written HTML offline by default.
The viewer and hover/search previews prepare a complete `srcDoc` document with
a dedicated policy before saved markup. An empty sandbox blocks scripts,
forms, popups, and origin access. DOMPurify removes executable markup, refresh
metadata, frames, base elements, and navigation links. The frame policy blocks
network connections and remote resources, including CSS imports, images,
fonts, media, nested frames, and objects. Local styles and scoped asset images
remain available; local stylesheet links are hydrated without loading scripts.
Stylesheet and script links are read and inlined only when they resolve inside the
saved page's own folder (for example a browser's `<name>_files/` folder), end in
`.css` (styles) or `.js`/`.mjs` (scripts), and are at most 4 MiB. A link that
climbs out of that folder, such as `../Private/journal.md`, is never read, so a
saved page cannot pull other vault notes into itself.
Referrer policy is always `no-referrer`.

**Enable online resources** asks for confirmation before remote resources may
contact websites and reveal data already in the document. Consent applies only
to this open viewer, vault generation, file path and loaded version. A version
change, reopening or disabling resources restores offline rendering.
Scripts remain stripped and blocked in both modes. Forms, frame navigation,
popups, origin access and native commands stay unavailable. The parent app CSP
can additionally block resources such as external styles. Detached HTML uses
the same policy; hover previews never enable online resources.

Both the Pi browser's Archive action and accepted Deep Research sources use
`src/lib/webArchive.ts`. Capture is an explicit network operation. It writes
through verified vault persistence under `Web Archives/`, preserves a
saved-from marker and original-URL metadata, and
writes a source-link record when fetching fails. The offline renderer removes
that base and disables navigation links in both modes. Capture
metadata does not grant networking permission on reopen.

The shared rendering boundary is `src/lib/html.ts`.
`stripSavedHtmlPreviewCode` is a preview optimization, not a sanitizer. Its
output must use the shared frame policy and an iframe with `sandbox=""`;
code stripping alone does not remove forms or block remote resources.
Preview cards decline
files larger than four million characters and never use truncated text as a
complete HTML document. Tests cover hydration, hostile metadata and links,
offline policy, confirmation, consent revocation, detached files, archive
metadata, and stale preview reads.
