'use strict';
// Angle convention: degrees, 0 = east (+x), 90 = south (+y, screen down), clockwise.
const DEG = Math.PI / 180;
function norm360(a) { a %= 360; return a < 0 ? a + 360 : a; }
// Signed smallest difference b - a in (-180, 180]
function angDiff(a, b) { let d = norm360(b - a); return d > 180 ? d - 360 : d; }
function bearing(x1, y1, x2, y2) { return norm360(Math.atan2(y2 - y1, x2 - x1) / DEG); }
function dist(x1, y1, x2, y2) { return Math.hypot(x2 - x1, y2 - y1); }
function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
// Does segment p0->p1 come within r of point c? Returns fraction t of first contact or null.
function segCircle(x0, y0, x1, y1, cx, cy, r) {
  const dx = x1 - x0, dy = y1 - y0;
  const fx = x0 - cx, fy = y0 - cy;
  const a = dx * dx + dy * dy;
  const c = fx * fx + fy * fy - r * r;
  if (c <= 0) return 0; // already inside
  if (a === 0) return null;
  const b = 2 * (fx * dx + fy * dy);
  const disc = b * b - 4 * a * c;
  if (disc < 0) return null;
  const t = (-b - Math.sqrt(disc)) / (2 * a);
  return t >= 0 && t <= 1 ? t : null;
}
module.exports = { DEG, norm360, angDiff, bearing, dist, clamp, segCircle };
