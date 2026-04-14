import config from '../../config.js';
import { createLogger } from '../../utils/logger.js';

const log = createLogger('readwise');

const READWISE_API_URL = 'https://readwise.io/api/v3/save/';
const TIMEOUT_MS = 10_000;

export async function saveToReadwise(url: string, title?: string): Promise<{ success: boolean; error?: string }> {
  if (!config.READWISE_TOKEN) {
    log.info('Readwise token not configured, skipping API save', { url });
    return { success: false, error: 'READWISE_TOKEN not set' };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const body: Record<string, string> = { url };
    if (title) body['title'] = title;

    const response = await fetch(READWISE_API_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Token ${config.READWISE_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      log.error('Readwise API error', { status: response.status, body: text });
      return { success: false, error: `HTTP ${response.status}` };
    }

    log.info('Saved to Readwise', { url, title });
    return { success: true };
  } catch (err) {
    log.error('Readwise API request failed', { url, error: (err as Error).message });
    return { success: false, error: (err as Error).message };
  } finally {
    clearTimeout(timeout);
  }
}
