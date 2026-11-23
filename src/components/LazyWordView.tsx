import { lazy, Suspense, type ComponentProps } from "react";

const WordViewImpl = lazy(() =>
  import("./WordView").then((module) => ({ default: module.WordView }))
);

/** Word viewer and editor; the package checks load with the view, the layout engine only after. */
export function WordView(props: ComponentProps<typeof WordViewImpl>) {
  return (
    <Suspense fallback={<div className="editor-empty">Loading Word view…</div>}>
      <WordViewImpl {...props} />
    </Suspense>
  );
}
