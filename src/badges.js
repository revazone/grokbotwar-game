'use strict';
// Identity badges: a generated 128x128 PNG from a Grok Bot profile's (name, avatarShape, avatarColor).
// Profiles store only those three strings (any may be empty). Inputs are whitelisted / sanitised:
//   shape: one of SHAPES (unknown/empty -> 'squircle'); color: a named color from COLORS or #rgb/#rrggbb
//   (unknown/empty -> the seat's team color); name: control chars stripped, max 40 chars; initials = up to 2 letters.
const sharp = require('sharp');

const SHAPES = {
  circle: '<circle cx="64" cy="64" r="60"/>',
  squircle: '<path d="M64 4C112 4 124 16 124 64S112 124 64 124 4 112 4 64 16 4 64 4Z"/>',
  square: '<rect x="6" y="6" width="116" height="116" rx="12"/>',
  tablet: '<rect x="20" y="4" width="88" height="120" rx="20"/>',
  hex: '<polygon points="64,4 116,34 116,94 64,124 12,94 12,34"/>',
  diamond: '<polygon points="64,2 126,64 64,126 2,64"/>',
  triangle: '<polygon points="64,6 124,118 4,118"/>',
  pebble: '<path d="M60 8C96 4 124 30 122 66 120 102 94 124 58 120 24 116 4 94 6 62 8 30 28 11 60 8Z"/>',
  blob: '<path d="M70 6C98 8 118 26 122 54 126 80 112 108 86 118 58 128 26 120 12 96-2 72 6 40 26 22 38 11 52 5 70 6Z"/>',
  cloud: '<path d="M34 104C16 104 4 92 4 76 4 61 15 50 29 48 31 28 46 14 66 14 82 14 95 24 100 38 114 39 124 51 124 66 124 72 122 78 119 82 123 86 124 92 122 98 119 103 113 104 106 104Z"/>',
};
const DEFAULT_SHAPE = 'squircle';
const COLORS = {
  black: '#202020', white: '#f2f2f2', gray: '#9ca3af', grey: '#9ca3af', red: '#ef4444', orange: '#f97316',
  yellow: '#facc15', green: '#22c55e', teal: '#14b8a6', cyan: '#22d3ee', blue: '#3b82f6', indigo: '#6366f1',
  violet: '#8b5cf6', purple: '#a855f7', pink: '#ec4899', magenta: '#d946ef', brown: '#a16207',
};

function cleanName(n) { return String(n == null ? '' : n).replace(/[\u0000-\u001f\u007f<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 40); }
function cleanShape(s) { s = String(s == null ? '' : s).trim().toLowerCase(); if (s === 'hexagon') s = 'hex'; return SHAPES[s] ? s : DEFAULT_SHAPE; }
function cleanColor(c, fallback) {
  c = String(c == null ? '' : c).trim().toLowerCase();
  if (COLORS[c]) return COLORS[c];
  if (/^#[0-9a-f]{6}$/.test(c)) return c;
  if (/^#[0-9a-f]{3}$/.test(c)) return '#' + c.slice(1).split('').map(x => x + x).join('');
  return /^#[0-9a-f]{6}$/i.test(fallback || '') ? fallback.toLowerCase() : '#888888';
}
function initials(name) {
  const words = cleanName(name).split(/[^A-Za-z0-9]+/).filter(Boolean);
  if (!words.length) return '?';
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[words.length - 1][0]).toUpperCase();
}
/** Normalise a raw identity. Returns {name, avatarShape, avatarColor, shape, color, initials} (shape/color = resolved). */
function normalizeIdentity(raw, fallbackColor) {
  raw = raw || {};
  const name = cleanName(raw.name);
  const shape = cleanShape(raw.avatarShape), color = cleanColor(raw.avatarColor, fallbackColor);
  const shapeIn = String(raw.avatarShape || '').trim().toLowerCase(), colorIn = String(raw.avatarColor || '').trim().toLowerCase();
  // keep the raw strings only when they were understood (so nothing unsanitised is ever stored or echoed)
  return { name, avatarShape: SHAPES[shapeIn] || shapeIn === 'hexagon' ? shapeIn : '', avatarColor: COLORS[colorIn] || /^#([0-9a-f]{3}|[0-9a-f]{6})$/.test(colorIn) ? colorIn : '',
           shape, color, initials: initials(name), fallback: { shape: !(SHAPES[shapeIn] || shapeIn === 'hexagon'), color: !(COLORS[colorIn] || /^#([0-9a-f]{3}|[0-9a-f]{6})$/.test(colorIn)) } };
}
async function renderBadge(id) {
  const [r, g, b] = [1, 3, 5].map(i => parseInt(id.color.slice(i, i + 2), 16));
  const ink = (0.299 * r + 0.587 * g + 0.114 * b) > 150 ? '#111111' : '#ffffff';
  const fs = id.initials.length > 1 ? 50 : 62;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 128 128">
  <g fill="${id.color}" stroke="${ink === '#ffffff' ? '#bbbbbb' : '#000000'}" stroke-width="3" stroke-opacity="0.6">${SHAPES[id.shape]}</g>
  <text x="64" y="${id.shape === 'triangle' ? 96 : 66}" font-family="DejaVu Sans, Arial, sans-serif" font-weight="bold" font-size="${id.shape === 'triangle' ? 36 : fs}"
        fill="${ink}" text-anchor="middle" dominant-baseline="central">${id.initials}</text></svg>`;
  return sharp(Buffer.from(svg)).png({ compressionLevel: 9 }).toBuffer();
}
module.exports = { SHAPES: Object.keys(SHAPES), COLORS, DEFAULT_SHAPE, normalizeIdentity, renderBadge, cleanName };
