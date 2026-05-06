#!/usr/bin/env node
/**
 * Extract Substack substack.sid from Chrome automatically.
 * Decrypts Chrome's cookie database directly without keychain dialog.
 * Run: node scripts/get-substack-cookie.mjs
 */
import { execSync } from 'child_process';
import crypto from 'crypto';
import { createRequire } from 'module';
import fs from 'fs';
import os from 'os';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');

const ENV_FILE = new URL('../.env', import.meta.url).pathname;

function getAesKey() {
  const rawKeyStr = execSync(
    'security find-generic-password -s "Chrome Safe Storage" -a "Chrome" -w',
    { timeout: 15000, encoding: 'utf8' }
  ).trim();
  return crypto.pbkdf2Sync(rawKeyStr, 'saltysalt', 1003, 16, 'sha1');
}

function decryptCookie(encryptedValue, aesKey) {
  const iv = Buffer.alloc(16, 0x20);
  const ciphertext = encryptedValue.slice(3);
  const decipher = crypto.createDecipheriv('aes-128-cbc', aesKey, iv);
  decipher.setAutoPadding(false);
  let plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  const pad = plain[plain.length - 1];
  if (pad <= 16) plain = plain.slice(0, plain.length - pad);
  if (plain.length >= 32) plain = plain.slice(32); // strip Chromium hash prefix
  return plain.toString('utf8').replace(/[\x00-\x1f]/g, '').trim();
}

async function main() {
  console.log('Extracting Substack session from Chrome...');

  const aesKey = getAesKey();

  const tmpDb = `/tmp/chrome-cookies-${Date.now()}.db`;
  fs.copyFileSync(`${os.homedir()}/Library/Application Support/Google/Chrome/Default/Cookies`, tmpDb);
  const db = new Database(tmpDb, { readonly: true });

  const rows = db.prepare(`
    SELECT name, encrypted_value FROM cookies
    WHERE host_key LIKE '%substack%' AND name='substack.sid' LIMIT 1
  `).all();
  db.close();
  fs.unlinkSync(tmpDb);

  if (!rows.length) {
    console.error('No substack.sid found. Make sure you are logged into Substack in Chrome.');
    process.exit(1);
  }

  const value = decryptCookie(Buffer.from(rows[0].encrypted_value), aesKey);
  console.log('Found substack.sid:', value.substring(0, 30) + '...');

  let env = '';
  try { env = fs.readFileSync(ENV_FILE, 'utf8'); } catch {}
  if (env.includes('SUBSTACK_SID=')) {
    env = env.replace(/SUBSTACK_SID=.*/m, `SUBSTACK_SID=${value}`);
  } else {
    env += `\nSUBSTACK_SID=${value}\n`;
  }
  fs.writeFileSync(ENV_FILE, env);
  console.log('Saved to .env as SUBSTACK_SID');

  return value;
}

main().catch(e => { console.error('Error:', e.message); process.exit(1); });
