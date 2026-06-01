/*  hextodesign — Lightweight Analytics Tracker
    ~1KB minified. Non-blocking, respects Do Not Track.
    Usage:
      htd.track("generate", { hex: "#E0D910", font: "Geist" });
      htd.track("export", { format: "css", type: "zip" });
      htd.track("copy", { format: "tailwind" });
*/

(function () {
  "use strict";

  var ENDPOINT = "/api/track";
  var QUEUE = [];
  var FLUSH_INTERVAL = 3000; // batch events every 3s
  var timer = null;

  // Respect Do Not Track
  var dnt = navigator.doNotTrack === "1" || window.doNotTrack === "1";

  /** Detect device type */
  function getDevice() {
    var w = window.innerWidth;
    if (w < 768) return "mobile";
    if (w < 1024) return "tablet";
    return "desktop";
  }

  /** Get clean referrer domain (strip paths for privacy) */
  function getReferrer() {
    if (!document.referrer) return "direct";
    try {
      var url = new URL(document.referrer);
      if (url.hostname === location.hostname) return "internal";
      return url.hostname;
    } catch (e) {
      return "unknown";
    }
  }

  /** Send events to backend */
  function flush() {
    if (QUEUE.length === 0) return;

    var batch = QUEUE.splice(0, QUEUE.length);

    // Use sendBeacon for reliability (survives page unload)
    if (navigator.sendBeacon) {
      for (var i = 0; i < batch.length; i++) {
        var blob = new Blob([JSON.stringify(batch[i])], { type: "application/json" });
        navigator.sendBeacon(ENDPOINT, blob);
      }
    } else {
      // Fallback: fire-and-forget fetch
      for (var j = 0; j < batch.length; j++) {
        fetch(ENDPOINT, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(batch[j]),
          keepalive: true,
        }).catch(function () {});
      }
    }
  }

  /** Queue an event */
  function track(event, props) {
    if (dnt) return; // respect user preference

    var payload = {
      event: event,
      props: props || {},
    };

    QUEUE.push(payload);

    // Debounce flush
    if (!timer) {
      timer = setTimeout(function () {
        flush();
        timer = null;
      }, FLUSH_INTERVAL);
    }
  }

  /** Auto-track page view on load */
  function trackPageView() {
    track("page_view", {
      page: location.pathname || "/",
      referrer: getReferrer(),
      device: getDevice(),
    });
  }

  // Track page view when DOM is ready
  if (document.readyState === "complete" || document.readyState === "interactive") {
    trackPageView();
  } else {
    document.addEventListener("DOMContentLoaded", trackPageView);
  }

  // Flush on page unload (catch any remaining events)
  window.addEventListener("beforeunload", flush);
  // Also flush on visibility change (mobile tab switching)
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "hidden") flush();
  });

  // Expose globally
  window.htd = {
    track: track,
    flush: flush,
  };
})();
