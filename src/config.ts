import { homedir } from 'node:os';
import { join } from 'node:path';

function required(name: string): string {
  const val = process.env[name];
  if (!val) throw new Error(`Missing required env var: ${name}`);
  return val;
}

const home = homedir();

const config = {
  TELEGRAM_BOT_TOKEN: required('TELEGRAM_BOT_TOKEN'),
  TELEGRAM_USER_ID: Number(required('TELEGRAM_USER_ID')),

  VAULT_DIR:
    process.env['VAULT_DIR'] ||
    join(home, 'Library/Mobile Documents/iCloud~md~obsidian/Documents/your-vault-name'),

  LOGS_DIR: process.env['LOGS_DIR'] || join(home, 'logs'),

  get SESSIONS_FILE() {
    return join(this.LOGS_DIR, 'tg-sessions.json');
  },

  get KNOWLEDGE_DIR() {
    return join(this.VAULT_DIR, 'knowledge');
  },

  get INGESTION_QUEUE_FILE() {
    return join(this.LOGS_DIR, 'kb-ingestion-queue.json');
  },

  HTTP_PORT: 3847,
  HTTP_HOST: '127.0.0.1',

  CLAUDE_TIMEOUT_MS: 120_000,
  TG_MAX_MESSAGE_LENGTH: 4096,
  TIMEZONE: 'America/Chicago',
} as const;

export default config;
