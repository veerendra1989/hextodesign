/*  POST /api/email
    Accepts { email, hex, font? }
    Generates full design system and emails all format files via Resend. */

"use strict";

var engine     = require("./_engine");
var formatters = require("./_formatters");
var ratelimit  = require("./_ratelimit");
var JSZip      = require("jszip");

var FONT_MAP = {
  "Geist":           { sans:"Geist",            mono:"Geist Mono",      cssVar:'"Geist", ui-sans-serif, sans-serif',            monoVar:'"Geist Mono", ui-monospace, monospace' },
  "Inter":           { sans:"Inter",            mono:"JetBrains Mono",  cssVar:'"Inter", ui-sans-serif, sans-serif',            monoVar:'"JetBrains Mono", ui-monospace, monospace' },
  "Plus Jakarta Sans":{ sans:"Plus Jakarta Sans",mono:"Space Mono",     cssVar:'"Plus Jakarta Sans", ui-sans-serif, sans-serif', monoVar:'"Space Mono", ui-monospace, monospace' },
  "DM Sans":         { sans:"DM Sans",          mono:"IBM Plex Mono",   cssVar:'"DM Sans", ui-sans-serif, sans-serif',          monoVar:'"IBM Plex Mono", ui-monospace, monospace' },
  "Outfit":          { sans:"Outfit",           mono:"Fira Code",       cssVar:'"Outfit", ui-sans-serif, sans-serif',           monoVar:'"Fira Code", ui-monospace, monospace' },
  "Playfair Display":{ sans:"Playfair Display", mono:"DM Mono",        cssVar:'"Playfair Display", Georgia, serif',            monoVar:'"DM Mono", ui-monospace, monospace' },
};

function resolveFontConfig(fontName) {
  if (!fontName || typeof fontName !== "string") return null;
  return FONT_MAP[fontName] || FONT_MAP["Inter"];
}

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
          <div style="background:#1E1C2A;border-radius:8px;padding:16px 20px;">
            <div style="font-size:12px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#4A4868;margin-bottom:12px;">Inside the ZIP</div>
            ${[
              { name: "design-tokens.css",  desc: "CSS custom properties" },
              { name: "tailwind.config.js", desc: "Tailwind v3/v4 config" },
              { name: "design-tokens.scss", desc: "SCSS variables" },
              { name: "tokens.json",        desc: "Style Dictionary / Figma Tokens" },
            ].map(f => `
            <div style="display:flex;align-items:center;gap:10px;padding:5px 0;">
              <span style="font-size:12px;font-family:monospace;color:#7B5BFF;">${f.name}</span>
              <span style="font-size:11px;color:#4A4868;">— ${f.desc}</span>
            </div>`).join("")}
          </div>
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
  var ip = ((req.headers["x-forwarded-for"] || "") || (req.connection && req.connection.remoteAddress) || "unknown").split(",")[0].trim();
  var limit = ratelimit.check(ip, "email", 5, 600000);
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
    var tokens = engine.generate(hexFull, resolveFontConfig(font));

    var attachments = [
      { filename: "design-tokens.css",  content: Buffer.from(formatters.toCSSVariables(tokens)).toString("base64")  },
      { filename: "tailwind.config.txt",content: Buffer.from(formatters.toTailwindConfig(tokens)).toString("base64") },
      { filename: "tokens.json",        content: Buffer.from(formatters.toJSON(tokens)).toString("base64")           },
      { filename: "design-tokens.scss", content: Buffer.from(formatters.toSCSS(tokens)).toString("base64")          },
    ];

    var htmlBody = buildEmailHtml(hexFull, tokens);

    var payload = {
      from: "hextodesign <hello@hextodesign.com>",
      to: [email],
      subject: "Your design system is ready to use",
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
