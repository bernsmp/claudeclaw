import fs from 'fs';
import path from 'path';

import { loadAgentConfig } from './agent-config.js';
import { createBot } from './bot.js';
import { ALLOWED_CHAT_ID, activeBotToken, STORE_DIR, PROJECT_ROOT, setAgentOverrides } from './config.js';
import { startDashboard } from './dashboard.js';
import { initDatabase, getDatabase } from './db.js';
import { LcmEngine } from './lcm/index.js';
import { logger } from './logger.js';
import { cleanupOldUploads } from './media.js';
import { runDecaySweep, setLcmEngine } from './memory.js';
import { initOrchestrator } from './orchestrator.js';
import { initScheduler } from './scheduler.js';
import { setTelegramConnected, setBotInfo } from './state.js';

// Parse --agent flag
const agentFlagIndex = process.argv.indexOf('--agent');
const AGENT_ID = agentFlagIndex !== -1 ? process.argv[agentFlagIndex + 1] : 'main';

if (AGENT_ID !== 'main') {
  const agentConfig = loadAgentConfig(AGENT_ID);
  const agentDir = path.join(PROJECT_ROOT, 'agents', AGENT_ID);
  const claudeMdPath = path.join(agentDir, 'CLAUDE.md');
  let systemPrompt: string | undefined;
  try {
    systemPrompt = fs.readFileSync(claudeMdPath, 'utf-8');
  } catch { /* no CLAUDE.md */ }
  setAgentOverrides({
    agentId: AGENT_ID,
    botToken: agentConfig.botToken,
    cwd: agentDir,
    model: agentConfig.model,
    obsidian: agentConfig.obsidian,
    systemPrompt,
  });
  logger.info({ agentId: AGENT_ID, name: agentConfig.name }, 'Running as agent');
}

const PID_FILE = path.join(STORE_DIR, `${AGENT_ID === 'main' ? 'claudeclaw' : `agent-${AGENT_ID}`}.pid`);

function showBanner(): void {
  const bannerPath = path.join(PROJECT_ROOT, 'banner.txt');
  try {
    const banner = fs.readFileSync(bannerPath, 'utf-8');
    console.log('\n' + banner);
  } catch {
    console.log('\n  ClaudeClaw\n');
  }
}

function acquireLock(): void {
  fs.mkdirSync(STORE_DIR, { recursive: true });
  try {
    if (fs.existsSync(PID_FILE)) {
      const old = parseInt(fs.readFileSync(PID_FILE, 'utf8').trim(), 10);
      if (!isNaN(old) && old !== process.pid) {
        try {
          process.kill(old, 'SIGTERM');
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000);
        } catch { /* already dead */ }
      }
    }
  } catch { /* ignore */ }
  fs.writeFileSync(PID_FILE, String(process.pid));
}

function releaseLock(): void {
  try { fs.unlinkSync(PID_FILE); } catch { /* ignore */ }
}

async function main(): Promise<void> {
  if (AGENT_ID === 'main') {
    showBanner();
  }

  if (!activeBotToken) {
    logger.error('Bot token is not set. Add TELEGRAM_BOT_TOKEN (or agent token) to .env and restart.');
    process.exit(1);
  }

  acquireLock();

  initDatabase();
  logger.info('Database ready');

  // Initialize LCM (Lossless Context Management) — DAG-based conversation memory
  // Alert sender is deferred because bot isn't created yet
  let sendAlert: ((msg: string) => void) | null = null;
  try {
    const lcm = new LcmEngine(getDatabase(), {
      onCreditAlert: (error) => {
        const alertMsg = `🚨 LCM summarization failed — ${error.type}\n\n${error.message}\n\nAdd credits to your Anthropic API key to restore lossless memory.`;
        logger.error({ error }, 'LCM credit alert');
        sendAlert?.(alertMsg);
      },
    });
    setLcmEngine(lcm);
    const stats = lcm.getStats();
    logger.info(
      { messages: stats.messages, summaries: stats.summaries, maxDepth: stats.maxDepth },
      'LCM engine ready',
    );
  } catch (err) {
    logger.error({ err }, 'LCM initialization failed — continuing without lossless memory');
  }

  initOrchestrator();
  logger.info('Orchestrator ready');

  runDecaySweep();
  setInterval(() => runDecaySweep(), 24 * 60 * 60 * 1000);

  cleanupOldUploads();

  const bot = createBot();

  // Wire up LCM credit alert sender now that bot exists
  if (ALLOWED_CHAT_ID) {
    sendAlert = (msg: string) => {
      bot.api.sendMessage(ALLOWED_CHAT_ID, msg).catch((err: unknown) =>
        logger.error({ err }, 'Failed to send LCM credit alert'),
      );
    };
  }

  // Dashboard only runs in the main bot process
  if (AGENT_ID === 'main') {
    startDashboard(bot.api);
  }

  if (ALLOWED_CHAT_ID) {
    initScheduler(
      (text) => bot.api.sendMessage(ALLOWED_CHAT_ID, text, { parse_mode: 'HTML' }).then(() => {}).catch((err) => logger.error({ err }, 'Scheduler failed to send message')),
      AGENT_ID,
    );
  } else {
    logger.warn('ALLOWED_CHAT_ID not set — scheduler disabled (no destination for results)');
  }

  const shutdown = async () => {
    logger.info('Shutting down...');
    setTelegramConnected(false);
    releaseLock();
    await bot.stop();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());

  logger.info({ agentId: AGENT_ID }, 'Starting ClaudeClaw...');

  await bot.start({
    onStart: (botInfo) => {
      setTelegramConnected(true);
      setBotInfo(botInfo.username ?? '', botInfo.first_name ?? 'ClaudeClaw');
      logger.info({ username: botInfo.username }, 'ClaudeClaw is running');
      if (AGENT_ID === 'main') {
        console.log(`\n  ClaudeClaw online: @${botInfo.username}`);
        console.log(`  Send /chatid to get your chat ID for ALLOWED_CHAT_ID\n`);
      } else {
        console.log(`\n  ClaudeClaw agent [${AGENT_ID}] online: @${botInfo.username}\n`);
      }
    },
  });
}

main().catch((err: unknown) => {
  logger.error({ err }, 'Fatal error');
  releaseLock();
  process.exit(1);
});
