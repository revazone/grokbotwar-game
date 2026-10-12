'use strict';
// A seat's base name from the warrior bot's label (its profile title): "Warrior" -> "WARRIOR-01" (Green), "WARRIOR-09" (Ember).
// Same casing as the default HAVEN-01. Empty or unusable label -> null (the arena keeps its default).
const fs = require('fs');
const path = require('path');

const AGENTS_DIR = process.env.GROKBOT_AGENTS_DIR || '/home/box/agent-data/agents';
const BASE_MAX = 24;

/** Clean a base name the arena will show: upper case A-Z 0-9 and single dashes, at most 24 characters. */
function cleanBase(s) {
  const out = String(s == null ? '' : s).toUpperCase().replace(/[^A-Z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, BASE_MAX).replace(/-+$/, '');
  return out || null;
}

/** "<LABEL>-01" from a bot label. The label part is trimmed so the whole name fits. */
function baseFromLabel(label, suffix = '01') {
  const head = cleanBase(label);
  if (!head) return null;
  return cleanBase(`${head.slice(0, BASE_MAX - suffix.length - 1).replace(/-+$/, '')}-${suffix}`);
}

/** Read a bot profile.json; returns {agentId, name, title} or null. */
function readProfile(agentId, dir = AGENTS_DIR) {
  if (!/^[A-Za-z0-9-]{8,64}$/.test(String(agentId || ''))) return null;
  try {
    const j = JSON.parse(fs.readFileSync(path.join(dir, agentId, 'profile.json'), 'utf8'));
    return { agentId, name: String(j.name || ''), title: String(j.title || '') };
  } catch { return null; }
}

/**
 * Find the warrior bot's own profile: an explicit id first, then $GROKBOT_AGENT_ID, then the one
 * profile in the agents folder whose name starts with "GrokBotWar" (only when exactly one does).
 */
function findWarriorProfile({ agentId, dir = AGENTS_DIR, search = true } = {}) {
  for (const id of [agentId, process.env.GROKBOT_AGENT_ID]) {
    if (id) { const p = readProfile(id, dir); if (p) return p; }
  }
  if (!search) return null; // the Ember seat: an explicit id only
  let ids = [];
  try { ids = fs.readdirSync(dir); } catch { return null; }
  const hits = ids.map(id => readProfile(id, dir)).filter(p => p && /^grokbotwar\b/i.test(p.name.trim()));
  return hits.length === 1 ? hits[0] : null;
}

module.exports = { cleanBase, baseFromLabel, readProfile, findWarriorProfile, BASE_MAX, AGENTS_DIR };
