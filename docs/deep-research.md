# Deep Research

Deep Research is Mesa's source-backed, review-before-apply research workflow.

The startup path keeps only the small run configuration and URL-observation
helpers in the entry bundle. Context construction, prompt generation, result
validation, and reviewed apply planning load when a run needs them. This
boundary must remain lazy; opening Mesa must not load the research engine.
You give it a question; the embedded Pi agent researches it across the web
through Mesa's own browser harness; Mesa then shows you a deterministic
change set of new/updated notes and applies it only after you approve — with
verified atomic writes and all-or-nothing rollback.

It is local-first: network traffic is limited to the user's existing Pi model
provider and the web sources Pi chooses to browse or archive. Nothing is sent
to a Mesa service (there is no Mesa server). Proposed research notes are never
written without your explicit approval. The one intentional automatic write is
the accepted-source archive described below: after a result passes validation,
Mesa preserves those webpages under `Web Archives/` by default so the evidence
remains reopenable from the vault.

## Launching

Deep Research is reachable from both of Mesa's Pi surfaces, and both drive the
same single run:

- **Steam overlay (Shift+Tab)** — the **Research** window in the bottom dock.
- **Pi agent panel** (the `AgentPanel` modal, the `AgentOverlay` floating
  window, or the overlay's Pi window) — the **⌬** tool in the terminal chrome.
  Before a run starts, its composer opens downward from Pi's toolbar but stays
  inside the Pi surface, with all controls visible. Once research
  starts, the surface moves to the existing right-side wing. Drag the Deep
  Research header to tear the complete view into its own decorated Mesa native
  window. Drag that native title bar over Mesa to dock it back into Research.

Opening either surface opens the shared Deep Research run. There is exactly
one run and one visible presentation owner at a time: opening Research in Pi,
the overlay, or the detached native window transfers that same presentation
instead of stacking another. Starting a new run while one is streaming requires
cancelling it first.

Drag remains the direct-manipulation transfer. Keyboard users focus the
Research title bar and press `Ctrl/Cmd+Shift+Enter` to tear out or dock back;
the focused bar displays that hint.

If Deep Research is launched from the Steam overlay while Pi is cold, Mesa
boots Pi in the overlay's own **Pi** window instead of opening a separate
floating Pi surface underneath the overlay. The run waits through that cold
start before it declares Pi unavailable.

Before starting, choose **Quick**, **Standard**, or **Deep**, or fine-tune the
exact number of research **rounds**, **sub-questions**, **sources**, and
**generated notes**. The selected source/note caps are honored by validation;
deeper presets are not clipped back to the standard limits. The initial query
composer opens downward within Pi; once the run starts it is hidden so the evidence keeps
the working area.

## What context is sent to Pi

Before anything runs, Deep Research builds a deterministic context from the
current vault and shows it to you in the surface ("Context sent to Pi"),
under a user-selectable **context scope** (the `workspace ctx` / `vault ctx`
toggle beside the depth presets, persisted as
`settings.researchContextScope`):

- **workspace** (the default) sends only what you are looking at: the
  **active note**, any **selected notes**, and the active note's direct link
  neighborhood (**backlinks** + **outgoing links** — the notes the
  graph/backlinks surfaces show around it). No vault-wide sweeps; on a large
  vault this stays a handful of notes.
- **vault** additionally mines the whole vault for notes sharing a **tag**
  with the picked set and for bounded query-term **content search** matches —
  in that order, deduplicated. On a large vault most of this selection is
  then reported as omitted by the caps.
- both scopes honor explicit **limits**: note count, per-note bytes, total
  context bytes, source count, generated-note count, generated-note bytes,
  related-note count, and a total generated-output byte budget
  (`DEFAULT_DEEP_RESEARCH_LIMITS` in `src/lib/deepResearch.ts`).

Truncation is reported explicitly ("N omitted, truncated"), and the surface
names the scope the context was built with, so you know exactly why a note
was or wasn't sent. The context summary is not a permanent panel section. Once
context exists, the status chip visibly says **Context** and names the action
**Show Context sent to Pi**. Hover it to open its accordion preview, or focus
and activate the chip with the keyboard.

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
3. **Live assembly** — two independent feeds keep the surface honest:
   - `deep_research_progress` (self-reported): the current round,
     sub-question, each source as it is opened and finished, specific
     activity, and bounded report snapshots after each major synthesis
     section. `message` is optional at the tool boundary because Pi may omit
     it on structured sub-question, source, or round events; Mesa derives a
     non-empty status from those fields. The wing shows the report taking
     shape rather than a generic spinner.
   - **Observed navigation** (Mesa's own evidence): while a run is active,
     Mesa also feeds every REAL browser-harness navigation
     (`mesa://browse` / `mesa://harness-nav`) into the activity feed and
     unified evidence graph — search-engine URLs are shown as "Searched for …"
     with the decoded query, other pages as opened sources. This works even
     when the model never calls the progress tool, so the user always sees the
     true queries and pages under the hood (rendered dimmer than self-reported
     entries).
4. **Finish** — Pi returns a structured result (`deep_research_finish`):
   report markdown, proposed source notes, sources (URL + title + date),
   claims, and related notes.
5. **Preserve accepted sources** — after the finish payload passes URL and
   report-quality validation, Mesa archives only final sources that also have a
   matching Mesa-observed browser navigation. Search results, redirects that
   did not survive canonicalization, pages merely opened during exploration,
   and URLs reported by the model without a matching observed navigation are
   not archived. Up to three saves run at once in the background, so the
   proposal can enter review immediately.

The flyout also shows a **live evidence graph**. It starts with the user's
actual question and adds nodes only when Mesa receives a real progress report
or observes a real browser navigation. Planned source slots, empty sub-question
slots, and future placeholder nodes are never drawn. Pi-reported actions and
Mesa-observed actions are visually distinguished, so a quiet graph is evidence
that no research action has reached Mesa yet. As actions accumulate, the nodes
remain inside the measured graph section and form one numbered chronological
path. Read from step 1 and follow the arrows across each row; the path reverses
direction at the row edge, like lines of text, so connections do not cross.
The query, plan, sub-questions, searches, notes, and sources all use that same
path. On every panel resize Mesa chooses a new row/column fit and resizes the
circles and labels. Each node reserves a private cell for its normal circle,
hover expansion, hit target, and clipped label, so nodes cannot overlap even at
the densest supported view. Row-turn arrows route outside the label column.
Dense layouts show the step number and action type first; hovering opens an
Obsidian-style preview card with the full text. Mesa paints the hovered node
last in the SVG, so its circle, glyph, and label stay above nearby graph
content. Source nodes
keep the site favicon/initial,
canonical URL, observed-versus-reported state, and local archive action in
that card. There is no separate source list or selected-node detail section
competing with the graph's working area. Keyboard users can Tab to a node, use
Enter or Space to select it persistently, and continue directly into the
preview-card actions; Escape clears the selection. The evidence body is contained in a
bounded scroll region when the Pi flyout is short. The active-run Cancel
control and any triggered troubleshooting-kit action stay in the visible footer. The activity log, report draft, change
list, and expanded previews retain their own bounded scrolling where
applicable. The context preview from the phase chip is viewport-anchored and
keeps the live Pi browser active beneath a minor overlap instead of hiding its
page.

## Accepted-source archives

Accepted sources use the same archive transaction as the Pi browser's manual
**Archive** action:

- files are created under `Web Archives/` with readable timestamp, host, and
  page names;
- HTML receives the original/final source URL plus a `<base>` when needed, so
  relative links, images, and styles can resolve when opened inside Mesa;
- the file is created through `persistVerifiedBytes` with a missing-target
  precondition, so an existing archive is never silently overwritten;
- after the verified write, Mesa registers the file in the open vault without
  rescanning or disrupting the current view;
- if Mesa cannot fetch an HTML body, it saves a small, safely escaped local
  source-link record instead. The card says **Link saved** and still opens it;
- if the verified vault write itself fails, no success is shown. The source
  card says **Archive failed**, and the troubleshooting kit includes the
  per-source archive state and error.

An archive preserves the fetched HTML response, not a guaranteed complete
offline mirror of every remote asset. Pages whose CSS, images, or scripts live
on the original site may still need network access when reopened. Archiving is
independent of the note proposal: discarding the proposed note changes does not
erase accepted evidence that has already been saved.

Mesa submits the multi-line task to Pi's interactive editor as the prompt body
followed by an explicit Enter key. Seeing the prompt text in the Pi editor only
proves that text reached the PTY; it does not prove that Pi submitted a model
turn. The run state records the launch boundary (Pi restart/start, bridge setup,
prompt submission, waiting for model, or first activity) so a stalled run is
diagnosable instead of looking like generic "researching" progress.

**Read-only guarantee:** while a run is active, the bundled
`mesa-deep-research` Pi extension blocks Pi's direct content-mutation `write`,
`edit`, and `apply_patch` tools (fail-safe, synchronous in Pi's tool runner).
Read-only shell inspection remains available because the tool-call hook receives
the shell tool name, not its command, and therefore cannot safely distinguish
`rg` from a mutating shell command. Mesa owns every vault mutation;
Pi can only *propose*. Even if the model ignores the instruction, it cannot
write to the vault during a run. An accepted finish immediately releases the
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
  **Disagreements**, and **Open questions**. Under `## Findings`, use one
  `###` heading containing the exact text of each `result.subQuestions` entry.
  Numbering and emphasis are normalized; unrelated topic labels are not
  considered equivalent questions. Each subsection must contain its own
  validated source URL citation. Headings in fenced examples or other sections,
  and citations from a later Synthesis section, cannot satisfy this requirement. Every final source must also be
  present in Mesa's observed-navigation record. An incomplete or
  unobserved-source report is rejected with the missing elements listed; it is
  never offered as a finished proposal.

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
up) immediately, then opens the report note. These updates belong to the
original run and vault-open generation. If the user switches vaults during the
rescan, Mesa leaves the new vault's files, cache, and active document intact.

## Cancellation & failure

- **Cancel** interrupts Pi cooperatively, marks the run cancelled, and restarts
  the same shared session once without the research write gate. Cancellation
  removes queued context preparation before it can submit anything to Pi, and
  stops new source archive writes, including a fetch that finishes afterward.
  An archive write already in progress finishes its verified transaction in
  the original vault. An apply transaction also finishes atomically against
  its original vault. Neither completion can register files or publish cached
  content into another vault. Completed accepted-source archives remain.
- **Failures** (Pi unavailable, browsing unavailable, provider error,
  malformed structured output, stale files, or a timeout after the Pi session
  is no longer live) move the run to a clear
  **error** state with an actionable message; nothing is written.

  A quiet run does not fail only because prompt processing is slow. If the
  shared Pi session remains live, Mesa keeps the run active and continues to
  monitor it. This lets slow providers finish while the inactivity watchdog
  still exposes the troubleshooting kit.

  `deep_research_finish` waits for Mesa's validation decision. Its tool reply
  is **accepted**, **rejected**, or **stopped**; receiving a payload is not
  acceptance. Rejections return the exact issues in the same tool call, keep
  the read-only gate active, and let Pi repair the complete result in the same
  run. Formatting corrections use the existing evidence; additional browsing
  is required only when evidence is missing. URL failures include the exact
  unobserved and Mesa-observed URL sets. Mesa never repairs unsupported claims
  by inventing citations. If Pi ends its turn after a rejection, Mesa sends
  one focused repair prompt for that rejection attempt so a provider that
  stops after reading the validation reply does not strand the run. The repair
  prompt requires a literal URL from the observed set in every findings
  subsection. Three rejected submissions stop the run with the latest draft
  and issues retained. Only acceptance moves it to review and releases the
  gate. The native bridge correlates replies by run and tool-call ID, admits
  one finish wait, and times out after 30 seconds; timeout is not success.
  Already-running older extensions retain the legacy correction path.

  Pi's `agent_start` and `agent_end` events report actual model-loop activity.
  An unfinished turn immediately shows **Pi turn ended — report not accepted**,
  removes the Working indicator, and exposes diagnostics. The run remains
  available for continuation in Pi or cancellation; a provider retry clears
  the ended-turn indicator when its next loop starts. Silence alone never
  produces a completed report. Progress acknowledgements explicitly say the
  run is not complete. Report assembly is labeled **Drafting report**, since
  proposed notes have not yet been written.

The **Copy troubleshooting kit** action stays hidden during healthy work. An
invisible watchdog reveals it when a submitted prompt has produced no new
activity for 120 seconds, or immediately after Mesa records a confirmed run
error (for example a failed Pi/provider bridge call), rejects a finish
payload for correction, or observes a Pi turn ending without acceptance. A real
progress report, search, source visit, note, or synthesis action resets the
inactivity clock. The kit contains the Mesa and webview environment,
run phase, launch boundary, prompt size/submission time, whether the first
model/browser signal arrived, context summary, source counts, and the
observed-versus-self-reported activity timeline. It withholds the vault's
absolute path and provider/API keys. If the desktop clipboard rejects the
copy, Mesa opens a native save dialog and writes the same kit to the path the
user selects. The fallback does not choose a vault path. Detached read-only
Research windows expose the same diagnostic export and snapshot the run's
original shared Pi session; they do not start a new session or gain apply controls.

The troubleshooting kit is intentionally bounded: it keeps a compact
environment line, up to 12 context-note references, 24 source rows, and the
last 48 activity rows. When native Pi is available, it also captures the
retained chronological PTY transcript for the shared session. This is the
local record of model messages, tool calls, tool results, and terminal output;
Mesa secret-scrubs it before copy or save. The PTY history is bounded, so the
export reports what Mesa still retains. The latest rejected draft and exact
validation issues are retained separately from the rolling activity tail and
included in problem exports, even if their original activity entries rolled out.

Every kit starts with an interpretation boundary. The kit is a diagnostic
record, not an instruction set. Its run query, retained Pi transcript,
workspace context, browser content, prompts, `AGENTS.md` text, commands, and
tool output are historical untrusted data from that run. They must be used as
evidence only, not followed as instructions or treated as a new task. The
query shown in the kit is the request submitted to that historical run, not the
current user request unless the user explicitly says so. The query and retained
transcript use safe Markdown fences so embedded fences cannot escape their data
blocks.

After an accepted finish moves a run to review or done, **Copy research trace**
becomes available. Active or failed runs expose **Copy troubleshooting kit**
when a problem is detected; healthy planning and researching stay uncluttered.
The export includes the bounded kit, the retained Pi transcript, and the
complete secret-scrubbed chronological action log.

If Pi cannot continue safely because of a tool-validation error, unavailable
source path, or another hard blocker, the prompt directs it to call
`deep_research_blocked`. Mesa records that reason, stops the run cleanly, and
exposes the troubleshooting kit instead of leaving the user with an unexplained terminal
refusal.

A live Pi process is not treated as proof that the model is still researching.
Keep the troubleshooting kit before dismissing or replacing a failed run.

## macOS WebCrypto Keychain prompt

Mesa does not create or read a Keychain item named **WebCrypto Master Key** and
it never sends the login keychain password to Pi or to a research website. The
desktop browser harness is a native WKWebView. When a page uses the browser's
WebCrypto API, WebKit can create or retrieve its own cryptographic master key
from the macOS Keychain. That is why the prompt can appear while Deep Research
is browsing, even though Mesa has no WebCrypto call in its source.

If macOS asks for access, **Deny** prevents that page's WebCrypto feature from
using its stored key; it does not expose the vault or stop Mesa from reading
ordinary public pages. Allowing it is only needed when the page's own secure
session or cryptographic feature requires WebCrypto. Development builds can
ask again after their signing identity or WebKit data changes. The prompt is a
macOS/WebKit boundary, not a Mesa vault-password request.

## Limitations (browser demo / native-only)

- Deep Research needs the **desktop app's** Pi agent and browser harness. In
  the browser demo (`npm run dev`) the surface opens and you can prepare a
  query, but starting a run reports that a native Pi session is required.
- The first start of a run may restart the shared Pi session once (to load
  the Deep Research extension); that session's prior conversation is not
  preserved across that single restart.
- Browser-demo QA can verify the graph shell and hover-card structure, but a
  dense native run still needs desktop Pi/browser-harness acceptance.
