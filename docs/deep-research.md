# Deep Research

Deep Research is Mesa's source-backed, review-before-apply research workflow.
You give it a question; the embedded Pi agent researches it across the web
through Mesa's own browser harness; Mesa then shows you a deterministic
change set of new/updated notes and applies it only after you approve — with
verified atomic writes and all-or-nothing rollback.

It is local-first: network traffic is limited to the user's existing Pi model
provider and the web sources Pi chooses to browse. Nothing is sent to a Mesa
service (there is no Mesa server), and the vault is never mutated without your
explicit approval.

## Launching

Deep Research is reachable from both of Mesa's Pi surfaces, and both drive the
same single run:

- **Steam overlay (Shift+Tab)** — the **Research** window in the bottom dock.
- **Pi agent panel** (the `AgentPanel` modal, the `AgentOverlay` floating
  window, or the overlay's Pi window) — the **⌬** tool in the terminal chrome.
  It opens a resizable wing that slides from behind Pi exactly like the browser
  harness; it does not open a duplicate Steam-overlay window.

Opening either surface opens the shared Deep Research run. There is exactly
one run at a time; starting a new run while one is streaming requires
cancelling it first.

Before starting, choose **Quick**, **Standard**, or **Deep**, or fine-tune the
exact number of research **rounds**, **sub-questions**, **sources**, and
**generated notes**. The selected source/note caps are honored by validation;
deeper presets are not clipped back to the standard limits.

## What context is sent to Pi

Before anything runs, Deep Research builds a deterministic context from the
current vault and shows it to you in the surface ("Context sent to Pi"):

- the **active note** and any **selected notes** (always included);
- **related notes** gathered deterministically from **backlinks**, **outgoing
  links**, **shared tags**, and a bounded **content search** — in that order,
  deduplicated;
- explicit **limits**: note count, per-note bytes, total context bytes, source
  count, generated-note count, generated-note bytes, related-note count, and a
  total generated-output byte budget
  (`DEFAULT_DEEP_RESEARCH_LIMITS` in `src/lib/deepResearch.ts`).

Truncation is reported explicitly ("N omitted, truncated") so you know when
the context was bounded to stay responsive on a large vault.

**Privacy / credential boundary:** any dot-prefixed path segment (`.file.md`,
`.folder/note.md`, and Mesa's own `.name.mesa-save/backup-…tmp` write
artifacts) and credential-named notes such as `credentials.md`, `secrets.md`,
or `API_KEYS.md` are **always excluded** from context. Private-key blocks,
credential assignments, and common provider-token shapes found inside an
otherwise relevant note are redacted before injection; the context surface
reports when redaction occurred. The same redaction pass runs over proposed
report, source-note, and related-note markdown before it can enter a change set.
Vault notes and fetched web pages are treated as **untrusted content**: they
are passed to the model as data, and no instruction embedded in them is
followed. No API keys, sync keys, private keys, or absolute vault paths are
included in the research artifacts. (Pi's normal startup still receives the
usual `MESA_*` workspace context — vault path, active file — as it always
has; Deep Research adds nothing sensitive on top of that.)

## How a run works

1. **Start** — Mesa writes a structured task into the **one shared Pi
   session** (it never spawns a second Pi process). If the live session was
   started without the Deep Research extension, Mesa restarts it once through
   the normal path so the extension loads; this is the only way the read-only
   guarantee below can be enforced.
2. **Research** — Pi expands your question into sub-questions and completes
   the configured rounds with its existing `browse` / `browse_read` tools (the
   same browser harness you can watch live). Round 1 builds breadth; subsequent
   rounds verify important claims, seek primary corroboration, resolve
   disagreements, and close gaps.
3. **Live assembly** — `deep_research_progress` reports the current round,
   sub-question, each source as it is opened and finished, specific activity,
   and bounded report snapshots after each major synthesis section. The wing
   shows the report taking shape rather than a generic spinner.
4. **Finish** — Pi returns a structured result (`deep_research_finish`):
   report markdown, proposed source notes, sources (URL + title + date),
   claims, and related notes.

**Read-only guarantee:** while a run is active, the bundled
`mesa-deep-research` Pi extension blocks Pi's mutation-capable `write`, `edit`,
`apply_patch`, and shell/exec tools
(fail-safe, synchronous in Pi's tool runner). Mesa owns every vault mutation;
Pi can only *propose*. Even if the model ignores the instruction, it cannot
write to the vault during a run. A successful finish immediately releases the
block without killing the conversation; cancellation or transport failure
restarts the same shared session once so normal Pi writes cannot remain stuck
behind a stale research gate.

## The structured result (proposal)

Pi's result is data, not instructions. Mesa **validates and normalizes** it
before it can become a change set:

- sources are **canonicalized** (lowercase host, `www.` stripped, tracking
  params dropped, fragment/trailing-slash removed) and **deduplicated**;
  malformed and non-`http(s)` URLs are rejected;
- claims keep their **uncertainty**: `verified`, `inference`, `conflict`
  (sources disagree), and `unknown` are preserved and rendered separately;
- generated notes and sources are **capped** to the limits.
- a thesis-grade quality gate requires a complete sub-question plan, validated
  sources, source-backed verified claims, inline citations, and report sections
  for **Abstract**, **Methodology**, **Findings** (one subsection per
  sub-question), **Synthesis**, **Confidence and limitations**,
  **Disagreements**, and **Open questions**. An incomplete report is rejected
  with the missing elements listed; it is never offered as a finished proposal.

## The change set (review)

From the validated result Mesa builds a **deterministic change set**:

- a **research report / index note** (in the configured research folder)
  with wiki-links to the source notes, a references list, a related-notes
  list, and a confidence section (verified / inference / disagreement /
  unknown);
- **source notes** only when useful and non-duplicate;
- **useful related-note updates** only when Pi supplies substantive markdown,
  `high` confidence, and at least one validated source URL. Mesa appends the
  new finding, its citations, and a report link under a dated research-update
  section. A relevance reason or backlink stub alone never mutates an existing
  note, and unrelated notes are never rewritten.

**Deduplication** prevents double work: by canonical **source URL**, by note
**title slug**, and by **link target**. A source already in the vault is
linked, not recreated. Existing report links are not duplicated.

Every proposed file operation is **shown before applying** — click any row to
preview its full content.

**Output folder:** generated notes go into the folder from
`settings.researchFolder` (default `Research/`). If the vault has no such
convention yet, the folder is created on apply; all generated names are
sanitized with the same `safeBaseName` Windows-portability rules as the rest
of the vault.

## Apply & rollback (all-or-nothing)

Applying is **review-before-apply** and **transactional**:

- each update carries an **`expectedBytes` version check**, rechecked against
  exact on-disk bytes inside the verified-write transaction (not merely
  against Mesa's cache). Creates require the target to still be missing. A
  stale update or late create collision is refused without overwriting it;
- steps run creates-before-updates, each through Mesa's **verified atomic
  writes** (`persistVerifiedBytes` — backup, verified temp, atomic rename,
  byte-for-byte read-back);
- if **any** step fails, the whole transaction rolls back: already-updated
  files are restored to their original bytes and newly created files are
  removed, so the vault is left in its original state and **no partial
  generated artifacts survive**.

After a successful apply, Mesa refreshes the vault scan, content cache,
backlinks, and graph, so the new notes and links appear (and the graph lights
up) immediately, then opens the report note.

## Cancellation & failure

- **Cancel** interrupts Pi cooperatively, marks the run cancelled, and restarts
  the same shared session once without the research write gate. It writes
  nothing and leaves no partial artifacts.
- **Failures** (Pi unavailable, browsing unavailable, provider error,
  malformed structured output, timeout, stale files) move the run to a clear
  **error** state with an actionable message; nothing is written.

## Limitations (browser demo / native-only)

- Deep Research needs the **desktop app's** Pi agent and browser harness. In
  the browser demo (`npm run dev`) the surface opens and you can prepare a
  query, but starting a run reports that a native Pi session is required.
- The first start of a run may restart the shared Pi session once (to load
  the Deep Research extension); that session's prior conversation is not
  preserved across that single restart.
