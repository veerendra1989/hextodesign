/*  hextodesign — Design System Generation Engine (Server-only)
    Takes hex + font config → produces a complete token set.
    Pure math, no dependencies.
    ⚠ This file must NEVER be served to browsers. */

"use strict";

/* ── Color math ── */

function hexToRgb(hex) {
  hex = hex.replace("#", "");
  return [
    parseInt(hex.slice(0, 2), 16) / 255,
    parseInt(hex.slice(2, 4), 16) / 255,
    parseInt(hex.slice(4, 6), 16) / 255
  ];
}

function rgbToHex(r, g, b) {
  var toHex = function(c) {
    var v = Math.round(Math.max(0, Math.min(1, c)) * 255);
    return (v < 16 ? "0" : "") + v.toString(16);
  };
  return "#" + toHex(r) + toHex(g) + toHex(b);
}

function linearize(c) {
  return c > 0.04045 ? Math.pow((c + 0.055) / 1.055, 2.4) : c / 12.92;
}

function delinearize(c) {
  return c > 0.0031308 ? 1.055 * Math.pow(c, 1.0 / 2.4) - 0.055 : 12.92 * c;
}

function rgbToOklch(r, g, b) {
  var lr = linearize(r), lg = linearize(g), lb = linearize(b);
  var l_ = 0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb;
  var m_ = 0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb;
  var s_ = 0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb;
  var l = Math.cbrt(l_), m = Math.cbrt(m_), s = Math.cbrt(s_);
  var L = 0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s;
  var a = 1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s;
  var bv = 0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s;
  var C = Math.sqrt(a * a + bv * bv);
  var H = ((Math.atan2(bv, a) * 180 / Math.PI) + 360) % 360;
  return { L: L, C: C, H: H };
}

function oklchToRgb(L, C, H) {
  var hRad = H * Math.PI / 180;
  var a = C * Math.cos(hRad);
  var b = C * Math.sin(hRad);
  var l = L + 0.3963377774 * a + 0.2158037573 * b;
  var m = L - 0.1055613458 * a - 0.0638541728 * b;
  var s = L - 0.0894841775 * a - 1.2914855480 * b;
  l = l * l * l; m = m * m * m; s = s * s * s;
  var r = +4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
  var g = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
  var bv = -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s;
  return [
    Math.max(0, Math.min(1, delinearize(r))),
    Math.max(0, Math.min(1, delinearize(g))),
    Math.max(0, Math.min(1, delinearize(bv)))
  ];
}

function oklchToHex(L, C, H) {
  var rgb = oklchToRgb(L, C, H);
  return rgbToHex(rgb[0], rgb[1], rgb[2]);
}

/* ── Relative luminance + WCAG contrast ── */

function relativeLuminance(r, g, b) {
  return 0.2126 * linearize(r) + 0.7152 * linearize(g) + 0.0722 * linearize(b);
}

function contrastRatio(hex1, hex2) {
  var rgb1 = hexToRgb(hex1), rgb2 = hexToRgb(hex2);
  var l1 = relativeLuminance(rgb1[0], rgb1[1], rgb1[2]);
  var l2 = relativeLuminance(rgb2[0], rgb2[1], rgb2[2]);
  var lighter = Math.max(l1, l2), darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}

function contrastGrade(ratio) {
  if (ratio >= 7) return "AAA";
  if (ratio >= 4.5) return "AA";
  if (ratio >= 3) return "AA-lg";
  return "Fail";
}

/* ── Palette generation ── */

function generatePalette(hex) {
  var rgb = hexToRgb(hex);
  var oklch = rgbToOklch(rgb[0], rgb[1], rgb[2]);
  var H = oklch.H;
  var C = oklch.C;
  var L = oklch.L;

  /* 500 = exact input color. Other stops interpolate from it.
     Lighter stops (50–400): lerp L from input toward 0.98 (near white)
     Darker stops (600–950): lerp L from input toward 0.15 (near black)
     Chroma scales: peaks at 500 (1.0), tapers toward both ends */

  var LIGHT_CEIL = 0.98;
  var DARK_FLOOR = 0.15;

  var stops = [
    { stop: 50,  t: 0.95, side: "light", cMul: 0.15 },
    { stop: 100, t: 0.82, side: "light", cMul: 0.30 },
    { stop: 200, t: 0.64, side: "light", cMul: 0.55 },
    { stop: 300, t: 0.44, side: "light", cMul: 0.75 },
    { stop: 400, t: 0.22, side: "light", cMul: 0.90 },
    { stop: 500, t: 0,    side: "anchor", cMul: 1.00 },
    { stop: 600, t: 0.22, side: "dark",  cMul: 0.95 },
    { stop: 700, t: 0.42, side: "dark",  cMul: 0.85 },
    { stop: 800, t: 0.60, side: "dark",  cMul: 0.70 },
    { stop: 900, t: 0.78, side: "dark",  cMul: 0.55 },
    { stop: 950, t: 0.92, side: "dark",  cMul: 0.40 }
  ];

  var palette = {};
  stops.forEach(function(s) {
    var sL, cVal;
    if (s.side === "anchor") {
      sL = L;
      cVal = C;
    } else if (s.side === "light") {
      sL = L + (LIGHT_CEIL - L) * s.t;
      cVal = Math.min(0.32, C * s.cMul);
    } else {
      sL = L - (L - DARK_FLOOR) * s.t;
      cVal = Math.min(0.32, C * s.cMul);
    }
    sL = Math.max(0.05, Math.min(0.99, sL));

    if (s.side === "anchor") {
      /* Use exact input hex at 500 */
      palette[s.stop] = {
        hex: hex.toUpperCase(),
        oklch: "oklch(" + L.toFixed(2) + " " + C.toFixed(3) + " " + H.toFixed(1) + ")"
      };
    } else {
      var hexVal = oklchToHex(sL, cVal, H);
      palette[s.stop] = {
        hex: hexVal.toUpperCase(),
        oklch: "oklch(" + sL.toFixed(2) + " " + cVal.toFixed(3) + " " + H.toFixed(1) + ")"
      };
    }
  });

  return { brand: palette, hue: H, chroma: C };
}

/* ── Semantic colors ── */

function generateSemantics(brandHue) {
  var semantics = {
    success: { H: 155, L: 0.65, C: 0.16, label: "Success" },
    warning: { H: 75,  L: 0.75, C: 0.16, label: "Warning" },
    error:   { H: 25,  L: 0.60, C: 0.20, label: "Error" },
    info:    { H: 230, L: 0.65, C: 0.14, label: "Info" }
  };

  var result = {};
  Object.keys(semantics).forEach(function(key) {
    var s = semantics[key];
    result[key] = {
      label: s.label,
      base: oklchToHex(s.L, s.C, s.H).toUpperCase(),
      light: oklchToHex(0.92, s.C * 0.3, s.H).toUpperCase(),
      dark: oklchToHex(0.30, s.C * 0.6, s.H).toUpperCase(),
      oklch: "oklch(" + s.L.toFixed(2) + " " + s.C.toFixed(2) + " " + s.H + ")"
    };
  });

  return result;
}

/* ── Surface colors (dark + light themes) ── */

function generateSurfaces(brandHue) {
  /* Dark surfaces: rich hue-tinted near-black — not pure black.
     Chroma tapers as lightness rises so highlights don't oversaturate.
     Light surfaces: very subtle tint only. */
  var darkC  = 0.035; /* base chroma for dark bg  */
  var lightC = 0.006; /* subtle tint for light bg */

  return {
    dark: {
      bg:    oklchToHex(0.13, darkC,        brandHue).toUpperCase(),
      bg1:   oklchToHex(0.16, darkC * 0.80, brandHue).toUpperCase(),
      bg2:   oklchToHex(0.19, darkC * 0.63, brandHue).toUpperCase(),
      bg3:   oklchToHex(0.22, darkC * 0.46, brandHue).toUpperCase(),
      bg4:   oklchToHex(0.26, darkC * 0.29, brandHue).toUpperCase(),
      ink:   "#F3F1EC",
      ink2:  "#C8C5BD",
      ink3:  "#8B877E",
      ink4:  "#5A574F"
    },
    light: {
      bg:    oklchToHex(0.97, lightC,        brandHue).toUpperCase(),
      bg1:   oklchToHex(0.95, lightC * 0.90, brandHue).toUpperCase(),
      bg2:   oklchToHex(0.92, lightC * 0.80, brandHue).toUpperCase(),
      bg3:   oklchToHex(0.88, lightC * 0.67, brandHue).toUpperCase(),
      bg4:   oklchToHex(0.83, lightC * 0.50, brandHue).toUpperCase(),
      ink:   "#14120E",
      ink2:  "#44403A",
      ink3:  "#78736A",
      ink4:  "#A8A294"
    }
  };
}

/* ── Type scale (Major Third — 1.250) ── */

function generateTypeScale(fontConfig) {
  var ratio = 1.250;
  var base = 16;
  var sans = fontConfig ? fontConfig.sans : "Geist";
  var mono = fontConfig ? fontConfig.mono : "Geist Mono";
  var cssVar = fontConfig ? fontConfig.cssVar : '"Geist", ui-sans-serif, sans-serif';
  var monoVar = fontConfig ? fontConfig.monoVar : '"Geist Mono", ui-monospace, monospace';

  function round(n) { return Math.round(n * 100) / 100; }

  var scale = {
    "display":  { size: round(base * Math.pow(ratio, 5)), weight: 700, lineHeight: 1.1,  letterSpacing: "-0.04em" },
    "h1":       { size: round(base * Math.pow(ratio, 4)), weight: 700, lineHeight: 1.15, letterSpacing: "-0.03em" },
    "h2":       { size: round(base * Math.pow(ratio, 3)), weight: 600, lineHeight: 1.2,  letterSpacing: "-0.02em" },
    "h3":       { size: round(base * Math.pow(ratio, 2)), weight: 600, lineHeight: 1.25, letterSpacing: "-0.01em" },
    "h4":       { size: round(base * Math.pow(ratio, 1)), weight: 600, lineHeight: 1.3,  letterSpacing: "-0.005em" },
    "h5":       { size: base,                              weight: 600, lineHeight: 1.4,  letterSpacing: "0" },
    "h6":       { size: round(base / ratio),               weight: 600, lineHeight: 1.4,  letterSpacing: "0.01em" },
    "body-lg":  { size: 18,                                weight: 400, lineHeight: 1.6,  letterSpacing: "0" },
    "body":     { size: 16,                                weight: 400, lineHeight: 1.6,  letterSpacing: "0" },
    "body-sm":  { size: 14,                                weight: 400, lineHeight: 1.5,  letterSpacing: "0.005em" },
    "caption":  { size: 12,                                weight: 400, lineHeight: 1.5,  letterSpacing: "0.01em" },
    "overline": { size: 11,                                weight: 600, lineHeight: 1.4,  letterSpacing: "0.08em", textTransform: "uppercase" }
  };

  return {
    scale: scale,
    families: { sans: sans, mono: mono, cssVar: cssVar, monoVar: monoVar },
    base: base,
    ratio: ratio
  };
}

/* ── Spacing scale (base 4) ── */

function generateSpacing() {
  var base = 4;
  var tokens = {};
  var steps = [0, 0.5, 1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10, 12, 16, 20, 24, 32, 40, 48, 64];
  steps.forEach(function(s) {
    tokens[s] = (s * base) + "px";
  });
  return { base: base, tokens: tokens };
}

/* ── Radius scale ── */

function generateRadius() {
  return {
    none: "0px", sm: "2px", md: "6px", DEFAULT: "6px",
    lg: "10px", xl: "14px", "2xl": "20px", "3xl": "28px", full: "9999px"
  };
}

/* ── Shadow scale ── */

function generateShadows() {
  return {
    xs:  "0 1px 2px rgba(0,0,0,0.05)",
    sm:  "0 1px 3px rgba(0,0,0,0.10), 0 1px 2px rgba(0,0,0,0.06)",
    md:  "0 4px 6px -1px rgba(0,0,0,0.10), 0 2px 4px -2px rgba(0,0,0,0.10)",
    lg:  "0 10px 15px -3px rgba(0,0,0,0.10), 0 4px 6px -4px rgba(0,0,0,0.10)",
    xl:  "0 20px 25px -5px rgba(0,0,0,0.10), 0 8px 10px -6px rgba(0,0,0,0.10)",
    "2xl": "0 25px 50px -12px rgba(0,0,0,0.25)",
    inner: "inset 0 2px 4px rgba(0,0,0,0.06)"
  };
}

/* ── Main generate function ── */

function generate(hex, fontConfig) {
  if (!hex || !/^#[0-9a-fA-F]{6}$/.test(hex)) {
    throw new Error("Invalid hex color: " + hex);
  }

  var palette = generatePalette(hex);
  var semantics = generateSemantics(palette.hue);
  var surfaces = generateSurfaces(palette.hue);
  var typeScale = generateTypeScale(fontConfig);
  var spacing = generateSpacing();
  var radius = generateRadius();
  var shadows = generateShadows();

  var darkBg = surfaces.dark.bg;
  var lightBg = surfaces.light.bg;
  var brand500 = palette.brand[500].hex;

  var contrast = {
    "brand-on-dark":  { ratio: contrastRatio(brand500, darkBg),  grade: contrastGrade(contrastRatio(brand500, darkBg)) },
    "brand-on-light": { ratio: contrastRatio(brand500, lightBg), grade: contrastGrade(contrastRatio(brand500, lightBg)) },
    "ink-on-dark":    { ratio: contrastRatio(surfaces.dark.ink, darkBg),   grade: contrastGrade(contrastRatio(surfaces.dark.ink, darkBg)) },
    "ink-on-light":   { ratio: contrastRatio(surfaces.light.ink, lightBg), grade: contrastGrade(contrastRatio(surfaces.light.ink, lightBg)) }
  };

  return {
    meta: {
      generator: "hextodesign",
      version: "0.5.0",
      created: new Date().toISOString(),
      source: hex
    },
    color: {
      brand: palette.brand,
      semantic: semantics,
      surface: surfaces,
      hue: palette.hue,
      chroma: palette.chroma
    },
    typography: typeScale,
    spacing: spacing,
    radius: radius,
    shadow: shadows,
    contrast: contrast
  };
}

/* ── Module export ── */
module.exports = {
  generate: generate,
  contrastRatio: contrastRatio,
  contrastGrade: contrastGrade,
  hexToRgb: hexToRgb,
  rgbToOklch: rgbToOklch,
  oklchToHex: oklchToHex
};
