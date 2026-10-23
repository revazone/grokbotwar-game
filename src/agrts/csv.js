'use strict';
// Tiny CSV reader shared by units.js (units.csv) and rules.js (economy.csv).

/** RFC-4180-ish: commas, double quotes ("" inside quotes), CRLF or LF. Returns rows of { line, cells }. */
function parseCsv(text) {
  const rows = [];
  let cells = [], cell = '', quoted = false, line = 1, rowLine = 1, i = 0;
  const s = String(text).replace(/^\uFEFF/, '');
  const endCell = () => { cells.push(cell); cell = ''; };
  const endRow = () => { endCell(); rows.push({ line: rowLine, cells }); cells = []; rowLine = line; };
  while (i < s.length) {
    const ch = s[i];
    if (quoted) {
      if (ch === '"') {
        if (s[i + 1] === '"') { cell += '"'; i += 2; continue; }
        quoted = false; i++; continue;
      }
      if (ch === '\n') line++;
      cell += ch; i++; continue;
    }
    if (ch === '"' && cell.trim() === '') { quoted = true; cell = ''; i++; continue; }
    if (ch === ',') { endCell(); i++; continue; }
    if (ch === '\r') { i++; continue; }
    if (ch === '\n') { line++; endRow(); i++; continue; }
    cell += ch; i++;
  }
  if (quoted) throw new Error(`line ${rowLine}: unclosed quote`);
  if (cell !== '' || cells.length) endRow();
  return rows.filter(r => !(r.cells.length === 1 && r.cells[0].trim() === '') && !/^\s*#/.test(r.cells[0] || ''));
}

module.exports = { parseCsv };
