import { lazy, Suspense, type ComponentProps } from "react";

const HtmlViewImpl = lazy(() =>
  import("./HtmlView").then((module) => ({ default: module.HtmlView }))
);

/** Saved-HTML viewer; it and its sanitizer load only when an HTML file opens. */
export function HtmlView(props: ComponentProps<typeof HtmlViewImpl>) {
  return (
    <Suspense fallback={<div className="editor-empty">Loading HTML view…</div>}>
      <HtmlViewImpl {...props} />
    </Suspense>
  );
}
