/*  POST /api/email
    Accepts { email, hex, font? }
    Generates full design system and emails all format files via Resend. */

"use strict";

var engine     = require("./_engine");
var formatters = require("./_formatters");
var ratelimit  = require("./_ratelimit");

var CORS_HEADERS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Content-Type": "application/json"
};

function buildEmailHtml(hex, tokens) {
  var brand500 = tokens.color && tokens.color.brand && tokens.color.brand["500"]
    ? tokens.color.brand["500"].hex : hex;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Your hextodesign design system</title>
</head>
<body style="margin:0;padding:0;background:#0D0D12;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#0D0D12;padding:40px 0;">
    <tr><td align="center">
      <table width="560" cellpadding="0" cellspacing="0" style="background:#16151E;border:1px solid #2A2840;border-radius:12px;overflow:hidden;max-width:560px;width:100%;">

        <!-- Header -->
        <tr><td style="padding:32px 36px 24px;">
          <div style="display:inline-block;background:${brand500};border-radius:8px;padding:8px 16px;font-size:13px;font-weight:700;color:#fff;letter-spacing:-0.01em;">hextodesign</div>
        </td></tr>

        <!-- Hero -->
        <tr><td style="padding:0 36px 28px;">
          <div style="width:100%;height:6px;border-radius:99px;background:linear-gradient(90deg,${brand500} 0%,transparent 100%);margin-bottom:28px;"></div>
          <h1 style="margin:0 0 10px;font-size:26px;font-weight:800;color:#F0EEF8;letter-spacing:-0.03em;line-height:1.1;">Your design system is ready.</h1>
          <p style="margin:0;font-size:15px;color:#6B6880;line-height:1.5;">Generated from <span style="color:${brand500};font-weight:600;">${hex.toUpperCase()}</span> — all formats are attached below.</p>
        </td></tr>

        <!-- Files list -->
        <tr><td style="padding:0 36px 28px;">
          <table width="100%" cellpadding="0" cellspacing="0">
            ${[
              { name: "design-tokens.css",  desc: "CSS custom properties — drop into any project" },
              { name: "tailwind.config.js", desc: "Tailwind v3/v4 color + radius config" },
              { name: "design-tokens.scss", desc: "SCSS variables for preprocessor workflows" },
              { name: "tokens.json",        desc: "Raw JSON — Style Dictionary / Figma Tokens" },
            ].map(f => `
            <tr>
              <td style="padding:8px 0;border-bottom:1px solid #1E1C2A;">
                <span style="font-size:13px;font-family:monospace;color:#A09BBF;font-weight:500;">${f.name}</span><br/>
                <span style="font-size:12px;color:#4A4868;">${f.desc}</span>
              </td>
            </tr>`).join("")}
          </table>
        </td></tr>

        <!-- CTA -->
        <tr><td style="padding:0 36px 36px;">
          <a href="https://hextodesign.com/preview?brand=${hex.replace('#','')}" style="display:inline-block;background:${brand500};color:#fff;text-decoration:none;padding:13px 26px;border-radius:8px;font-size:14px;font-weight:700;letter-spacing:-0.01em;">Open in hextodesign →</a>
        </td></tr>

        <!-- Footer -->
        <tr><td style="padding:20px 36px;border-top:1px solid #1E1C2A;">
          <p style="margin:0;font-size:12px;color:#3A3858;">hextodesign.com · You received this because you requested your design system.</p>
        </td></tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

module.exports = async function handler(req, res) {
  if (req.method === "OPTIONS") {
    res.writeHead(204, CORS_HEADERS);
    return res.end();
  }

  if (req.method !== "POST") {
    res.writeHead(405, CORS_HEADERS);
    return res.end(JSON.stringify({ error: "Method not allowed" }));
  }

  // Rate limit: 3 emails per IP per 10 minutes
  var ip = (req.headers["x-forwarded-for"] || req.socket.remoteAddress || "unknown").split(",")[0].trim();
  var limit = ratelimit.check(ip, "email", 3, 600000);
  if (!limit.allowed) {
    res.writeHead(429, CORS_HEADERS);
    return res.end(JSON.stringify({ error: "Too many requests. Please try again later." }));
  }

  var body = req.body || {};
  var email = (body.email || "").trim().toLowerCase();
  var hex   = (body.hex   || "7B5BFF").replace("#", "");
  var font  = body.font   || null;

  // Validate email
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    res.writeHead(400, CORS_HEADERS);
    return res.end(JSON.stringify({ error: "Invalid email address" }));
  }

  // Validate hex
  if (!/^[0-9a-fA-F]{6}$/.test(hex)) {
    res.writeHead(400, CORS_HEADERS);
    return res.end(JSON.stringify({ error: "Invalid hex color" }));
  }

  var hexFull = "#" + hex;

  if (!process.env.RESEND_API_KEY) {
    res.writeHead(500, CORS_HEADERS);
    return res.end(JSON.stringify({ error: "Email service not configured" }));
  }

  try {
    // Generate token set
    var tokens = engine.generate(hexFull, font);

    // Build all format files as base64 attachments
    var attachments = [
      { filename: "design-tokens.css",  content: Buffer.from(formatters.toCSSVariables(tokens)).toString("base64") },
      { filename: "tailwind.config.js", content: Buffer.from(formatters.toTailwindConfig(tokens)).toString("base64") },
      { filename: "design-tokens.scss", content: Buffer.from(formatters.toSCSS(tokens)).toString("base64") },
      { filename: "tokens.json",        content: Buffer.from(formatters.toJSON(tokens)).toString("base64") },
    ];

    var htmlBody = buildEmailHtml(hexFull, tokens);

    var payload = {
      from: "hextodesign <hello@hextodesign.com>",
      to: [email],
      subject: "Your design system from " + hexFull.toUpperCase() + " is ready",
      html: htmlBody,
      attachments: attachments.map(function(a) {
        return { filename: a.filename, content: a.content };
      })
    };

    var response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Authorization": "Bearer " + process.env.RESEND_API_KEY,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });

    var result = await response.json();

    if (!response.ok) {
      console.error("Resend error:", result);
      res.writeHead(502, CORS_HEADERS);
      return res.end(JSON.stringify({ error: "Failed to send email", detail: result }));
    }

    res.writeHead(200, CORS_HEADERS);
    return res.end(JSON.stringify({ ok: true, id: result.id }));

  } catch (err) {
    console.error("email handler error:", err);
    res.writeHead(500, CORS_HEADERS);
    return res.end(JSON.stringify({ error: "Server error: " + err.message }));
  }
};
