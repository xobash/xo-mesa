import { useAppStore } from "../store";
import { MarkdownView } from "./MarkdownView";
import { Backlinks } from "./Backlinks";
import { HtmlView } from "./HtmlView";
import { RtfView } from "./RtfView";
import { fileKind } from "../lib/vault";

export function Preview() {
  const content = useAppStore((s) => s.content);
  const activePath = useAppStore((s) => s.activePath);
  // Resolve through the store's identity-keyed index, not a linear scan: this
  // selector re-runs on EVERY store `set()` — including one per keystroke from
  // `setContentFromEditor` — and a `find` over a 4,165-file vault costs 16.6 us
  // a call versus 0.03 us indexed.
  const file = useAppStore((s) => (activePath ? s.fileFor(activePath) : undefined));

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
