import { lazy, Suspense, type ComponentProps } from "react";

const RtfViewImpl = lazy(() =>
  import("./RtfView").then((module) => ({ default: module.RtfView }))
);

/** RTF viewer and editor; its parser and editor load only when an RTF file opens. */
export function RtfView(props: ComponentProps<typeof RtfViewImpl>) {
  return (
    <Suspense fallback={<div className="editor-empty">Loading RTF…</div>}>
      <RtfViewImpl {...props} />
    </Suspense>
  );
}
