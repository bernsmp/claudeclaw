#!/usr/bin/env node

import fs from 'fs';
import path from 'path';

const DEFAULT_BASE = 'https://max-command-center.max-command-center.workers.dev';

function readEnv(paths, keys) {
  for (const filePath of paths) {
    try {
      const content = fs.readFileSync(filePath, 'utf8');
      const result = {};
      for (const line of content.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eq = trimmed.indexOf('=');
        if (eq === -1) continue;
        const key = trimmed.slice(0, eq).trim();
        if (!keys.has(key)) continue;
        let value = trimmed.slice(eq + 1).trim();
        if (
          (value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))
        ) {
          value = value.slice(1, -1);
        }
        result[key] = value;
      }
      return result;
    } catch {
      // Try the next file.
    }
  }
  return {};
}

function parseArgs(argv) {
  const payload = {
    title: '',
    description: undefined,
    rationale: undefined,
    priority: undefined,
    client_id: undefined,
    project_id: undefined,
    due_date: undefined,
    labels: [],
    source: 'butters',
    source_id: undefined,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];

    switch (arg) {
      case '--title':
        payload.title = next || '';
        index += 1;
        break;
      case '--description':
        payload.description = next || undefined;
        index += 1;
        break;
      case '--why':
        payload.rationale = next || undefined;
        index += 1;
        break;
      case '--priority':
        payload.priority = next ? Number(next) : undefined;
        index += 1;
        break;
      case '--client':
        payload.client_id = next || undefined;
        index += 1;
        break;
      case '--project':
        payload.project_id = next || undefined;
        index += 1;
        break;
      case '--due':
        payload.due_date = next || undefined;
        index += 1;
        break;
      case '--label':
        if (next) payload.labels.push(next);
        index += 1;
        break;
      case '--source-id':
        payload.source_id = next || undefined;
        index += 1;
        break;
      default:
        break;
    }
  }

  return payload;
}

function usage() {
  console.error(
    'Usage: node scripts/suggest-tabby-task.mjs --title "..." [--why "..."] [--description "..."] [--priority 1|2|3] [--client client-slug] [--project ProjectName] [--due YYYY-MM-DD] [--label label] [--source-id id]'
  );
}

const payload = parseArgs(process.argv.slice(2));
if (!payload.title) {
  usage();
  process.exit(1);
}

const env = readEnv(
  [
    path.resolve(process.cwd(), '.env'),
    path.resolve(process.cwd(), '../.env.local'),
    path.resolve(process.cwd(), '../.dev.vars'),
  ],
  new Set(['MCC_API_KEY', 'MCC_BASE_URL'])
);

const apiKey = process.env.MCC_API_KEY || env.MCC_API_KEY;
const baseUrl = process.env.MCC_BASE_URL || env.MCC_BASE_URL || DEFAULT_BASE;

if (!apiKey) {
  console.error('Missing MCC_API_KEY in environment or local env files.');
  process.exit(1);
}

const response = await fetch(`${baseUrl}/api/butters/tabby-suggestions`, {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    'x-api-key': apiKey,
  },
  body: JSON.stringify(payload),
});

const text = await response.text();
if (!response.ok) {
  console.error(text);
  process.exit(1);
}

console.log(text);
