#!/usr/bin/env node
/**
 * pm-poller.js — ClickUp + Wrike task poller for Max
 *
 * Polls both services for tasks assigned to Max, detects new assignments
 * and status changes, and sends Telegram notifications.
 *
 * Usage: node pm-poller.js
 * Designed to run as a one-shot script via launchd (handles scheduling externally).
 *
 * State: ~/.claude/pm-poll-state.json
 */

import https from 'https';
import fs from 'fs';
import path from 'path';
import os from 'os';

// ── Config ───────────────────────────────────────────────────────────────────

const BUTTERS_ENV_PATH = path.join(os.homedir(), 'Desktop/max-command-center/butters/.env');
const ILLUMINATED_ENV_PATH = path.join(os.homedir(), 'Desktop/mb-brain/1 - Clients/Illuminated/.env');
const STATE_PATH = path.join(os.homedir(), '.claude/pm-poll-state.json');

const TELEGRAM_CHAT_ID = '-5233991699'; // Butters alerts channel
const CLICKUP_USER_ID = '87404354';
const CLICKUP_WORKSPACE = '9010085295';
const WRIKE_USER_ID = 'KUAXLS56';

// ── .env parser ──────────────────────────────────────────────────────────────

function parseEnv(filePath) {
  const result = {};
  try {
    const lines = fs.readFileSync(filePath, 'utf8').split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx === -1) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      const val = trimmed.slice(eqIdx + 1).trim();
      if (key && !(key in result)) {
        // Only set first occurrence (handles duplicate CLICKUP_API_KEY lines)
        result[key] = val;
      }
    }
  } catch (err) {
    console.error(`[pm-poller] Failed to parse .env at ${filePath}: ${err.message}`);
  }
  return result;
}

// ── State management ─────────────────────────────────────────────────────────

function loadState() {
  try {
    if (fs.existsSync(STATE_PATH)) {
      return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
    }
  } catch (err) {
    console.error(`[pm-poller] Failed to load state: ${err.message}`);
  }
  return {
    clickup: { lastPoll: null, knownIds: {}, lastStatus: {} },
    wrike:   { lastPoll: null, knownIds: {}, lastStatus: {} },
  };
}

function saveState(state) {
  try {
    const dir = path.dirname(STATE_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
  } catch (err) {
    console.error(`[pm-poller] Failed to save state: ${err.message}`);
  }
}

// ── HTTP helper ───────────────────────────────────────────────────────────────

function httpGet(urlStr, headers = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);
    const options = {
      hostname: url.hostname,
      path: url.pathname + url.search,
      method: 'GET',
      headers: { 'Content-Type': 'application/json', ...headers },
    };
    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try {
            resolve(JSON.parse(body));
          } catch {
            resolve(body);
          }
        } else {
          reject(new Error(`HTTP ${res.statusCode}: ${body.slice(0, 200)}`));
        }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

function httpPost(urlStr, payload, headers = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);
    const body = JSON.stringify(payload);
    const options = {
      hostname: url.hostname,
      path: url.pathname + url.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        ...headers,
      },
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch { resolve(data); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ── D1 Task Creation ──────────────────────────────────────────────────────────

const CLICKUP_PRIORITY_MAP = { 1: 1, 2: 2, 3: 3, 4: 4 }; // urgent→1, high→2, normal→3, low→4
const WRIKE_PRIORITY_MAP   = { High: 1, Normal: 2, Low: 3 };

function toIsoDate(value) {
  if (!value) return null;
  try {
    // ClickUp timestamps are epoch ms as strings; Wrike dates are YYYY-MM-DD strings
    const ts = Number(value);
    const d = isNaN(ts) ? new Date(value) : new Date(ts);
    if (isNaN(d.getTime())) return null;
    return d.toISOString().slice(0, 10);
  } catch { return null; }
}

async function createD1Task(normalizedTask, mccBaseUrl, mccApiKey) {
  if (!mccBaseUrl || !mccApiKey) {
    console.warn('[PM-Poller] MCC_BASE_URL or MCC_API_KEY not set — skipping D1 task creation');
    return;
  }
  const url = `${mccBaseUrl}/api/tasks`;
  const payload = {
    title: normalizedTask.title,
    description: (normalizedTask.description || '').slice(0, 500),
    priority: normalizedTask.priority,
    due_date: normalizedTask.dueDate,
    status: 'todo',
    source: normalizedTask.source,
    source_id: String(normalizedTask.id),
    client_id: null,
  };
  try {
    const result = await httpPost(url, payload, {
      Authorization: `Bearer ${mccApiKey}`,
    });
    console.log(`[PM-Poller] Created D1 task for ${normalizedTask.source} ${normalizedTask.id}: ${normalizedTask.title}`);
    return result;
  } catch (err) {
    console.error(`[PM-Poller] D1 task creation failed for ${normalizedTask.source} ${normalizedTask.id}: ${err.message}`);
    // Non-fatal — Telegram notification already sent
  }
}

// ── Telegram ─────────────────────────────────────────────────────────────────

async function sendTelegram(token, text) {
  try {
    const result = await httpPost(
      `https://api.telegram.org/bot${token}/sendMessage`,
      { chat_id: TELEGRAM_CHAT_ID, text, parse_mode: 'HTML' }
    );
    if (!result.ok) {
      console.error(`[pm-poller] Telegram error: ${JSON.stringify(result)}`);
    }
    return result;
  } catch (err) {
    console.error(`[pm-poller] Telegram send failed: ${err.message}`);
  }
}

// ── ClickUp ──────────────────────────────────────────────────────────────────

function formatClickupDate(ts) {
  if (!ts) return 'No due date';
  try {
    return new Date(parseInt(ts)).toLocaleDateString('en-US', {
      month: 'short', day: 'numeric', year: 'numeric'
    });
  } catch { return 'No due date'; }
}

function formatClickupPriority(p) {
  if (!p) return 'None';
  const labels = { 1: 'Urgent', 2: 'High', 3: 'Normal', 4: 'Low' };
  return labels[p.id] || p.priority || 'None';
}

function buildClickupMessage(task, changeType) {
  const title = task.name || 'Untitled';
  const space = task.space?.name || '';
  const folder = task.folder?.name || '';
  const list = task.list?.name || '';
  const breadcrumb = [space, folder, list].filter(Boolean).join(' › ');
  const priority = formatClickupPriority(task.priority);
  const due = formatClickupDate(task.due_date);
  const creator = task.creator?.username || task.creator?.email || 'Unknown';
  const desc = (task.description || '').replace(/<[^>]+>/g, '').trim().slice(0, 200);
  const taskUrl = `https://app.clickup.com/t/${task.id}`;

  const header = changeType === 'new'
    ? '📋 <b>New ClickUp Task Assigned</b>'
    : `📋 <b>ClickUp Task Updated</b> (status: ${task.status?.status || 'unknown'})`;

  let msg = `${header}\n\n<b>${escapeHtml(title)}</b>`;
  if (breadcrumb) msg += `\n📁 ${escapeHtml(breadcrumb)}`;
  msg += `\n⚡ Priority: ${escapeHtml(priority)}`;
  msg += `\n📅 Due: ${escapeHtml(due)}`;
  if (changeType === 'new') msg += `\n👤 From: ${escapeHtml(creator)}`;
  if (desc) msg += `\n\n${escapeHtml(desc)}`;
  msg += `\n\n🔗 ${taskUrl}`;

  return msg;
}

async function pollClickUp(apiKey, state, token, mccBaseUrl, mccApiKey) {
  console.log('[pm-poller] Polling ClickUp...');
  const url = `https://api.clickup.com/api/v2/team/${CLICKUP_WORKSPACE}/task?assignees[]=${CLICKUP_USER_ID}&order_by=updated&reverse=true`;

  let tasks;
  try {
    const data = await httpGet(url, { Authorization: apiKey });
    tasks = data.tasks || [];
    console.log(`[pm-poller] ClickUp: ${tasks.length} tasks fetched`);
  } catch (err) {
    console.error(`[pm-poller] ClickUp fetch error: ${err.message}`);
    return state;
  }

  const notifications = [];

  for (const task of tasks) {
    const id = task.id;
    const currentStatus = task.status?.status || '';

    const isNew = !(id in state.knownIds);
    const statusChanged = !isNew && state.lastStatus[id] !== currentStatus;

    if (isNew) {
      console.log(`[pm-poller] ClickUp NEW task: ${id} — ${task.name}`);
      notifications.push({ task, changeType: 'new' });
    } else if (statusChanged) {
      console.log(`[pm-poller] ClickUp STATUS CHANGE on ${id}: ${state.lastStatus[id]} → ${currentStatus}`);
      notifications.push({ task, changeType: 'status' });
    }

    state.knownIds[id] = true;
    state.lastStatus[id] = currentStatus;
  }

  // Send notifications
  for (const { task, changeType } of notifications) {
    const msg = buildClickupMessage(task, changeType);
    await sendTelegram(token, msg);
    if (changeType === 'new') {
      await createD1Task({
        id: task.id,
        title: task.name || 'Untitled',
        description: (task.description || '').replace(/<[^>]+>/g, '').trim(),
        priority: CLICKUP_PRIORITY_MAP[task.priority?.id] || 3,
        dueDate: toIsoDate(task.due_date),
        source: 'clickup',
      }, mccBaseUrl, mccApiKey);
    }
  }

  state.lastPoll = new Date().toISOString();
  console.log(`[pm-poller] ClickUp done. ${notifications.length} notification(s) sent.`);
  return state;
}

// ── Wrike ─────────────────────────────────────────────────────────────────────

function formatWrikeDate(dateStr) {
  if (!dateStr) return 'No due date';
  try {
    return new Date(dateStr).toLocaleDateString('en-US', {
      month: 'short', day: 'numeric', year: 'numeric'
    });
  } catch { return 'No due date'; }
}

function buildWrikeMessage(task, changeType, folderPath) {
  const title = task.title || 'Untitled';
  const status = task.status || '';
  const due = formatWrikeDate(task.dates?.due);
  const desc = (task.description || '').replace(/<[^>]+>/g, '').trim().slice(0, 200);
  const permalink = task.permalink || '';

  const header = changeType === 'new'
    ? '📋 <b>New Wrike Task Assigned</b>'
    : `📋 <b>Wrike Task Updated</b>`;

  let msg = `${header}\n\n<b>${escapeHtml(title)}</b>`;
  if (folderPath) msg += `\n📁 ${escapeHtml(folderPath)}`;
  msg += `\n⚡ Status: ${escapeHtml(status)}`;
  msg += `\n📅 Due: ${escapeHtml(due)}`;
  if (desc) msg += `\n\n${escapeHtml(desc)}`;
  if (permalink) msg += `\n\n🔗 ${permalink}`;

  return msg;
}

async function pollWrike(apiKey, state, token, mccBaseUrl, mccApiKey) {
  console.log('[pm-poller] Polling Wrike...');
  const url = `https://www.wrike.com/api/v4/tasks?responsibles=[${WRIKE_USER_ID}]&sortField=UpdatedDate&sortOrder=Desc&limit=50&fields=[description,briefDescription,parentIds,responsibleIds]`;

  let tasks;
  try {
    const data = await httpGet(url, { Authorization: `bearer ${apiKey}` });
    tasks = data.data || [];
    console.log(`[pm-poller] Wrike: ${tasks.length} tasks fetched`);
  } catch (err) {
    console.error(`[pm-poller] Wrike fetch error: ${err.message}`);
    return state;
  }

  // Fetch folder names for context (best effort)
  const folderNames = {};
  const folderIds = [...new Set(tasks.flatMap(t => t.parentIds || []))];
  if (folderIds.length > 0) {
    try {
      const batchSize = 100;
      const batch = folderIds.slice(0, batchSize).join(',');
      const folderData = await httpGet(
        `https://www.wrike.com/api/v4/folders?ids=[${batch}]`,
        { Authorization: `bearer ${apiKey}` }
      );
      for (const folder of (folderData.data || [])) {
        folderNames[folder.id] = folder.title;
      }
    } catch (err) {
      console.warn(`[pm-poller] Wrike folder fetch failed (non-fatal): ${err.message}`);
    }
  }

  const notifications = [];

  for (const task of tasks) {
    const id = task.id;
    const currentStatus = task.status || '';

    const isNew = !(id in state.knownIds);
    const statusChanged = !isNew && state.lastStatus[id] !== currentStatus;

    if (isNew) {
      console.log(`[pm-poller] Wrike NEW task: ${id} — ${task.title}`);
      notifications.push({ task, changeType: 'new' });
    } else if (statusChanged) {
      console.log(`[pm-poller] Wrike STATUS CHANGE on ${id}: ${state.lastStatus[id]} → ${currentStatus}`);
      notifications.push({ task, changeType: 'status' });
    }

    state.knownIds[id] = true;
    state.lastStatus[id] = currentStatus;
  }

  // Send notifications
  for (const { task, changeType } of notifications) {
    const parentIds = task.parentIds || [];
    const folderPath = parentIds
      .map(id => folderNames[id])
      .filter(Boolean)
      .join(' › ');
    const msg = buildWrikeMessage(task, changeType, folderPath);
    await sendTelegram(token, msg);
    if (changeType === 'new') {
      await createD1Task({
        id: task.id,
        title: task.title || 'Untitled',
        description: (task.description || '').replace(/<[^>]+>/g, '').trim(),
        priority: WRIKE_PRIORITY_MAP[task.importance] || 2,
        dueDate: toIsoDate(task.dates?.due),
        source: 'wrike',
      }, mccBaseUrl, mccApiKey);
    }
  }

  state.lastPoll = new Date().toISOString();
  console.log(`[pm-poller] Wrike done. ${notifications.length} notification(s) sent.`);
  return state;
}

// ── HTML escaping ─────────────────────────────────────────────────────────────

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`[pm-poller] Starting poll at ${new Date().toISOString()}`);

  // Load env
  const buttersEnv = parseEnv(BUTTERS_ENV_PATH);
  const illuminatedEnv = parseEnv(ILLUMINATED_ENV_PATH);

  const TELEGRAM_TOKEN = buttersEnv.TELEGRAM_BOT_TOKEN;
  const CLICKUP_API_KEY = illuminatedEnv.CLICKUP_API_KEY;
  const WRIKE_API_KEY = illuminatedEnv.WRIKE_API_KEY;
  const MCC_API_KEY  = buttersEnv.MCC_API_KEY;
  const MCC_BASE_URL = buttersEnv.MCC_BASE_URL;

  if (!TELEGRAM_TOKEN) { console.error('[pm-poller] Missing TELEGRAM_BOT_TOKEN'); process.exit(1); }
  if (!CLICKUP_API_KEY) { console.error('[pm-poller] Missing CLICKUP_API_KEY'); process.exit(1); }
  if (!WRIKE_API_KEY) { console.error('[pm-poller] Missing WRIKE_API_KEY'); process.exit(1); }
  if (!MCC_API_KEY || !MCC_BASE_URL) {
    console.warn('[pm-poller] MCC_API_KEY or MCC_BASE_URL not set — D1 task creation will be skipped');
  }

  // Load state
  const fullState = loadState();
  let clickupState = fullState.clickup || { lastPoll: null, knownIds: {}, lastStatus: {} };
  let wrikeState   = fullState.wrike   || { lastPoll: null, knownIds: {}, lastStatus: {} };

  // Poll both services (independent — one failure won't block the other)
  const [newClickupState, newWrikeState] = await Promise.all([
    pollClickUp(CLICKUP_API_KEY, clickupState, TELEGRAM_TOKEN, MCC_BASE_URL, MCC_API_KEY).catch(err => {
      console.error(`[pm-poller] ClickUp poll crashed: ${err.message}`);
      return clickupState;
    }),
    pollWrike(WRIKE_API_KEY, wrikeState, TELEGRAM_TOKEN, MCC_BASE_URL, MCC_API_KEY).catch(err => {
      console.error(`[pm-poller] Wrike poll crashed: ${err.message}`);
      return wrikeState;
    }),
  ]);

  // Save state
  saveState({ clickup: newClickupState, wrike: newWrikeState });

  console.log(`[pm-poller] Poll complete at ${new Date().toISOString()}`);
}

main().catch(err => {
  console.error(`[pm-poller] Fatal error: ${err.message}`);
  process.exit(1);
});
