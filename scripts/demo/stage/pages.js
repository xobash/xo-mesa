// Offline stand-ins for the web pages Pi reads during the demo. Titles are real
// public papers; bodies are short paraphrased summaries written for the demo.
(() => {
  const S = window.__REC_SHARED__;
  const css = `
  body{margin:0;background:#f7f5f0;color:#1d1f24;font:17px/1.6 Georgia,"Iowan Old Style",serif}
  main{max-width:660px;margin:0 auto;padding:34px 30px 60px}
  .kick{font:600 12px/1 -apple-system,Inter,system-ui,sans-serif;letter-spacing:1.6px;text-transform:uppercase;color:#6b6457}
  h1{font:700 34px/1.14 -apple-system,Inter,system-ui,sans-serif;letter-spacing:-.6px;margin:14px 0 14px}
  .by{font:14px -apple-system,Inter,system-ui,sans-serif;color:#5d5a54;margin-bottom:22px}
  h2{font:700 19px -apple-system,Inter,system-ui,sans-serif;margin:30px 0 8px}
  figure{margin:24px 0;padding:16px 16px 10px;background:#fff;border:1px solid #e3ddd1;border-radius:6px}
  figcaption{font:13px -apple-system,Inter,system-ui,sans-serif;color:#6b6457;margin-top:6px}
  a{color:#1f5fbf}
  .r{margin:0 0 22px}.r a{font:600 18px/1.3 -apple-system,Inter,system-ui,sans-serif;text-decoration:none;color:#1a4fa8}
  .r .u{font:13px -apple-system,Inter,system-ui,sans-serif;color:#2f7d4f;margin:3px 0}.r p{margin:2px 0;font-size:15px;color:#3b3d42}
  .q{font:14px -apple-system,Inter,system-ui,sans-serif;color:#6b6457;margin-bottom:18px}`;
  const chart = (seed) => {
    let pts = [], y = 70;
    for (let i = 0; i <= 24; i++) { y = Math.max(18, Math.min(110, y + Math.sin(i * 1.7 + seed) * 9 - (i > 6 && i < 10 ? 14 : 0) + (i > 12 ? 3 : 0))); pts.push(`${20 + i * 25},${y.toFixed(1)}`); }
    return `<svg viewBox="0 0 640 130" width="100%" xmlns="http://www.w3.org/2000/svg"><g stroke="#e6e0d4">${[30, 60, 90, 120].map((v) => `<line x1="20" x2="620" y1="${v}" y2="${v}"/>`).join("")}</g><rect x="195" y="10" width="75" height="112" fill="#f3d9c9" opacity=".7"/><polyline fill="none" stroke="#2a6db0" stroke-width="2.5" points="${pts.join(" ")}"/></svg>`;
  };
  const article = ({ kicker, title, by, abstract, sections, fig }) => `<!doctype html><html><head><title>${title}</title><style>${css}</style></head><body><main>
    <div class="kick">${kicker}</div><h1>${title}</h1><div class="by">${by}</div><p>${abstract}</p>
    ${fig ? `<figure>${chart(typeof fig === "number" ? fig : 0.9)}<figcaption>${typeof fig === "string" ? fig : "Canopy area index by year; shaded band marks the marine heatwave."}</figcaption></figure>` : ""}
    ${sections.map(([h, p]) => `<h2>${h}</h2><p>${p}</p>`).join("")}</main></body></html>`;

  const A = {
    "https://en.wikipedia.org/wiki/Kelp_forest": { kicker: "Encyclopedia", title: "Kelp forest", by: "Reader view · summary", fig: "Giant kelp can grow tens of centimetres per day in good conditions.",
      abstract: "Kelp forests are underwater areas with a high density of large brown algae. They occur in cold, nutrient-rich coastal waters and are among the most productive and dynamic ecosystems on Earth.",
      sections: [["Threats", "Marine heatwaves, nutrient-poor warm water, overgrazing by sea urchins and the loss of urchin predators have all caused declines in several regions."], ["Recovery", "Recovery times vary widely — from a few years where cool water and predators return, to decades or longer where urchin barrens or turf algae take hold."]] },
    "https://www.science.org/doi/10.1126/science.aad8745": { kicker: "Report · Science · 2016", title: "Climate-driven regime shift of a temperate marine ecosystem", by: "Wernberg T. et al. · Science 353, 169–172", fig: 1.3,
      abstract: "After a 2011 marine heatwave, kelp forests along 100 km of the Western Australian coast were replaced by seaweed turfs and warm-water species, with no recovery observed in the following years.",
      sections: [["Persistence", "Turf-dominated reefs persisted after temperatures returned to normal, suggesting a shift to an alternative stable state."]] },
    "https://www.frontiersin.org/articles/10.3389/fmars.2019.00499": { kicker: "Original research · Frontiers in Marine Science · 2019", title: "Extreme marine heatwaves alter kelp forest community near its equatorward distribution limit", by: "Arafeh-Dalmau N. et al. · Front. Mar. Sci. 6:499", fig: 2.1,
      abstract: "Giant kelp in Baja California declined sharply during the 2014–2016 heatwaves; responses differed among sites, and some recovered within two years while others did not.",
      sections: [["Site differences", "Sites with cooler local upwelling recovered first."]] },
    "https://royalsocietypublishing.org/doi/10.1098/rstb.2013.0269": { kicker: "Review · Phil. Trans. R. Soc. B · 2015", title: "Global regime shift dynamics of catastrophic sea urchin overgrazing", by: "Ling S.D. et al. · Phil. Trans. R. Soc. B 370", fig: 0.6,
      abstract: "Across temperate reefs, kelp returns only when urchin density falls far below the density that caused the collapse — a hysteresis that makes barrens self-reinforcing.",
      sections: [["Thresholds", "The forward and reverse shift thresholds differ by roughly an order of magnitude in urchin biomass."]] },
    "https://www.nature.com/articles/s41598-019-51114-y": { kicker: "Article · Scientific Reports · 2019", title: "Marine heat wave and multiple stressors tip bull kelp forest to sea urchin barrens", by: "Rogers-Bennett L. & Catton C.A. · Sci. Rep. 9, 15050", fig: 2.7,
      abstract: "Northern California lost more than 90% of its bull kelp canopy after the 2014–2016 heatwave combined with sea star wasting disease and an urchin outbreak; barrens persisted after the water cooled.",
      sections: [["Outlook", "Without predators, purple urchin barrens remained stable for years."]] },
    "https://academic.oup.com/bioscience/article/68/2/64/4810652": { kicker: "Overview · BioScience · 2018", title: "Rise of turfs: a new battlefront for globally declining kelp forests", by: "Filbee-Dexter K. & Wernberg T. · BioScience 68, 64–76", fig: 3.4,
      abstract: "Turf algae increasingly replace kelp after disturbance and block recruitment, creating persistent alternative states.",
      sections: [["Mechanisms", "Turfs trap sediment and pre-empt space, so kelp spores cannot settle."]] },
    "https://onlinelibrary.wiley.com/doi/10.1111/brv.12850": { kicker: "Review · Biological Reviews · 2022", title: "Global kelp forest restoration: past lessons, present status, and future directions", by: "Eger A.M. et al. · Biol. Rev. 97, 1449–1475", fig: 4.2,
      abstract: "A global synthesis of kelp restoration projects covering urchin removal, transplanting and seeding.",
      sections: [["What works", "Grazer control and transplanting succeed most often, but outcomes vary with scale and the evidence base is uneven."]] },
  };
  const results = {
    default: [
      ["https://en.wikipedia.org/wiki/Kelp_forest", "Kelp forest — overview", "en.wikipedia.org › wiki › Kelp_forest", "Large brown algae forests in cold, nutrient-rich water. Recovery after heatwaves depends on grazing and turf feedbacks."],
      ["https://www.nature.com/articles/s41598-019-51114-y", "Marine heat wave and multiple stressors tip bull kelp forest to sea urchin barrens", "www.nature.com › articles › s41598-019-51114-y", "Northern California bull kelp collapse after 2014–2016 and lasting urchin barrens."],
      ["https://royalsocietypublishing.org/doi/10.1098/rstb.2013.0269", "Global regime shift dynamics of catastrophic sea urchin overgrazing", "royalsocietypublishing.org › doi › rstb.2013.0269", "Hysteresis in barren formation and recovery across temperate reefs."],
      ["https://www.science.org/doi/10.1126/science.aad8745", "Climate-driven regime shift of a temperate marine ecosystem", "www.science.org › doi › science.aad8745", "Western Australia: kelp replaced by turfs after the 2011 heatwave."],
      ["https://www.frontiersin.org/articles/10.3389/fmars.2019.00499", "Extreme marine heatwaves alter kelp forest community near its equatorward distribution limit", "www.frontiersin.org › articles › fmars.2019.00499", "Baja California sites differed in recovery after 2014–2016."],
    ],
  };
  const searchPage = (q) => `<!doctype html><html><head><title>${q}</title><style>${css}</style></head><body><main>
    <div class="q">Results for <b>${q.replace(/</g, "&lt;")}</b></div>
    ${results.default.map(([u, t, d, p]) => `<div class="r"><a href="${u}">${t}</a><div class="u">${d}</div><p>${p}</p></div>`).join("")}</main></body></html>`;

  S.pages = {
    articles: A,
    fetch(url) {
      const u = new URL(url);
      if (u.hostname.endsWith("duckduckgo.com")) {
        const q = u.searchParams.get("q") || "";
        return { finalUrl: url, status: 200, contentType: "text/html; charset=utf-8", body: searchPage(q) };
      }
      const key = url.split("#")[0];
      const a = A[key];
      if (!a) return { finalUrl: url, status: 200, contentType: "text/html", body: `<html><body><main><h1>${u.hostname}</h1></main></body></html>` };
      return { finalUrl: key, status: 200, contentType: "text/html; charset=utf-8", body: article(a) };
    },
  };
})();
