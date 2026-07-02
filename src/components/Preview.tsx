import { useAppStore } from "../store";
import { MarkdownView } from "./MarkdownView";
import { Backlinks } from "./Backlinks";
import { HtmlView } from "./HtmlView";
import { RtfView } from "./RtfView";
import { fileKind } from "../lib/vault";

export function Preview() {
  const content = useAppStore((s) => s.content);
  const activePath = useAppStore((s) => s.activePath);
  const file = useAppStore((s) =>
    activePath ? s.files.find((f) => f.relPath === activePath) : undefined
  );

  if (!activePath) {
    return <div className="preview-empty">Open a note to see its preview.</div>;
  }

  const kind = file ? fileKind(file.ext) : "text";
  if (kind === "html") return <HtmlView rel={activePath} />;
  if (kind === "rtf") return <RtfView rel={activePath} />;

  return (
    <div className="preview">
      <MarkdownView source={content} />
      <Backlinks />
    </div>
  );
}
