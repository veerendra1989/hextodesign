/*  hextodesign — Event Tracking Endpoint
    Stores analytics events in Upstash Redis via REST API.
    Zero dependencies — uses native fetch.

    Required env vars:
      UPSTASH_REDIS_REST_URL   — e.g. https://xyz.upstash.io
      UPSTASH_REDIS_REST_TOKEN — bearer token
*/

"use strict";

var REDIS_URL = process.env.UPSTASH_REDIS_REST_URL;
var REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

/** Execute a Redis command via Upstash REST API */
async function redis(command) {
  var res = await fetch(REDIS_URL, {
    method: "POST",
    headers: {
      Authorization: "Bearer " + REDIS_TOKEN,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(command),
  });
  if (!res.ok) {
    var text = await res.text();
    throw new Error("Redis error: " + res.status + " " + text);
  }
  return res.json();
}

/** Execute multiple Redis commands in a pipeline */
async function redisPipeline(commands) {
  var res = await fetch(REDIS_URL + "/pipeline", {
    method: "POST",
    headers: {
      Authorization: "Bearer " + REDIS_TOKEN,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(commands),
  });
  if (!res.ok) {
    var text = await res.text();
    throw new Error("Redis pipeline error: " + res.status + " " + text);
  }
  return res.json();
}

/** Get today's date key: YYYY-MM-DD */
function today() {
  return new Date().toISOString().slice(0, 10);
}

/** Get current hour key: YYYY-MM-DD:HH */
function hour() {
  var d = new Date();
  return d.toISOString().slice(0, 10) + ":" + String(d.getUTCHours()).padStart(2, "0");
}

module.exports = async function handler(req, res) {
  // CORS preflight
  if (req.method === "OPTIONS") {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    return res.status(204).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  // Check Redis config
  if (!REDIS_URL || !REDIS_TOKEN) {
    // Silently succeed if analytics not configured — don't break the app
    return res.status(200).json({ ok: true, stored: false });
  }

  try {
    var body = req.body;
    // Handle text/plain from sendBeacon (parse string body)
    if (typeof body === "string") {
      try { body = JSON.parse(body); } catch(pe) { return res.status(400).json({ error: "Invalid JSON" }); }
    }
    if (!body || !body.event) {
      return res.status(400).json({ error: "Missing event field" });
    }

    var event = body.event;       // page_view | generate | export | copy
    var props = body.props || {}; // event-specific properties
    var dateKey = today();
    var hourKey = hour();

    // Build pipeline of Redis commands
    var commands = [];

    // 1. Always increment daily event counter
    commands.push(["HINCRBY", "stats:daily:" + dateKey, event, 1]);

    // 2. Increment hourly counter for time-of-day charts
    commands.push(["HINCRBY", "stats:hourly:" + hourKey, event, 1]);

    // 3. Increment all-time total
    commands.push(["HINCRBY", "stats:totals", event, 1]);

    // 4. Track event-specific dimensions
    switch (event) {
      case "page_view":
        if (props.page) {
          commands.push(["HINCRBY", "stats:pages:" + dateKey, props.page, 1]);
          commands.push(["HINCRBY", "stats:pages:all", props.page, 1]);
        }
        if (props.referrer) {
          commands.push(["HINCRBY", "stats:referrers:" + dateKey, props.referrer, 1]);
        }
        if (props.device) {
          commands.push(["HINCRBY", "stats:devices", props.device, 1]);
        }
        break;

      case "generate":
        if (props.hex) {
          var hexClean = props.hex.toUpperCase().replace("#", "");
          commands.push(["ZINCRBY", "stats:colors:popular", 1, hexClean]);
          commands.push(["HINCRBY", "stats:generates:" + dateKey, hexClean, 1]);
        }
        if (props.font) {
          commands.push(["ZINCRBY", "stats:fonts:popular", 1, props.font]);
        }
        break;

      case "export":
        if (props.format) {
          commands.push(["HINCRBY", "stats:exports:" + dateKey, props.format, 1]);
          commands.push(["HINCRBY", "stats:exports:all", props.format, 1]);
        }
        if (props.type) {
          // "individual" or "zip"
          commands.push(["HINCRBY", "stats:export_type:" + dateKey, props.type, 1]);
          commands.push(["HINCRBY", "stats:export_type:all", props.type, 1]);
        }
        break;

      case "copy":
        if (props.format) {
          commands.push(["HINCRBY", "stats:copies:" + dateKey, props.format, 1]);
          commands.push(["HINCRBY", "stats:copies:all", props.format, 1]);
        }
        break;

      case "cta_click":
        if (props.location) {
          commands.push(["HINCRBY", "stats:cta:" + dateKey, props.location, 1]);
        }
        break;

      case "signup":
      case "purchase":
        commands.push(["HINCRBY", "stats:conversions:" + dateKey, event, 1]);
        if (props.plan) {
          commands.push(["HINCRBY", "stats:plans", props.plan, 1]);
        }
        break;
    }

    // 5. Keep track of active dates (for dashboard date range)
    commands.push(["SADD", "stats:dates", dateKey]);

    // 6. Set TTL on daily keys (auto-expire after 90 days)
    commands.push(["EXPIRE", "stats:daily:" + dateKey, 7776000]);
    commands.push(["EXPIRE", "stats:hourly:" + hourKey, 604800]); // 7 days for hourly

    // Execute all at once
    await redisPipeline(commands);

    res.setHeader("Access-Control-Allow-Origin", "*");
    return res.status(200).json({ ok: true, stored: true });
  } catch (err) {
    // Don't let analytics errors affect UX — fail silently in production
    console.error("[track]", err.message);
    return res.status(200).json({ ok: true, stored: false, error: err.message });
  }
};
