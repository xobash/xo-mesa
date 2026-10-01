import { useEffect, useState } from "react";
import { useAppStore } from "../store";
import { rtfToText } from "../lib/rtf";

/** Read-only viewer for .rtf files — converts RTF to readable text. */
export function RtfView({ rel }: { rel: string }) {
  const ensureContent = useAppStore((s) => s.ensureContent);
  const [text, setText] = useState("");

  useEffect(() => {
    let alive = true;
    void ensureContent(rel).then((c) => {
      if (alive) setText(rtfToText(c));
    });
    return () => {
      alive = false;
    };
  }, [rel, ensureContent]);

  return (
    <div className="rtf-view">
      <pre className="rtf-text">{text}</pre>
    </div>
  );
}
