// Report bounded top-frame DOM observations through tokenized POST or intercepted scheme fallback.
// Wait for the per-page token; never put it in the fallback URL. Page content remains untrusted.
(function () {
  "use strict";
  if (window.top !== window) return; // subframes stay silent
  if (window.__mesaHarnessReporter) return;
  window.__mesaHarnessReporter = true;

  var PORT = "__MESA_PORT__";
  var TOKEN = null;
  if (PORT.indexOf("__") === 0) return; // unfilled template

  var pristineFetch = null;
  var pristineStringify = JSON.stringify.bind(JSON);
  var pristineEncode = encodeURIComponent;
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
      // The fallback URL becomes a DOM attribute while the iframe exists.
      // Keep the snapshot credential out of that page-visible URL.
      var framePayload = {
        url: payload.url, title: payload.title, ready: payload.ready,
        seq: payload.seq, text: payload.text, links: payload.links,
      };
      var host = document.documentElement || document.body;
      if (!host) return;
      var f = document.createElement("iframe");
      f.setAttribute("aria-hidden", "true");
      f.style.display = "none";
      f.src = "mesa-snap://snap/#" + pristineEncode(pristineStringify(framePayload));
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
          body: pristineStringify(payload),
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
    if (!TOKEN) return;
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

  Object.defineProperty(window, "__mesaHarnessSetToken", {
    configurable: false,
    writable: false,
    value: function (token) {
      if (typeof token !== "string" || !/^[0-9a-f]{64}$/.test(token)) return;
      TOKEN = token;
      lastSentText = null;
      lastSentAt = 0;
      schedule(0);
    },
  });

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
