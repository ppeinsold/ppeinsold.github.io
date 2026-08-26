'use strict';
const fs = require('fs');
const path = require('path');

/** Minimal .env loader (no dependency). Existing process.env wins. */
function loadEnvFile(file) {
  if (!fs.existsSync(file)) return;
  for (const raw of fs.readFileSync(file, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = val;
  }
}

/** Upper-case, strip accents, collapse whitespace. Makes text matching robust. */
function norm(s) {
  return String(s == null ? '' : s)
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[\u2010-\u2015\u2212]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .toUpperCase();
}

/** norm() with every non-alphanumeric character dropped, for fuzzy label matching. */
function squash(s) {
  return norm(s).replace(/[^A-Z0-9]/g, '');
}

/** "HH:MM" in a given IANA time zone. */
function localTime(tz, date = new Date()) {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(date);
}

/** "07:45-08:30,12:00-12:15" -> true if `now` falls inside one of them. */
function inWindows(spec, tz, date = new Date()) {
  const spans = String(spec || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!spans.length) return true;
  const toMin = (hhmm) => {
    const [h, m] = hhmm.split(':').map(Number);
    return h * 60 + m;
  };
  const now = toMin(localTime(tz, date));
  return spans.some((span) => {
    const [a, b] = span.split('-').map((x) => x.trim());
    if (!a || !b) return false;
    const [from, to] = [toMin(a), toMin(b)];
    return from <= to ? now >= from && now <= to : now >= from || now <= to;
  });
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

function stamp(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
}

/** Keep only the newest `keep` entries of a debug directory. */
function pruneDir(dir, keep) {
  if (!fs.existsSync(dir)) return;
  const entries = fs.readdirSync(dir).sort();
  for (const name of entries.slice(0, Math.max(0, entries.length - keep))) {
    fs.rmSync(path.join(dir, name), { recursive: true, force: true });
  }
}

module.exports = { loadEnvFile, norm, squash, localTime, inWindows, readJson, writeJson, stamp, pruneDir };
