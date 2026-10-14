// Synthetic "Tidewater" research vault for the README demo recording.
// All people, citations and data are fictional or public-paper titles.
const V = {};
const add = (rel, text) => { V[rel] = text; };

// --- Daily -----------------------------------------------------------------
const dailyDates = ["2026-09-21","2026-09-22","2026-09-23","2026-09-24","2026-09-25","2026-09-28","2026-09-29","2026-09-30","2026-10-01","2026-10-02","2026-10-05","2026-10-06","2026-10-07","2026-10-08","2026-10-09","2026-10-12","2026-10-13"];
const dailyBodies = [
  "Sorted transect photos from [[Point Lobos Transects]]. Started [[Chapter 1 - Literature Review]] outline.",
  "Read [[Wernberg 2016]] again; the regime-shift framing is what [[Chapter 2 - Heatwave Exposure]] needs.",
  "Lab meeting. [[Maya Okafor]] wants exposure figures before the committee.",
  "Pulled SST anomalies for the mooring window. See [[Mooring M2 Deployment]].",
  "Wrote the hypothesis for [[Chapter 3 - Canopy Recovery]]. Needs [[Ling 2015]].",
  "Dive day. Urchin counts up at site 4 — [[Urchin Removal Pilot]].",
  "Cleaned [[Sample Inventory]]. Two vials mislabeled.",
  "Drafted methods for [[Canopy Classification]].",
  "Coffee with [[Jonah Reyes]] about drone flights over the canopy.",
  "Nitrate sampling with [[Priya Natarajan]].",
  "Revised [[Reading List]]. Added [[Rogers-Bennett 2019]].",
  "Figure 2.1 and 2.2 done for [[Chapter 2 - Heatwave Exposure]].",
  "Lab meeting. Discussed [[Marine Heatwaves]] definitions.",
  "Dive — Point Lobos. Canopy thinner than August. [[Kelp Canopy Survey 2026]]",
  "Read [[Filbee-Dexter 2018]] on turf states.",
  "Committee prep with [[Maya Okafor]]. Holiday — [[Sea Otters]] reading instead.",
  "Figure 2.3 still blocked on the mooring gap. [[Thesis]] timeline slipping a week.",
];
dailyDates.forEach((d, i) => {
  const dt = new Date(d + "T12:00:00");
  const title = dt.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" });
  add(`Daily/${d}.md`, `# ${title}\n\n${dailyBodies[i]}\n`);
});
add("Daily/2026-10-14.md", `# Wednesday, October 14

Today: finish exposure figures, then deep research on heatwave recovery windows.

- [ ] Export Figure 2.3
- [ ] Email [[Maya Okafor]] the draft
- [ ] Research: how fast do kelp forests recover after marine heatwaves?

Related: [[Thesis]]
`);

// Older dailies (August–September) give the graph its long tail.
const extraTopics = ["Kelp Forests", "Marine Heatwaves", "Point Lobos Transects", "Mooring M2 Deployment", "Sample Inventory", "Reading List", "Chapter 1 - Literature Review", "Urchin Counts", "Drone Mosaics", "Upwelling", "Giant Kelp", "Purple Urchins"];
const start = new Date("2026-08-17T12:00:00");
for (let i = 0, n = 0; n < 24; i++) {
  const d = new Date(start.getTime() + i * 86400000);
  if (d.getDay() === 0 || d.getDay() === 6) continue;
  const iso = d.toISOString().slice(0, 10);
  if (iso >= "2026-09-21") break;
  const a = extraTopics[n % extraTopics.length], b = extraTopics[(n * 5 + 3) % extraTopics.length];
  add(`Lab Log/${iso}.md`, `# ${d.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" })}\n\nWorked on [[${a}]]; notes for [[${b}]].\n`);
  n++;
}

// --- Projects ----------------------------------------------------------------
add("Thesis.md", `# Thesis

Working title: *Canopy loss and recovery in Central California kelp forests.*

1. [[Chapter 1 - Literature Review]]
2. [[Chapter 2 - Heatwave Exposure]]
3. [[Chapter 3 - Canopy Recovery]]

Advisor: [[Maya Okafor]] · Committee: [[Daniel Brooks]], [[Hana Sato]]

See [[Reading List]] and [[Tasks]].
`);
add("Projects/Chapter 1 - Literature Review.md", `# Chapter 1 — Literature Review

Kelp forests as foundation ecosystems ([[Kelp Forests]]). Drivers of loss: [[Marine Heatwaves]], [[Sea Urchin Barrens]], [[Trophic Cascades]].

Key sources: [[Wernberg 2016]], [[Filbee-Dexter 2018]], [[Krumhansl 2016]], [[Steneck 2002]].

#thesis #writing
`);
add("Projects/Chapter 2 - Heatwave Exposure.md", `# Chapter 2 — Heatwave Exposure

How much heat did each site absorb in 2014–2016 and 2023?

- Figure 2.1: SST anomaly time series ([[Mooring M2 Deployment]])
- Figure 2.2: degree heating weeks by site
- Figure 2.3: canopy loss vs. exposure — **todo**

Sources: [[Hobday 2016]], [[Oliver 2018]], [[Marine Heatwaves]].

#thesis #writing
`);
add("Projects/Chapter 3 - Canopy Recovery.md", `# Chapter 3 — Canopy Recovery

Hypothesis: recovery after 2016 depends on urchin density more than on heat exposure ([[Ling 2015]]).

Inputs: [[Kelp Canopy Survey 2026]], [[Urchin Removal Pilot]], [[Bell 2020]] canopy series.

#thesis #writing
`);
add("Projects/Reading List.md", `# Reading List

- [[Wernberg 2016]] — regime shift
- [[Rogers-Bennett 2019]] — northern California collapse
- [[Filbee-Dexter 2018]] — turfs
- [[Ling 2015]] — urchin barrens hysteresis
- [[Eger 2022]] — restoration review
- [[Smale 2019]] — heatwaves and foundation species
- [[Bell 2020]] — satellite canopy

Linked from [[Thesis]].
`);
add("Tasks.md", `# Tasks

- [ ] Export Figure 2.3 for [[Chapter 2 - Heatwave Exposure]]
- [ ] Email [[Maya Okafor]] the draft before the committee meeting on Oct 20
- [ ] Research: how fast do kelp forests recover after marine heatwaves? ([[Chapter 3 - Canopy Recovery]])
- [ ] Book drone flight with [[Jonah Reyes]]
- [x] Clean [[Sample Inventory]]
- [x] Draft [[Canopy Classification]] methods
- [ ] Grant report due Oct 30
`);

// --- Topics ------------------------------------------------------------------
const topics = {
  "Kelp Forests": "Foundation species forming canopy habitat in cold, nutrient-rich water. See [[Giant Kelp]], [[Bull Kelp]], [[Trophic Cascades]], [[Marine Heatwaves]].",
  "Marine Heatwaves": "Prolonged periods of anomalously warm ocean water ([[Hobday 2016]]). Drives [[Kelp Forests]] loss and [[Coral Bleaching]]. See [[The Blob]].",
  "Sea Urchin Barrens": "Rocky reefs where sea urchins have grazed kelp down to bare rock. They are a self-reinforcing alternative state ([[Ling 2015]]).\n\n- Urchins switch from passive drift feeding to active grazing when drift kelp becomes scarce.\n- Recovery requires urchin densities far below the density that triggered the collapse — a hysteresis loop.\n- [[Urchin Removal Pilot]] tests whether targeted culling reopens recovery windows.\n\nRelated: [[Regime Shifts]], [[Kelp Forests]], [[Trophic Cascades]].\n\n#ecology #regime-shift",
  "Regime Shifts": "Abrupt, persistent changes in ecosystem state. [[Sea Urchin Barrens]] and turf reefs ([[Filbee-Dexter 2018]]).",
  "Trophic Cascades": "Predator loss → urchin release → kelp loss. [[Sea Otters]], [[Sunflower Sea Star]], [[Steneck 2002]].",
  "Coral Bleaching": "Heat-driven symbiont loss; a tropical analogue of [[Marine Heatwaves]] impacts.",
  "Giant Kelp": "*Macrocystis pyrifera*. Dominant canopy at [[Point Lobos Transects]].",
  "Bull Kelp": "*Nereocystis luetkeana*. Collapsed in northern California ([[Rogers-Bennett 2019]]).",
  "Sea Otters": "Keystone predator of urchins. [[Trophic Cascades]].",
  "Sunflower Sea Star": "Lost to wasting disease 2013–2015; urchins released. [[Trophic Cascades]].",
  "Purple Urchins": "*Strongylocentrotus purpuratus*. See [[Sea Urchin Barrens]].",
  "The Blob": "2014–2016 northeast Pacific heatwave. [[Marine Heatwaves]], [[Oliver 2018]].",
  "Upwelling": "Cold nutrient supply for [[Kelp Forests]]. Measured at [[Mooring M2 Deployment]].",
  "Turf Algae": "Low mats that block kelp recruitment ([[Filbee-Dexter 2018]]).",
  "Remote Sensing": "Landsat canopy series ([[Bell 2020]]); drone surveys with [[Jonah Reyes]].",
};
for (const [k, v] of Object.entries(topics)) add(`Topics/${k}.md`, `# ${k}\n\n${v}\n`);

// --- Literature --------------------------------------------------------------
const papers = {
  "Wernberg 2016": ["Climate-driven regime shift of a temperate marine ecosystem", "Science", ["Marine Heatwaves", "Regime Shifts", "Kelp Forests"]],
  "Rogers-Bennett 2019": ["Marine heat wave and multiple stressors tip bull kelp forest to sea urchin barrens", "Sci. Rep.", ["Bull Kelp", "Sea Urchin Barrens", "Sunflower Sea Star"]],
  "Filbee-Dexter 2018": ["Rise of turfs: a new battlefront for globally declining kelp forests", "BioScience", ["Turf Algae", "Regime Shifts"]],
  "Ling 2015": ["Global regime shift dynamics of catastrophic sea urchin overgrazing", "Phil. Trans. R. Soc. B", ["Sea Urchin Barrens", "Regime Shifts"]],
  "Eger 2022": ["Global kelp forest restoration: past lessons, present status, and future directions", "Biol. Rev.", ["Kelp Forests", "Urchin Removal Pilot"]],
  "Smale 2019": ["Marine heatwaves threaten global biodiversity and the provision of ecosystem services", "Nat. Clim. Change", ["Marine Heatwaves"]],
  "Bell 2020": ["Three decades of variability in California's giant kelp forests from the Landsat satellites", "Remote Sens. Environ.", ["Remote Sensing", "Giant Kelp"]],
  "Hobday 2016": ["A hierarchical approach to defining marine heatwaves", "Prog. Oceanogr.", ["Marine Heatwaves"]],
  "Oliver 2018": ["Longer and more frequent marine heatwaves over the past century", "Nat. Commun.", ["Marine Heatwaves", "The Blob"]],
  "Krumhansl 2016": ["Global patterns of kelp forest change over the past half-century", "PNAS", ["Kelp Forests"]],
  "Steneck 2002": ["Kelp forest ecosystems: biodiversity, stability, resilience and future", "Environ. Conserv.", ["Kelp Forests", "Trophic Cascades"]],
  "Arafeh-Dalmau 2019": ["Extreme marine heatwaves alter kelp forest community near its equatorward distribution limit", "Front. Mar. Sci.", ["Marine Heatwaves", "Giant Kelp"]],
  "Cavanaugh 2019": ["Spatial variability in the resistance and resilience of giant kelp", "Front. Mar. Sci.", ["Giant Kelp", "Remote Sensing"]],
  "McPherson 2021": ["Large-scale shift in the structure of a kelp forest ecosystem co-occurs with an epizootic", "Commun. Biol.", ["Sunflower Sea Star", "Purple Urchins"]],
  "Estes 1974": ["Sea otters: their role in structuring nearshore communities", "Science", ["Sea Otters", "Trophic Cascades"]],
  "Reed 2016": ["Extreme warming challenges sentinel status of kelp forests", "Nat. Commun.", ["Marine Heatwaves", "Giant Kelp"]],
  "Wernberg 2019": ["Status and trends for the world's kelp forests", "World Seas", ["Kelp Forests"]],
  "Hughes 2017": ["Global warming and recurrent mass bleaching of corals", "Nature", ["Coral Bleaching"]],
};
for (const [k, [title, venue, links]] of Object.entries(papers)) {
  add(`Literature/${k}.md`, `# ${k}\n\n**${title}** — *${venue}*\n\nNotes: ${links.map((l) => `[[${l}]]`).join(", ")}.\n\n#paper\n`);
}

// --- Field / Methods / People / Meetings ----------------------------------------
add("Field/Kelp Canopy Survey 2026.md", "# Kelp Canopy Survey 2026\n\nSix sites, monthly. Canopy area from drone mosaics ([[Remote Sensing]]). Feeds [[Chapter 3 - Canopy Recovery]].\n\n![[kelp-canopy-drone.jpg]]\n");
add("Field/Mooring M2 Deployment.md", "# Mooring M2 Deployment\n\nTemperature loggers at 5, 10, 15 m. Gap Aug 2–19 (battery). [[Upwelling]], [[Chapter 2 - Heatwave Exposure]].\n\n![[mooring-temps.png]]\n");
add("Field/Point Lobos Transects.md", "# Point Lobos Transects\n\n30 m band transects, stipe counts and urchin density. [[Giant Kelp]], [[Purple Urchins]].\n\n![[transect-map.png]]\n");
add("Field/Sample Inventory.md", "# Sample Inventory\n\nTissue vials, nitrate samples. Checked with [[Priya Natarajan]].\n");
add("Field/Urchin Removal Pilot.md", "# Urchin Removal Pilot\n\nDivers cull purple urchins to 2/m² on two 20 m plots. Compare to [[Eger 2022]] and [[Ling 2015]]. [[Sea Urchin Barrens]].\n");
const methods = {
  "Canopy Classification": "Random forest on drone RGB; validated against [[Point Lobos Transects]].",
  "Degree Heating Weeks": "Heat exposure metric for [[Chapter 2 - Heatwave Exposure]] ([[Hobday 2016]]).",
  "Urchin Counts": "Quadrat counts per [[Point Lobos Transects]].",
  "Drone Mosaics": "Flight plans with [[Jonah Reyes]]; see [[Remote Sensing]].",
  "Statistics Plan": "Mixed models; site as random effect. For [[Chapter 3 - Canopy Recovery]].",
};
for (const [k, v] of Object.entries(methods)) add(`Methods/${k}.md`, `# ${k}\n\n${v}\n`);
const people = {
  "Maya Okafor": "Advisor. Wants Chapter 2 figures before the committee. [[Thesis]]",
  "Jonah Reyes": "Drone pilot, [[Drone Mosaics]].",
  "Priya Natarajan": "Lab manager. [[Sample Inventory]].",
  "Daniel Brooks": "Committee — physical oceanography. [[Upwelling]]",
  "Hana Sato": "Committee — population ecology. [[Sea Urchin Barrens]]",
};
for (const [k, v] of Object.entries(people)) add(`People/${k}.md`, `# ${k}\n\n${v}\n`);
const meetings = [
  ["2026-09-23 Lab Meeting", "Exposure metrics. [[Degree Heating Weeks]], [[Maya Okafor]]."],
  ["2026-09-30 Lab Meeting", "Canopy mosaics review. [[Drone Mosaics]]."],
  ["2026-10-07 Lab Meeting", "Urchin pilot plots. [[Urchin Removal Pilot]]."],
  ["2026-10-12 Committee Prep", "Outline for [[Thesis]] update with [[Maya Okafor]]."],
  ["2026-09-25 Reading Group", "[[Wernberg 2016]] and [[Smale 2019]]."],
  ["2026-10-02 Reading Group", "[[Filbee-Dexter 2018]] and [[Ling 2015]]."],
  ["2026-10-09 Reading Group", "[[Rogers-Bennett 2019]] and [[McPherson 2021]]."],
];
for (const [k, v] of meetings) add(`Meetings/${k}.md`, `# ${k}\n\n${v}\n`);
const ideas = {
  "Recovery Lag Idea": "Does canopy recovery lag urchin decline by one season? [[Chapter 3 - Canopy Recovery]]",
  "Heat Budget Sketch": "Combine mooring and satellite SST. [[Mooring M2 Deployment]]",
  "Figure Style": "One palette for all chapters. [[Thesis]]",
  "Outreach Talk": "Aquarium talk on [[Sea Otters]] and [[Kelp Forests]].",
  "Grant Report": "Due Oct 30. Summarize [[Kelp Canopy Survey 2026]].",
};
for (const [k, v] of Object.entries(ideas)) add(`Ideas/${k}.md`, `# ${k}\n\n${v}\n`);

for (const a of ["canopy-2026.png","field-station-dawn.jpg","kelp-canopy-drone.jpg","mooring-temps.png","sst-anomaly.png","transect-map.png"]) add(`Attachments/${a}`, "");

add("calendar.json", JSON.stringify([
  { date: "2026-10-02", title: "Nitrate sampling" },
  { date: "2026-10-07", title: "Lab meeting" },
  { date: "2026-10-08", title: "Dive — Point Lobos" },
  { date: "2026-10-14", title: "Chapter 2 figures due" },
  { date: "2026-10-16", title: "Drone flight" },
  { date: "2026-10-20", title: "Committee meeting" },
  { date: "2026-10-21", title: "Lab meeting" },
  { date: "2026-10-23", title: "Urchin removal dive" },
  { date: "2026-10-28", title: "Lab meeting" },
  { date: "2026-10-30", title: "Grant deadline" },
], null, 2) + "\n");

export default V;
