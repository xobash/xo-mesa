import type { NoteMeta, VaultFile } from "../types";
import type { DeepResearchResult, RelatedNote, ResearchClaim, SourceKind } from "./deepResearch";
import { DEFAULT_DEEP_RESEARCH_LIMITS, truncateUtf8, utf8ByteLength, type DeepResearchLimits } from "./deepResearchConfig";
import { safeFolderName, safeNoteTitle, titleSlug } from "./deepResearchNaming";
import { canonicalizeSourceUrl } from "./deepResearchUrls";
import { localISO } from "./daily";
import { makeResolver } from "./graph";
import { extractLinks } from "./markdownExtract";
import { uniqueRelPath } from "./fsnames";
import type { ProposedOp } from "./researchApplyPlan";

/** Deterministic report/source-note change set built from a validated research result. */

/** Source title as generated Markdown link text: one line, with brackets and backslashes escaped. */
function markdownLinkText(text: string): string {
  return text.replace(/\s+/g, " ").replace(/[\\[\]]/g, "\\$&");
}

/** URL as a generated Markdown link destination; angle brackets hold spaces and parentheses. */
function markdownLinkDestination(url: string): string {
  return /[\s()<>]/.test(url) ? `<${url.replace(/[\s<>]/g, (c) => encodeURIComponent(c))}>` : url;
}

export interface ResearchChangeSet {
  ops: ProposedOp[];
  folder: string;
  reportRelPath: string;
  createdRelPaths: string[];
  updatedRelPaths: string[];
  /** Notes skipped as duplicates (shown in the UI as "already exists"). */
  skippedDuplicates: { title: string; relPath: string; reason: string }[];
}

/** Build deterministic report/source notes and opt-in related-note updates; report skipped duplicate slugs and URLs. */
export function buildChangeSet(input: {
  runId: string;
  result: DeepResearchResult;
  folder: string;
  existingFiles: VaultFile[];
  notes: Record<string, NoteMeta>;
  content: Record<string, string>;
  now: Date;
  limits?: DeepResearchLimits;
}): ResearchChangeSet {
  const { result, existingFiles, notes, content } = input;
  const limits = input.limits ?? DEFAULT_DEEP_RESEARCH_LIMITS;
  const folder = safeFolderName(input.folder);

  // Built once and shared by both link-resolving loops below (generated-note
  // "Related" links, and the related-existing pass) — `resolveTarget` rebuilds
  // the O(notes) index on every call, so per-link use is quadratic.
  const resolve = makeResolver(notes);
  const sourceByUrl = new Map(result.sources.map((source) => [source.url, source]));

  const taken = new Set(existingFiles.map((f) => f.relPath.toLowerCase()));
  const slugToRel = new Map<string, string>();
  const urlToRel = new Map<string, string>();
  for (const f of existingFiles) {
    if (!f.isMarkdown) continue;
    slugToRel.set(titleSlug(f.name), f.relPath);
    const src = /(?:^|\n)\s*(?:source|url)\s*:\s*(\S+)/i.exec(content[f.relPath] ?? "");
    if (src) {
      const canon = canonicalizeSourceUrl(src[1]);
      if (canon && !urlToRel.has(canon)) urlToRel.set(canon, f.relPath);
    }
  }

  const ops: ProposedOp[] = [];
  const createdRelPaths: string[] = [];
  const updatedRelPaths: string[] = [];
  const skippedDuplicates: { title: string; relPath: string; reason: string }[] = [];

  const dateISO = localISO(input.now);

  // --- Source notes (only new, non-duplicate). ---
  const sourceNoteTargets: { title: string; relPath: string; linkTarget: string }[] = [];
  for (const n of result.notes) {
    const title = safeNoteTitle(n.title);
    const slug = titleSlug(title);
    const canon = n.sourceUrl ? canonicalizeSourceUrl(n.sourceUrl) : null;

    if (canon && urlToRel.has(canon)) {
      const rel = urlToRel.get(canon)!;
      skippedDuplicates.push({ title, relPath: rel, reason: "source already in vault" });
      sourceNoteTargets.push({ title, relPath: rel, linkTarget: rel });
      continue;
    }
    if (slugToRel.has(slug)) {
      const rel = slugToRel.get(slug)!;
      skippedDuplicates.push({ title, relPath: rel, reason: "note title already exists" });
      sourceNoteTargets.push({ title, relPath: rel, linkTarget: rel });
      continue;
    }

    // Resolve any extra links to existing notes where possible.
    const extraLinks = (n.links ?? [])
      .map((l) => resolve(l))
      .filter((t): t is string => Boolean(t));
    const relPath = uniqueRelPath(taken, `${folder}/${title}.md`);
    taken.add(relPath.toLowerCase());
    slugToRel.set(slug, relPath);
    if (canon) urlToRel.set(canon, relPath);

    let body = n.markdown.trim();
    if (canon) body += `\n\nSource: ${canon}`;
    const sourceRecord = canon ? sourceByUrl.get(canon) : null;
    if (sourceRecord?.date) {
      body += `\nDate: ${sourceRecord.date}`;
    }
    if (extraLinks.length) {
      body += `\n\n## Related\n${extraLinks.map((t) => `- [[${t}]]`).join("\n")}`;
    }
    body += `\n\n---\n_Created by Deep Research · ${dateISO}_`;
    body = truncateUtf8(body, limits.maxGeneratedNoteBytes);

    ops.push({ kind: "create", relPath, title, content: body });
    createdRelPaths.push(relPath);
    sourceNoteTargets.push({ title, relPath, linkTarget: relPath });
  }

  // --- Report / index note. ---
  const reportTitle = safeNoteTitle(result.report.title);
  const reportRel = uniqueRelPath(taken, `${folder}/${reportTitle}.md`);
  taken.add(reportRel.toLowerCase());
  createdRelPaths.push(reportRel);

  const relatedExisting: RelatedNote[] = [];
  const relatedPaths = new Set<string>();
  for (const r of result.related) {
    const rel = resolve(r.relPath) ?? (notes[r.relPath] ? r.relPath : null);
    if (rel && notes[rel] && !relatedPaths.has(rel.toLowerCase())) {
      relatedPaths.add(rel.toLowerCase());
      relatedExisting.push({ ...r, relPath: rel });
    }
  }

  const modelReport = result.report.markdown.trim();
  let apparatus = "";
  // Research-grade scaffolding: the model's findings lead, then Mesa appends a
  // structured apparatus — sub-questions covered, a linked source network,
  // full references, confidence/uncertainty, and related-vault integration —
  // so the report reads as a defensible, source-backed document, not a blob.
  if (result.subQuestions && result.subQuestions.length) {
    apparatus += `\n\n## Research questions\n${result.subQuestions.map((q) => `- ${q}`).join("\n")}`;
  }
  apparatus += `\n\n## Source notes`;
  if (sourceNoteTargets.length === 0) apparatus += `\n- (none)`;
  for (const t of sourceNoteTargets) apparatus += `\n- [[${t.linkTarget}]]`;
  if (result.sources.length) {
    apparatus += `\n\n## References`;
    for (const s of result.sources) apparatus += `\n- [${markdownLinkText(s.title)}](${markdownLinkDestination(s.url)})${s.date ? ` · ${s.date}` : ""}`;
  }
  if (relatedExisting.length) {
    apparatus += `\n\n## Related notes\n${relatedExisting.map((r) => `- [[${r.relPath}]]${r.reason ? ` — ${r.reason}` : ""}`).join("\n")}`;
  }
  if (result.claims.length) {
    const bucket = (k: SourceKind) => result.claims.filter((c) => c.kind === k);
    const section = (label: string, list: ResearchClaim[]) =>
      list.length ? `\n\n### ${label}\n${list.map((c) => `- ${c.text}${c.sourceUrl ? ` ([source](${markdownLinkDestination(c.sourceUrl)}))` : ""}`).join("\n")}` : "";
    apparatus +=
      `\n\n## Confidence & uncertainty` +
      section("Verified", bucket("verified")) +
      section("Inference", bucket("inference")) +
      section("Disagreement", bucket("conflict")) +
      section("Open questions", bucket("unknown"));
  }
  apparatus += `\n\n---\n_Generated by Deep Research · ${dateISO}_`;
  // Preserve Mesa's references and confidence apparatus when the model report
  // is long. Truncate the model-authored body first, then append the apparatus.
  const apparatusWithinLimit = truncateUtf8(apparatus, limits.maxReportBytes);
  const modelBudget = Math.max(
    0,
    limits.maxReportBytes - utf8ByteLength(apparatusWithinLimit)
  );
  const report =
    truncateUtf8(modelReport, modelBudget).trimEnd() + apparatusWithinLimit;

  ops.push({ kind: "create", relPath: reportRel, title: reportTitle, content: report });

  // --- Useful, high-confidence updates on related existing notes. ----------
  // Propose substantive, high-confidence updates backed by a surviving source.
  for (const r of relatedExisting.slice(0, limits.maxRelated)) {
    if (r.update?.confidence !== "high") continue;
    const addition = r.update.markdown.trim();
    const citedSources = [...new Set(
      r.update.sourceUrls
        .map((u) => canonicalizeSourceUrl(u))
        .filter((u): u is string => Boolean(u && sourceByUrl.has(u)))
    )];
    if (addition.length < 40 || citedSources.length === 0) continue;
    const cur = content[r.relPath] ?? "";
    const marker = `<!-- mesa-deep-research:${input.runId} -->`;
    if (cur.includes(marker)) continue;
    const reportBacklink = cur.includes(`[[${reportRel}]]`) || addition.includes(`[[${reportRel}]]`)
      ? ""
      : `\n\nRelated report: [[${reportRel}]]`;
    const next =
      cur.trimEnd() +
      `\n\n${marker}\n## Research update — ${dateISO}\n${addition}` +
      `\n\nSources:\n${citedSources.map((u) => `- [${markdownLinkText(sourceByUrl.get(u)?.title ?? u)}](${markdownLinkDestination(u)})`).join("\n")}` +
      `${reportBacklink}\n`;
    ops.push({
      kind: "update",
      relPath: r.relPath,
      title: notes[r.relPath].title,
      content: next,
      expectedBytes: cur,
      addedLinks: [...new Set([reportRel, ...extractLinks(addition)])],
    });
    updatedRelPaths.push(r.relPath);
  }

  return { ops, folder, reportRelPath: reportRel, createdRelPaths, updatedRelPaths, skippedDuplicates };
}
