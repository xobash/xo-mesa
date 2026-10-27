# Saved HTML

Mesa opens saved, imported, synced, and agent-written HTML offline by default.
Main and detached viewers use the same sanitized `srcDoc` document, empty
sandbox, opaque origin and no-referrer policy. Website scripts, forms, popups,
frames, refresh metadata and navigation are blocked in both resource modes.
HTML files over 8 MiB are refused before a detached read; native reads also
have an 8 MiB ceiling if the file grows after the size check.

Local images, video, posters, srcset and inline CSS image URLs use the approved
vault asset protocol on every platform. Stylesheet links and nested local
`@import` targets are inlined from inside the approved vault, with `.css`
extension, at most three import levels, cycle rejection and a shared 4 MiB
text budget. Each desktop stylesheet read is bounded before allocation.
Imported image and font URLs resolve against their own CSS file.
Unquoted HTML asset attributes are rewritten too.
CSS data-image SVG markup is percent-encoded before sanitization so it cannot
cause an otherwise valid stylesheet to be dropped. Inline SVG icons may reference a same-document `#id`; external SVG use
references are removed. Full viewers inline local `.woff`, `.woff2`, `.ttf`
and `.otf` fonts as data URLs, capped at 2 MiB per font and 8 MiB per document.
Native bounded reads enforce the font limit and approved vault scope.
CSS and fonts may use `../` inside that vault; paths outside it are refused.
Script-free views expand `noscript` fallbacks and lazy image sources before
sanitizing, including text-only reading. Root language, direction and theme
attributes survive the final frame document. Hover previews omit fonts and
never enable online resources. Large previews wait for hydration instead of
sanitizing a second synchronous fallback.

**Enable online resources** awaits confirmation before loading images, styles
and fonts through Mesa's native public-address broker. Consent applies only to
this viewing instance, vault generation, path and exact loaded version. Leaving
the file and returning to it requires new consent, even if its bytes are unchanged. Reopening,
changing the source or disabling resources returns to offline mode and revokes
the resource token. Remote audio and video remain blocked. Requests can disclose
reading activity to sites and CDNs. No cookies are sent for subresources.
The broker imposes the same limits as the [Pi reader](pi-agent.md#browser-reader).
Scripts never gain permission through resource consent.

**Run scripts** asks for consent for this exact file version. It loads the
original HTML through Mesa's separate `mesa-html` protocol in a frame with only
`allow-scripts`; it never adds same-origin, navigation, popup or modal grants.
The code can read supported files in its document folder and descendants,
including CSS, JavaScript, JSON, images, fonts, media and WebAssembly. It cannot
read sibling folders, follow escaping symlinks or use another window's token.
Native session creation checks the consented HTML bytes, and entry responses
must still match that version. Each response is capped at 32 MiB. Sessions are window-owned, capped at eight
and expire after ten idle minutes. Closing, changing the file or stopping
scripts revokes the token and returns to sanitized offline rendering.

Scripts start offline. **Enable script network** requires a separate confirmation
and permits direct HTTPS scripts, styles, images, fonts, media and fetches.
This path uses webview DNS, bypasses the reader's public-address broker and can
send folder data to websites, including reachable private HTTPS services.
It does not create an application IPC grant. Use it only for code you trust.
There is no per-vault or Pi-created-file bypass. Hover previews remain inert.

Run scripts is unavailable on Windows: the pinned WebView2 integration injects
Tauri initialization into subframes, so the required absent-IPC isolation has
not been established there. Use the system browser. macOS/Linux packaged frame
isolation requires native acceptance; source and unit tests alone do not prove it.
The app's script CSP stays unchanged; only its frame sources admit `mesa-html`.

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
