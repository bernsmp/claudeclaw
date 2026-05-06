#!/usr/bin/env node
/**
 * Post a note to Substack Notes.
 * Three-tier strategy:
 *   1. Direct API (fast, may hit Cloudflare)
 *   2. peekaboo browser automation (reliable)
 *   3. Save to Obsidian file (manual fallback)
 */
import { execSync, execFileSync } from 'child_process';
import crypto from 'crypto';
import { createRequire } from 'module';
import fs from 'fs';
import os from 'os';
import path from 'path';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');

const ENV_FILE = new URL('../.env', import.meta.url).pathname;

// Signal>Noise is the primary Substack publication
const SIGNAL_NOISE_PUB_ID = 3426942;

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
let noteText = '';
if (args[0] === '--file') {
  noteText = fs.readFileSync(args[1], 'utf8').trim();
} else {
  noteText = args.filter((arg) => arg !== '--dry-run').join(' ').trim();
}
if (!noteText) { console.error('Usage: node post-substack-note.mjs [--dry-run] "text"'); process.exit(1); }

// === SAFEGUARD: Pre-flight validation ===
// Reject suspiciously short text that looks truncated
const MIN_NOTE_LENGTH = 50;
if (noteText.length < MIN_NOTE_LENGTH) {
  console.error(`SAFEGUARD: Note text is only ${noteText.length} chars (min ${MIN_NOTE_LENGTH}). Looks truncated. Aborting.`);
  process.exit(1);
}
// Warn if text appears cut off mid-word or mid-sentence
const lastChar = noteText[noteText.length - 1];
if (lastChar && !'.!?"\')\n '.includes(lastChar)) {
  console.error(`SAFEGUARD: Note text ends with "${noteText.slice(-30)}" — appears cut off mid-word. Aborting.`);
  process.exit(1);
}

function loadEnv() {
  try { return Object.fromEntries(fs.readFileSync(ENV_FILE, 'utf8').split('\n').filter(l=>l.includes('=')).map(l=>[l.split('=')[0], l.split('=').slice(1).join('=')])); }
  catch { return {}; }
}

function getAesKey() {
  const raw = execSync('security find-generic-password -s "Chrome Safe Storage" -a "Chrome" -w', { timeout: 15000, encoding: 'utf8' }).trim();
  return crypto.pbkdf2Sync(raw, 'saltysalt', 1003, 16, 'sha1');
}

function decryptCookie(encBuf, aesKey) {
  const iv = Buffer.alloc(16, 0x20);
  const ct = encBuf.slice(3);
  const d = crypto.createDecipheriv('aes-128-cbc', aesKey, iv);
  d.setAutoPadding(false);
  let p = Buffer.concat([d.update(ct), d.final()]);
  const pad = p[p.length-1];
  if (pad <= 16) p = p.slice(0, p.length-pad);
  if (p.length >= 32) p = p.slice(32);
  return p.toString('utf8').replace(/[\x00-\x1f]/g,'').trim();
}

async function getSubstackSid() {
  const env = loadEnv();
  const saved = process.env.SUBSTACK_SID || env['SUBSTACK_SID'];
  if (saved && saved.trim()) return saved.trim();
  const aesKey = getAesKey();
  const tmpDb = `/tmp/chrome-cookies-${Date.now()}.db`;
  fs.copyFileSync(`${os.homedir()}/Library/Application Support/Google/Chrome/Default/Cookies`, tmpDb);
  const db = new Database(tmpDb, { readonly: true });
  const row = db.prepare(`SELECT encrypted_value FROM cookies WHERE host_key LIKE '%substack%' AND name='substack.sid' LIMIT 1`).get();
  db.close(); fs.unlinkSync(tmpDb);
  if (!row) throw new Error('No substack.sid');
  return decryptCookie(Buffer.from(row.encrypted_value), aesKey);
}

// Convert text to ProseMirror doc with proper paragraph nodes
function textToProseMirror(text) {
  // Split on double newlines (paragraph breaks) or single newlines
  const paragraphs = text.split(/\n\n+/).map(p => p.trim()).filter(Boolean);
  const content = [];
  for (const para of paragraphs) {
    // Handle single newlines within a paragraph as separate lines
    const lines = para.split('\n');
    if (lines.length === 1) {
      content.push({ type: 'paragraph', content: [{ type: 'text', text: para }] });
    } else {
      // Multiple lines within one paragraph block — use hard breaks
      const inlineContent = [];
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].trim()) {
          inlineContent.push({ type: 'text', text: lines[i].trim() });
        }
        if (i < lines.length - 1) {
          inlineContent.push({ type: 'hardBreak' });
        }
      }
      content.push({ type: 'paragraph', content: inlineContent });
    }
  }
  return { type: 'doc', content };
}

function normalizeForComparison(text) {
  return (text || '')
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function collectTextFromProseMirror(node) {
  if (!node) return '';
  if (Array.isArray(node)) return node.map(collectTextFromProseMirror).join(' ');
  if (node.type === 'text' && typeof node.text === 'string') return node.text;
  if (node.type === 'hardBreak') return '\n';
  if (node.content) return collectTextFromProseMirror(node.content);
  return '';
}

// Tier 1: Direct API
async function tryDirectApi(text, sid) {
  const bodyJson = textToProseMirror(text);
  const res = await fetch('https://substack.com/api/v1/comment/feed', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Cookie': `substack.sid=${sid}`,
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36'
    },
    body: JSON.stringify({
      bodyJson,
      audience: 'everyone',
      surface: 'note',
      publication_id: SIGNAL_NOISE_PUB_ID
    })
  });
  if (res.status !== 200) return null;
  const data = await res.json();
  if (!data.id) return null;

  // === SAFEGUARD: Read-back verification ===
  // Fetch the posted note and verify content wasn't truncated
  try {
    await new Promise(r => setTimeout(r, 2000)); // wait for Substack to persist
    const verifyRes = await fetch(`https://substack.com/api/v1/comment/${data.id}`, {
      headers: {
        'Cookie': `substack.sid=${sid}`,
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36'
      }
    });
    if (verifyRes.ok) {
      const posted = await verifyRes.json();
      const expectedText = normalizeForComparison(text);
      const postedText = normalizeForComparison(collectTextFromProseMirror(posted.bodyJson || ''));
      const expectedWords = expectedText.split(/\s+/).filter(Boolean).length;
      const postedWords = postedText.split(/\s+/).filter(Boolean).length;
      const firstExpectedChunk = expectedText.slice(0, 80);
      const lastExpectedChunk = expectedText.slice(-80);
      const headMatches = firstExpectedChunk && postedText.includes(firstExpectedChunk);
      const tailMatches = lastExpectedChunk && postedText.includes(lastExpectedChunk);
      if (postedWords < expectedWords * 0.9 || !headMatches || !tailMatches) {
        console.error(`SAFEGUARD FAILED: Posted note has ~${postedWords} words but expected ~${expectedWords}. Head match=${headMatches}, tail match=${tailMatches}.`);
        console.error(`Note ID ${data.id} may need manual deletion at https://substack.com/note/${data.id}`);
        return null;
      }
      console.log(`VERIFIED: Posted note has ~${postedWords} words (expected ~${expectedWords}). Head/tail intact.`);
    }
  } catch (e) {
    console.log('Read-back verification skipped:', e.message);
  }

  return `https://substack.com/note/${data.id}`;
}

// Tier 2: Playwright browser automation (uses Chrome's existing session)
async function tryBrowserAutomation(text) {
  let chromium;
  try {
    const pw = await import('playwright');
    chromium = pw.chromium;
  } catch {
    console.log('Playwright not available, skipping browser automation...');
    return null;
  }

  // Launch with Chrome's user data dir so we're already logged in.
  // Use a temp copy to avoid profile lock conflicts with running Chrome.
  const userDataDir = `${os.homedir()}/Library/Application Support/Google/Chrome`;
  const tmpProfile = `/tmp/pw-substack-${Date.now()}`;

  let context;
  try {
    context = await chromium.launchPersistentContext(tmpProfile, {
      headless: false,
      channel: 'chrome',
      args: ['--disable-blink-features=AutomationControlled'],
      viewport: { width: 1280, height: 900 },
      storageState: undefined, // we'll inject the cookie instead
    });

    // Inject substack.sid cookie from Chrome
    let sid;
    try {
      sid = await getSubstackSid();
    } catch {
      console.log('Could not get substack.sid for browser automation');
      await context.close();
      return null;
    }

    await context.addCookies([{
      name: 'substack.sid',
      value: sid,
      domain: '.substack.com',
      path: '/',
      httpOnly: true,
      secure: true,
      sameSite: 'None',
    }]);

    const page = await context.newPage();
    await page.goto('https://substack.com/notes', { waitUntil: 'domcontentloaded', timeout: 30000 });

    // Click "New post" button to open compose modal
    const newPostBtn = page.getByRole('button', { name: 'New post' });
    await newPostBtn.waitFor({ timeout: 10000 });
    await newPostBtn.click();

    // Wait for ProseMirror editor to appear
    const editor = page.locator('div.ProseMirror[contenteditable="true"]');
    await editor.waitFor({ timeout: 10000 });
    await editor.click();

    // Type text paragraph by paragraph (ProseMirror needs Enter for newlines)
    const paragraphs = text.split('\n');
    for (let i = 0; i < paragraphs.length; i++) {
      if (paragraphs[i].trim() === '') {
        // Empty line = just press Enter for spacing
        await page.keyboard.press('Enter');
      } else {
        await page.keyboard.type(paragraphs[i], { delay: 5 });
        if (i < paragraphs.length - 1) {
          await page.keyboard.press('Enter');
        }
      }
    }

    // === SAFEGUARD: Verify editor content before posting ===
    const editorText = await editor.innerText();
    const expectedWords = text.split(/\s+/).filter(Boolean).length;
    const editorWords = editorText.split(/\s+/).filter(Boolean).length;
    if (editorWords < expectedWords * 0.8) {
      console.error(`SAFEGUARD FAILED: Editor has ~${editorWords} words but expected ~${expectedWords}. Text didn't fully enter. Aborting.`);
      await context.close();
      try { fs.rmSync(tmpProfile, { recursive: true, force: true }); } catch {}
      return null;
    }
    console.log(`VERIFIED: Editor has ~${editorWords} words (expected ~${expectedWords}). Proceeding to post.`);

    // Wait for Post button to become enabled
    const postBtn = page.getByRole('button', { name: 'Post' }).last();
    await postBtn.waitFor({ timeout: 5000 });
    // Small delay to let Substack enable the button
    await page.waitForTimeout(1000);

    const isDisabled = await postBtn.isDisabled();
    if (isDisabled) {
      console.log('Post button still disabled after typing, aborting...');
      await context.close();
      return null;
    }

    await postBtn.click();

    // Wait for the post to complete (modal should close or URL changes)
    await page.waitForTimeout(3000);

    // Try to find our note URL from the page
    const noteUrl = page.url().includes('/note/') ? page.url() : null;

    await context.close();
    // Clean up temp profile
    try { fs.rmSync(tmpProfile, { recursive: true, force: true }); } catch {}

    return noteUrl || 'https://substack.com/notes (posted via browser)';
  } catch (e) {
    console.log('Browser automation error:', e.message);
    try { if (context) await context.close(); } catch {}
    try { fs.rmSync(tmpProfile, { recursive: true, force: true }); } catch {}
    return null;
  }
}

// Tier 3: Save to Obsidian
function saveToObsidian(text) {
  const date = new Date().toISOString().split('T')[0];
  const filePath = `${os.homedir()}/Desktop/mb-brain/4 - Content/_agent-deposits/substack-note-${date}.md`;
  const content = `---
date: ${date}
type: substack-note
status: ready-to-post
---

${text}
`;
  fs.writeFileSync(filePath, content);
  return filePath;
}

async function main() {
  console.log('Posting to Substack Notes...');
  if (DRY_RUN) {
    console.log('DRY RUN: publishing disabled, running validation only.');
    const bodyJson = textToProseMirror(noteText);
    const paragraphs = bodyJson.content?.length || 0;
    console.log(`VALIDATED: ${noteText.length} chars across ${paragraphs} paragraph node(s).`);
    return;
  }

  // Try Tier 1
  try {
    const sid = await getSubstackSid();
    const url = await tryDirectApi(noteText, sid);
    if (url) {
      console.log('POSTED via API:', url);
      return;
    }
    console.log('API blocked by Cloudflare, falling back...');
  } catch (e) {
    console.log('API error:', e.message, '— falling back...');
  }

  // Try Tier 2: Playwright browser automation
  try {
    const url = await tryBrowserAutomation(noteText);
    if (url) {
      console.log('POSTED via browser:', url);
      return;
    }
    console.log('Browser automation failed, falling back to Obsidian...');
  } catch (e) {
    console.log('Browser error:', e.message, '— falling back...');
  }

  // Tier 3 fallback: Save to Obsidian
  const savedPath = saveToObsidian(noteText);
  console.log('SAVED to Obsidian:', savedPath);
  console.log('Open Substack and paste from that file.');
}

main().catch(e => { console.error('Error:', e.message); process.exit(1); });
