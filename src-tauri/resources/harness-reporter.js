// Mesa harness reporter — injected into every page of the NATIVE Pi browser
// harness webview (see src-tauri/src/harness.rs).
//
// The harness webview renders the real site (JS and all). This script is what
// lets the Pi agent "see" it: it snapshots the *rendered* DOM (title, visible
// text, outgoing links) and reports it back to Mesa, so the agent reads exactly
// what the user is looking at in the wing — not a server-side fetch of a JS
// shell.
//
// Transport (belt and suspenders, cross-platform):
//   1. fetch → http://127.0.0.1:<port>/harness on Mesa's loopback activity
//      server. `mode: "no-cors"` + text/plain body = a "simple request": no
//      preflight, and we never need to read the response. Chromium (Windows
//      WebView2) treats 127.0.0.1 as potentially trustworthy, so https pages
//      may call it.
//   2. If fetch rejects (WebKit blocks http-to-loopback from https pages as
//      mixed content), fall back to a hidden-iframe navigation to
//      `mesa-snap://snap/#<payload>`. Rust's on_navigation handler intercepts
//      the scheme, ingests the payload, and cancels the navigation — the page
//      itself is never disturbed. This is the classic pre-IPC webview bridge.
//
// Safety / boundary notes:
//   - Top frame only; ad/embed iframes never report.
//   - The pristine `fetch` is captured at document_start, before page scripts
//     can wrap it. The token never rides in a header (no-cors forbids it); it
//     rides in the body and Mesa verifies it server-side.
//   - This script only READS the DOM. It exposes one global,
//     `__mesaHarnessReport()`, so Mesa can force a fresh snapshot via eval.
//   - Placeholders __MESA_PORT__ / __MESA_TOKEN__ are substituted by Rust at
//     webview creation; the reporter is inert if they are left unfilled.
(function () {
  "use strict";
  if (window.top !== window) return; // subframes stay silent
  if (window.__mesaHarnessReporter) return;
  window.__mesaHarnessReporter = true;

  var PORT = "__MESA_PORT__";
  var TOKEN = "__MESA_TOKEN__";
  if (PORT.indexOf("__") === 0 || TOKEN.indexOf("__") === 0) return; // unfilled template

  var pristineFetch = null;
  try {
    pristineFetch = window.fetch ? window.fetch.bind(window) : null;
  } catch (e) {
    pristineFetch = null;
  }
  var channel = pristineFetch ? "fetch" : "frame";

  var TEXT_CAP = 60000;
  var LINK_CAP = 80;
  var MIN_SEND_GAP_MS = 900;

  var seq = 0;
  var timer = null;
  var lastSentAt = 0;
  var lastSentText = null;
  var lastHref = "";

  function collect() {
    var text = "";
    try {
      text = (document.body && document.body.innerText) || "";
    } catch (e) {
      text = "";
    }
    if (text.length > TEXT_CAP) text = text.slice(0, TEXT_CAP) + "\n[truncated]";
    var links = [];
    try {
      var seen = {};
      var anchors = document.querySelectorAll("a[href]");
      for (var i = 0; i < anchors.length && links.length < LINK_CAP; i++) {
        var a = anchors[i];
        var href = "";
        try {
          href = String(a.href || "");
        } catch (e2) {
          continue;
        }
        if (!/^https?:\/\//i.test(href) || seen[href]) continue;
        var label = String(a.textContent || "").replace(/\s+/g, " ").trim().slice(0, 80);
        if (!label) continue;
        seen[href] = 1;
        links.push(label + " :: " + href.slice(0, 500));
      }
    } catch (e3) {
      /* link harvesting is best-effort */
    }
    seq += 1;
    return {
      token: TOKEN,
      url: String(location.href).slice(0, 2000),
      title: String(document.title || "").slice(0, 300),
      ready: String(document.readyState || ""),
      seq: seq,
      text: text,
      links: links,
    };
  }

  function sendViaFrame(payload) {
    try {
      var host = document.documentElement || document.body;
      if (!host) return;
      var f = document.createElement("iframe");
      f.setAttribute("aria-hidden", "true");
      f.style.display = "none";
      f.src = "mesa-snap://snap/#" + encodeURIComponent(JSON.stringify(payload));
      host.appendChild(f);
      setTimeout(function () {
        try {
          f.parentNode && f.parentNode.removeChild(f);
        } catch (e) {
          /* already gone */
        }
      }, 250);
    } catch (e) {
      /* nothing left to try */
    }
  }

  function send(payload) {
    if (channel === "fetch" && pristineFetch) {
      try {
        pristineFetch("http://127.0.0.1:" + PORT + "/harness", {
          method: "POST",
          mode: "no-cors",
          keepalive: true,
          headers: { "Content-Type": "text/plain" },
          body: JSON.stringify(payload),
        }).catch(function () {
          channel = "frame";
          sendViaFrame(payload);
        });
        return;
      } catch (e) {
        channel = "frame";
      }
    }
    sendViaFrame(payload);
  }

  function flush() {
    var payload = collect();
    var moved = payload.url !== lastHref;
    if (!moved && payload.text === lastSentText) return;
    lastHref = payload.url;
    lastSentText = payload.text;
    lastSentAt = Date.now();
    send(payload);
  }

  function schedule(delay) {
    if (timer) clearTimeout(timer);
    timer = setTimeout(function () {
      timer = null;
      var wait = MIN_SEND_GAP_MS - (Date.now() - lastSentAt);
      if (wait > 0) {
        schedule(wait);
        return;
      }
      flush();
    }, delay);
  }

  // Mesa can force an immediate fresh snapshot via webview.eval.
  window.__mesaHarnessReport = function () {
    lastSentText = null;
    lastSentAt = 0;
    schedule(0);
  };

  document.addEventListener("DOMContentLoaded", function () {
    schedule(80);
  });
  window.addEventListener("load", function () {
    schedule(150);
  });
  try {
    new MutationObserver(function () {
      schedule(600);
    }).observe(document.documentElement, {
      subtree: true,
      childList: true,
      characterData: true,
    });
  } catch (e) {
    /* observer unsupported — load/interval paths still report */
  }
  // SPA navigations (history.pushState — YouTube, Google apps) never fire
  // load events; poll the href so the harness address bar and the agent
  // follow along.
  setInterval(function () {
    if (String(location.href) !== lastHref) schedule(60);
  }, 400);
  schedule(300);
})();
