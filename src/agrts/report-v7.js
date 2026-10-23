// Report v7 (experiment, opt-in; v6 stays the default). Text, still human-readable.
// v7 differs from v6 in four places only; every other section is byte-identical:
//   1. change -> event codes:  "lost 1T 1M, E bought 1R" -> "L:T1,M1 EB:R1"   (see CODES below)
//   2. standing keeps v6's word (zones, then Team HP tie-break) and adds the numeric zone margin: "ahead z+2"
//   3. "can buy: T70x1 R40x2(1fit)" -> "buy b108 T1 R2(1fit)"  (bank moves here from res; prices drop out)
//      prices go once as "px T70 O44 R40 M36 S28 D20 base12" on READY (or the first line a seat sees), and again only if one changes
//   4. note: dropped when it only repeats the codes ("E bought 1R", "autopilot acted" -> AP); kept for rare events (draft, drone hit, won)
// Orders: a client may prefix an order "#<id> "; the arena answers "ACK <id> OK" or "ACK <id> ERR <code>" (protocol.js ERR_CODES).
'use strict';
const CODES = [ // v6 change fragment -> v7 code
  [/^no change$/, () => '-'],
  [/^\+(\d+) zones?$/, m => `Z+${m[1]}`], [/^-(\d+) zones?$/, m => `Z-${m[1]}`],
  [/^E \+(\d+) zones?$/, m => `EZ+${m[1]}`], [/^E -(\d+) zones?$/, m => `EZ-${m[1]}`],
  [/^E \+(\d+)M$/, m => `EM+${m[1]}`], [/^E -(\d+)M$/, m => `EM-${m[1]}`], [/^now (\d+)M$/, m => `EMn${m[1]}`],
  [/^E lost (.+)$/, m => `EL:${q(m[1])}`], [/^lost (.+)$/, m => `L:${q(m[1])}`],
  [/^E bought (.+)$/, m => `EB:${q(m[1])}`], [/^auto bought (.+)$/, m => `AB:${q(m[1])}`],
];
function q(s) { return s.trim().split(/\s+/).map(t => { const m = t.match(/^(\d+)([A-Z])$/); return m ? m[2] + m[1] : t; }).join(','); }
function uq(s) { return s.split(',').map(t => { const m = t.match(/^([A-Z])(\d+)$/); return m ? m[2] + m[1] : t; }).join(' '); }
function changeToCodes(change) {
  return change.split(', ').map(f => { for (const [re, fn] of CODES) { const m = f.match(re); if (m) return fn(m); } return '"' + f.replace(/"/g, "'") + '"'; }).join(' ');
}
const NOTE_DUP = [/^E bought [\d A-Z]+$/, /^autopilot acted$/];
function noteToV7(note) { // returns { ap, note }
  let ap = false; const keep = [];
  for (const f of note.split(', ')) { if (f === 'autopilot acted') { ap = true; continue; } if (NOTE_DUP.some(re => re.test(f))) continue; keep.push(f); }
  return { ap, note: keep.join(', ') };
}
/** ctx per seat: { px: last price string sent }. Returns the v7 line. */
function toV7(line, ctx = {}) {
  const p = line.split(' | ');
  const h = p[0].match(/^v6 (T\d+ \w+)$/); if (!h) return line;
  const out = [`v7 ${h[1]}`];
  let note = null, ap = false, prices = {}, buyTok = 'none', bank = null, zg = 0, ze = 0;
  for (const s of p) { const z = s.match(/^z (\d+)\/(\d+)/); if (z) { zg = +z[1]; ze = +z[2]; } }
  for (let i = 1; i < p.length; i++) {
    const s = p[i];
    if (i === 1) { out.push(changeToCodes(s)); continue; }
    if (i === 2) { const d = zg - ze; out.push(`${s} z${d >= 0 ? '+' : ''}${d}`); continue; }
    let m;
    if ((m = s.match(/^can buy: (.*)$/))) {
      const toks = m[1].trim() === 'none' ? [] : m[1].trim().split(/\s+/);
      buyTok = toks.length ? toks.map(t => { const k = t.match(/^([A-Z])(\d+)x(\d+)(\(\d+fit\))?$/); if (!k) return t; prices[k[1]] = +k[2]; return k[1] + k[3] + (k[4] || ''); }).join(' ') : 'none';
      out.push('@BUY@'); continue;
    }
    if ((m = s.match(/^res (.*?) b(\d+)( h\d+.*)$/))) { bank = +m[2]; out.push(`res ${m[1]}${m[3]}`); continue; }
    if ((m = s.match(/^note: (.*)$/))) { const r = noteToV7(m[1]); ap = r.ap; if (r.note) note = `note: ${r.note}`; continue; }
    if ((m = s.match(/^income \+(\d+(?:\.\d)?)\/([\d.]+)s flat(?: · posts (.*?) · E posts (.*))?$/))) { out.push(`inc +${m[1]}/${m[2]}s`); if (m[3]) out.push(`post ${m[3].replace(/(OB|FOB) /g, '$1:')} E:${m[4]}`); continue; }
    if ((m = s.match(/^income \+(\d+)\/4s \(base (\d+)\)$/))) { out.push(`inc +${m[1]}`); continue; }
    if ((m = s.match(/^income \+(\d+)\/4s base, need (\d+) zones? on E half$/))) { out.push(`inc +${m[1]} need ${m[2]}z E-half`); continue; }
    out.push(s);
  }
  if (ap) out[1] = out[1] === '-' ? 'AP' : out[1] + ' AP';
  const bi = out.indexOf('@BUY@');
  if (bi >= 0) out[bi] = `buy b${bank == null ? 0 : bank} ${buyTok}`;
  // price table: READY / first line seen / a changed price. Static list from the arena when known, else what this line shows.
  const table = Object.assign({}, ctx.table || {}, ctx.pxMap || {}, prices);
  const pxStr = Object.entries(table).map(([k, v]) => k + v).join(' ');
  const changed = Object.keys(prices).some(k => ctx.pxMap && ctx.pxMap[k] !== undefined && ctx.pxMap[k] !== prices[k]) || (Object.keys(prices).some(k => !ctx.pxMap || ctx.pxMap[k] === undefined));
  if (!ctx.sent || / (READY|START)$/.test(out[0]) || changed) { out.splice(1, 0, `px ${pxStr}`); ctx.sent = true; }
  ctx.pxMap = table;
  if (note) out.push(note);
  return out.join(' | ');
}
/** Order id helpers. */
function tagOrders(lines, start) { return lines.map((l, i) => `#${start + i} ${l}`); }
function splitTag(line) { const m = String(line).match(/^#(\d+) (.*)$/); return m ? { id: +m[1], line: m[2] } : { id: null, line: String(line) }; }
function ackLine(id, result, errCode) { return /^OK/.test(result) ? `ACK ${id} OK` : `ACK ${id} ERR ${errCode(String(result).replace(/^ERR [^:]*:\s*/, ''))}`; }
module.exports = { toV7, changeToCodes, uq, tagOrders, splitTag, ackLine, CODES };
/** Arena price table by code (FIELD_COST), for the READY px line. */
module.exports.arenaTable = function arenaTable() {
  try { const { TYPE_IDS, FIELD_COST } = require('./constants'); const { CODE_BY_TYPE } = require('./units'); const t = {}; for (const ty of TYPE_IDS) if (CODE_BY_TYPE[ty] && FIELD_COST[ty] > 0) t[CODE_BY_TYPE[ty]] = FIELD_COST[ty]; return t; } catch { return { T: 70, O: 44, R: 40, M: 36, S: 28, D: 20 }; }
};
