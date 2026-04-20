import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

function required(name: string): string {
  const val = process.env[name];
  if (!val) throw new Error(`Missing required env var: ${name}`);
  return val.startsWith('~/') ? join(homedir(), val.slice(2)) : val;
}

export const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const config = {
  TELEGRAM_BOT_TOKEN: required('TELEGRAM_BOT_TOKEN'),
  TELEGRAM_USER_ID: Number(required('TELEGRAM_USER_ID')),

  VAULT_DIR: required('VAULT_DIR'),

  READWISE_TOKEN: process.env['READWISE_TOKEN'] || '',

  WHOOP_CLIENT_ID: process.env['WHOOP_CLIENT_ID'] || '',
  WHOOP_CLIENT_SECRET: process.env['WHOOP_CLIENT_SECRET'] || '',

  JARVIS_HTTP_SECRET: process.env['JARVIS_HTTP_SECRET'] || '',

  LOGS_DIR: join(PROJECT_ROOT, 'logs'),

  get SESSIONS_FILE() {
    return join(this.LOGS_DIR, 'tg-sessions.json');
  },

  get KNOWLEDGE_DIR() {
    return join(this.VAULT_DIR, 'knowledge');
  },

  get INGESTION_QUEUE_FILE() {
    return join(this.LOGS_DIR, 'kb-ingestion-queue.json');
  },

  get REVIEW_SESSIONS_FILE() {
    return join(this.LOGS_DIR, 'review-sessions.json');
  },

  HTTP_PORT: 3847,
  HTTP_HOST: '127.0.0.1',

  CLAUDE_TIMEOUT_MS: 120_000,
  DEFAULT_CHAT_MODEL: 'haiku',
  CONVERSATION_MODEL: 'opus',
  ONESHOT_MODEL: 'sonnet',
  AGENT_MODEL: 'opus',
  TG_MAX_MESSAGE_LENGTH: 4096,
  TIMEZONE: 'America/Chicago',
} as const;

export default config;
