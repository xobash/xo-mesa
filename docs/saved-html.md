# Saved HTML

Mesa opens saved, imported, synced, and agent-written HTML offline by default.
Main and detached viewers use the same sanitized `srcDoc` document, empty
sandbox, opaque origin and no-referrer policy. Website scripts, forms, popups,
frames, refresh metadata and navigation are blocked in both resource modes.
HTML files over 8 MiB are refused before a detached read; native reads also
have an 8 MiB ceiling if the file grows after the size check.

Local images, video, posters, srcset and inline CSS image URLs use the approved
vault asset protocol on every platform. Stylesheet links are inlined only from
the saved document's own folder, with `.css` extension and a 4 MiB limit.
CSS data-image SVG markup is percent-encoded before sanitization so it cannot
cause an otherwise valid stylesheet to be dropped. Inline SVG icons may reference a same-document `#id`; external SVG use
references are removed. Full viewers inline local `.woff`, `.woff2`, `.ttf`
and `.otf` fonts as data URLs, capped at 2 MiB per font and 8 MiB per document.
Native bounded reads enforce the font limit. Hover previews omit fonts and
never enable online resources. Large previews wait for hydration instead of
sanitizing a second synchronous fallback.

**Enable online resources** awaits confirmation before loading images, styles
and fonts through Mesa's native public-address broker. Consent applies only to
this viewer, vault generation, path and exact loaded version. Reopening,
changing the source or disabling resources returns to offline mode and revokes
the resource token. Remote audio and video remain blocked. Requests can disclose
reading activity to sites and CDNs. No cookies are sent for subresources.
The broker imposes the same limits as the [Pi reader](pi-agent.md#browser-reader).
Scripts never gain permission through resource consent.

**Open in system browser** opens only an existing `.html` or `.htm` file inside
an approved vault, checked natively. The system browser runs the document with
its normal browser behavior, including scripts and networking, outside Mesa.
It is available even when a file is too large for inline rendering.

Both Pi Archive and accepted Deep Research sources use `src/lib/webArchive.ts`.
Capture is an explicit network operation and uses verified create-only vault
writes under `Web Archives/`. A saved-from marker records source identity;
`mesa-archive` marks resources as web-relative, resolved against the original
page URL (or its authored base URL). Browser Save Page As documents lack that
marker and retain local `_files/` resolution. No base element is injected or
trusted at render time. Archives do not capture subresources for offline use;
remote images and styles require per-version online consent. A failed page
fetch produces an escaped source-link record. Capture metadata never grants
network permission on reopen.

Archiving registers the file before opening it, preserving tabs and the active
Research run. A vault change prevents publication into the new vault.

`src/lib/html.ts` owns rewriting, hydration and the frame boundary.
`stripSavedHtmlPreviewCode` is an optimization, not a sanitizer. Its output
still requires the shared frame policy and `sandbox=""`. Preview cards refuse
more than four million characters and never present truncated HTML as complete.
Existing HTML, frame, archive, viewer and reader test suites cover local assets,
CSS, fonts, SVG references, consent cancellation/revocation, size refusal and
broker rewriting. Automated checks do not establish packaged cross-platform
webview acceptance.
