# Saved HTML Rendering

Mesa renders saved webpages as webpages, not as unstyled source dumps.

There are two capture entry points:

- the Pi browser's manual **Archive** action;
- Deep Research's default automatic archive of only the final validated
  `result.sources` set.

Both use `src/lib/webArchive.ts`, write through the vault's verified-write
path, and store files under `Web Archives/`. A fetched page receives a
browser-compatible saved-from marker and an original-URL `<base>` when it does
not already define one. That lets local rendering resolve relative page URLs.
When the body cannot be fetched, Mesa writes a local source-link record instead
of pretending a full page was captured. These records open in the same HTML
viewer.

Saved browser pages usually contain an `.html` file plus a sibling asset folder
such as `Example_files/`. They also often contain root-relative URLs from the
original website, like `/_next/static/...`.

The desktop render path is:

1. Load the saved `.html` file itself into the iframe through Tauri's asset
   protocol.
2. Let the webview resolve sibling `*_files` CSS/JS from the saved page folder,
   which matches how a browser opens the local file.
3. Keep source view backed by the vault content cache.

Do not make `srcDoc` the primary desktop renderer. Browser-saved Next/Turbopack
pages can be fragile when their document URL is `about:srcdoc`; loading the real
saved file gives the iframe a stable base URL and fixes local CSS chunk loading.
Do not auto-fallback from the desktop `src` iframe to `srcDoc` based on an early
stylesheet-count probe. Saved app pages can load CSS/JS late or hide stylesheet
inspection behind protocol/origin behavior, and switching to `srcDoc` destroys
the saved file's natural base URL.

The browser/demo fallback path is:

1. Read the HTML file as text with the same vault content cache used by source
   view.
2. Parse the browser comment `<!-- saved from url=(...)... -->` when present.
3. Inline local browser-saved stylesheet links from the sibling `_files` folder
   because some webviews do not reliably fetch `asset://` CSS from an
   `about:srcdoc` iframe.
4. Rewrite CSS `url(...)` and `@import` references relative to the stylesheet
   file they came from.
5. Inline local saved script chunks when they live beside the saved page.
6. Rewrite remaining local relative `src`, `href`, `poster`, `action`, and
   `srcset` values through `urlForPath`.
7. Rewrite root-relative URLs against the original saved-from site.
8. Inject a local `<base>` pointing at the saved file's folder.
9. Feed the hydrated document into the iframe with `srcDoc`.

The shared fallback helper is `src/lib/html.ts`; both `HtmlView` and hover
previews keep it for non-Tauri rendering. Regression coverage lives in
`src/lib/html.test.ts`. Capture/metadata/fallback coverage lives in
`src/lib/webArchive.test.ts`.
