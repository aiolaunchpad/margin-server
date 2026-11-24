/** Minimal KEY=VALUE env-file loader (no dependency). Never logs values. */
import { readFileSync, existsSync } from 'node:fs';

export function parseEnvFile(text) {
  const out = {};
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[m[1]] = v;
  }
  return out;
}

/** Fill process.env from a file for keys that are not already set. */
export function loadEnvFile(file, env = process.env) {
  if (!file || !existsSync(file)) return false;
  const vars = parseEnvFile(readFileSync(file, 'utf8'));
  for (const [k, v] of Object.entries(vars)) if (env[k] === undefined || env[k] === '') env[k] = v;
  return true;
}
