import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('chat model selector', () => {
  it('offers GPT-5.6 Terra as the selected default and syncs to an active webview session', () => {
    const html = readFileSync(new URL('./index.html', import.meta.url), 'utf8');
    const app = readFileSync(new URL('./app.js', import.meta.url), 'utf8');

    expect(html).toMatch(/option value="gpt-5\.6-terra" selected>GPT-5\.6 Terra<\/option>/);
    expect(app).toContain('modelSelect.value = sessions.webview.model');
  });
});
