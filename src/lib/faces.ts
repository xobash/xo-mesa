import type { ActivityOp } from "./activity";

/**
 * Playful Hermes-style status faces + phrases shown at the bottom of the live
 * activity card while a file is being read / edited / written / created.
 *
 * Several variants per op; one is picked deterministically from a seed (the
 * note id) so a file keeps the same face/phrase for the duration of a burst
 * rather than flickering every frame. Faces and phrases are picked from the
 * same seed so a given file always gets a matching pair during a burst.
 *
 * Convention: every default phrase ends in "…" so the trailing ellipsis reads
 * as an ongoing action (a test asserts this). Custom agent status overrides
 * the phrase but keeps the face.
 */
const FACES: Record<ActivityOp, string[]> = {
  read: [
    "( ͡° ͜ʖ ͡°)",
    "(◉‿◉)",
    "( ⊙_⊙)",
    "(•_•)つ",
    "(´・_・`)",
    "(◡‿◡)",
    "(¬‿¬)",
    "( ˘ ˘ )",
    "(⌐■_■)",
    "(・_・)",
    "( ͡~ ͜ʖ ͡°)",
    "(⑅˃◡˂)",
    "(￣ω￣)",
    "(´ω`)",
  ],
  edit: [
    "ヽ(>∀<☆)☆",
    "(╯°□°)╯",
    "✍(◔◡◔)",
    "(۶•̀ᴗ•́)۶",
    "(◔_◔)",
    "(ಠ_ಠ)",
    "(⊙_⊙)",
    "ᕦ(ò_óˇ)ᕤ",
    "(ノಠ益ಠ)ノ",
    "┐(￣ー￣)┌",
    "(⌒‿⌒)",
    "(￣▽￣)ノ",
    "٩(◕‿◕)۶",
    "(≧◡≦)",
    "(งツ)ว",
    "( ˘ ˘ )",
    "(｀_´)ゞ",
    "(•̀ᴗ•́)و",
  ],
  write: [
    "⊂(◉‿◉)つ",
    "(っ•́｡•́)♪♬",
    "╰(*°▽°*)╯",
    "(✯◡✯)",
    "(⌐■_■)⌐■-■",
    "(︼︼︼︼)",
    "┐(︶▽︶)┌",
    "( ˘ ˘ )",
    "(´｡• ᵕ •｡`)",
    "(⦿_⦿)",
  ],
  create: [
    "✧( ͡° ͜ʖ ͡°)",
    "(ﾉ◕ヮ◕)ﾉ*:･ﾟ✧",
    "ヽ(•‿•)ノ",
    "(*˘︶˘*).｡.:*",
    "(✿◠‿◠)",
    "꒰⑅ᵕ༚ᵕ꒱˖♡",
    "╰(✿´⌣`✿)╯",
    "☆*:.｡.o(≧▽≦)o.｡.:*☆",
    "(ノ◕ヮ◕)ノ*:・゚✧",
  ],
};

const PHRASES: Record<ActivityOp, string[]> = {
  read: [
    "perusing…",
    "peeking…",
    "scanning…",
    "skimming the margins…",
    "following the thread…",
    "checking the footnotes…",
    "poring over…",
    "eyeballing…",
    "taking a gander…",
    "reading the room…",
    "snooping respectfully…",
    "absorbing context…",
    "listening between lines…",
    "tracing the argument…",
    "indexing vibes…",
    "turning pages…",
    "sniffing for clues…",
    "mapping the terrain…",
    "consulting the scroll…",
    "looking closer…",
  ],
  edit: [
    "tinkering…",
    "mulling…",
    "scribbling…",
    "editing…",
    "noodling…",
    "fiddling…",
    "wrestling clauses…",
    "wrangling structure…",
    "tweaking…",
    "massaging prose…",
    "herding words…",
    "wrangling nouns…",
    "coaxing verbs…",
    "arguing with prose…",
    "fine-tuning…",
    "kneading sentences…",
    "smithing paragraphs…",
    "reshaping the clay…",
    "tightening bolts…",
    "shuffling thoughts…",
    "polishing edges…",
    "re-threading logic…",
    "aligning the glyphs…",
    "stirring the draft…",
    "combing the weeds…",
    "patching the seams…",
  ],
  write: [
    "saving…",
    "committing…",
    "writing…",
    "persisting…",
    "etching…",
    "carving…",
    "inscribing…",
    "pressing the button…",
    "hitting send…",
    "embossing…",
    "setting ink…",
    "sealing the envelope…",
    "making it real…",
    "landing the plane…",
  ],
  create: [
    "conjuring…",
    "spawning…",
    "creating…",
    "manifesting…",
    "summoning…",
    "brewing…",
    "baking…",
    "willing into being…",
    "pulling from the void…",
    "opening a portal…",
    "planting a flag…",
    "minting a note…",
    "lighting a candle…",
  ],
};

function hash(seed: string): number {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) | 0;
  return Math.abs(h);
}

export function faceFor(op: ActivityOp, seed = ""): string {
  const list = FACES[op] ?? FACES.edit;
  return list[hash(seed) % list.length];
}

export function phraseFor(op: ActivityOp, seed = ""): string {
  const list = PHRASES[op] ?? PHRASES.edit;
  return list[hash(seed + "p") % list.length];
}

/** A full quirky status line, e.g. "( ͡° ͜ʖ ͡°) computing…". A custom status
 *  (e.g. from an agent) overrides the default playful phrase but keeps the
 *  face. */
export function statusLine(op: ActivityOp, seed = "", custom?: string): string {
  const phrase = custom && custom.trim() ? custom.trim() : phraseFor(op, seed);
  return `${faceFor(op, seed)} ${phrase}`;
}

/** Total number of distinct face/phrase combinations for an op. Useful for
 *  tests asserting variety is large. */
export function varietyFor(op: ActivityOp): number {
  return (FACES[op]?.length ?? 0) * (PHRASES[op]?.length ?? 0);
}
