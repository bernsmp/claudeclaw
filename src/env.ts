import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(moduleDir, '..');

function candidateEnvPaths(): string[] {
  const explicit = process.env.CLAUDECLAW_ENV;
  const cwdEnv = path.join(process.cwd(), '.env');
  const rootEnv = path.join(projectRoot, '.env');

  return [explicit, cwdEnv, rootEnv].filter(
    (value): value is string => typeof value === 'string' && value.length > 0,
  );
}

/**
 * Parse the .env file and return values for the requested keys.
 * Does NOT load anything into process.env — callers decide what to
 * do with the values. This keeps secrets out of the process environment
 * so they don't leak to child processes.
 */
export function readEnvFile(keys: string[]): Record<string, string> {
  let content = '';
  let found = false;
  for (const envFile of candidateEnvPaths()) {
    try {
      content = fs.readFileSync(envFile, 'utf-8');
      found = true;
      break;
    } catch {
      // Try the next candidate.
    }
  }
  if (!found) return {};

  const result: Record<string, string> = {};
  const wanted = new Set(keys);

  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    if (!wanted.has(key)) continue;
    let value = trimmed.slice(eqIdx + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (value) result[key] = value;
  }

  return result;
}
