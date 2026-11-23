import { lazy, Suspense, type ComponentProps } from "react";

const SpreadsheetViewImpl = lazy(() =>
  import("./SpreadsheetView").then((module) => ({ default: module.SpreadsheetView }))
);

/** Excel workbook viewer and editor; its parser and grid load only when a workbook opens. */
export function SpreadsheetView(props: ComponentProps<typeof SpreadsheetViewImpl>) {
  return (
    <Suspense fallback={<div className="editor-empty">Loading workbook…</div>}>
      <SpreadsheetViewImpl {...props} />
    </Suspense>
  );
}
