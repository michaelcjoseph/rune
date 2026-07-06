/**
 * Tests for src/mcp/tools/log-meal.ts — the pure handler with fake deps,
 * plus the exported insertMealLine insertion logic.
 *
 * Config-free on purpose: imports the pure handler module only, never
 * ./log-meal-deps.ts (which pulls src/config.ts at import).
 */

import { describe, it, expect, vi } from 'vitest';

import { logMeal, insertMealLine, type LogMealDeps } from './log-meal.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeDeps(overrides?: Partial<LogMealDeps>): LogMealDeps {
  return {
    appendMealNote: vi.fn().mockResolvedValue('appended'),
    getTodayDate: vi.fn().mockReturnValue('2026-07-06'),
    nowTimeString: vi.fn().mockReturnValue('12:30pm'),
    commitAndPush: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

describe('logMeal — handler', () => {
  it('formats the line in the daily-content-updater format and commits', async () => {
    const deps = makeDeps();

    const result = await logMeal(
      {
        description: 'chicken salad, olive oil',
        meal: 'Lunch',
        time: '1:15pm',
        date: '2026-07-05',
      },
      deps,
    );

    expect(deps.appendMealNote).toHaveBeenCalledExactlyOnceWith(
      '2026-07-05',
      '**Lunch (1:15pm):** chicken salad, olive oil',
    );
    expect(deps.commitAndPush).toHaveBeenCalledExactlyOnceWith('log_meal: 2026-07-05 Lunch');
    expect(result.isError).toBeFalsy();
    expect(result.content[0]!.text).toContain('**Lunch (1:15pm):** chicken salad, olive oil');
    expect(result.content[0]!.text).toContain('2026-07-05');
  });

  it('applies defaults: meal → "Meal", time → nowTimeString(), date → getTodayDate()', async () => {
    const deps = makeDeps();

    const result = await logMeal({ description: 'eggs and toast' }, deps);

    expect(deps.appendMealNote).toHaveBeenCalledExactlyOnceWith(
      '2026-07-06',
      '**Meal (12:30pm):** eggs and toast',
    );
    expect(result.isError).toBeFalsy();
  });

  it('collapses embedded newlines in description and meal', async () => {
    const deps = makeDeps();

    await logMeal({ description: 'eggs\nand toast', meal: 'Break\nfast' }, deps);

    expect(deps.appendMealNote).toHaveBeenCalledWith(
      '2026-07-06',
      '**Break fast (12:30pm):** eggs and toast',
    );
  });

  it('caps an over-long meal label at 40 characters', async () => {
    const deps = makeDeps();

    await logMeal({ description: 'big bowl of rice', meal: 'X'.repeat(50) }, deps);

    expect(deps.appendMealNote).toHaveBeenCalledWith(
      '2026-07-06',
      `**${'X'.repeat(40)} (12:30pm):** big bowl of rice`,
    );
  });

  it('rejects a description shorter than 3 chars after trim — no write, no commit', async () => {
    const deps = makeDeps();

    const result = await logMeal({ description: '  ab  ' }, deps);

    expect(result.isError).toBe(true);
    expect(deps.appendMealNote).not.toHaveBeenCalled();
    expect(deps.commitAndPush).not.toHaveBeenCalled();
  });

  it('rejects a malformed date, naming the YYYY-MM-DD format — no write, no commit', async () => {
    const deps = makeDeps();

    const result = await logMeal({ description: 'eggs and toast', date: '07/06/2026' }, deps);

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('YYYY-MM-DD');
    expect(deps.appendMealNote).not.toHaveBeenCalled();
    expect(deps.commitAndPush).not.toHaveBeenCalled();
  });

  it("duplicate → ok('Already logged…') and NO commit", async () => {
    const deps = makeDeps({
      appendMealNote: vi.fn().mockResolvedValue('duplicate'),
    });

    const result = await logMeal({ description: 'eggs and toast' }, deps);

    expect(result.isError).toBeFalsy();
    expect(result.content[0]!.text).toMatch(/already logged/i);
    expect(deps.commitAndPush).not.toHaveBeenCalled();
  });

  it('commit failure → isError saying the write is saved locally but not committed', async () => {
    const deps = makeDeps({
      commitAndPush: vi.fn().mockRejectedValue(new Error('push failed')),
    });

    const result = await logMeal({ description: 'eggs and toast' }, deps);

    expect(result.isError).toBe(true);
    expect(deps.appendMealNote).toHaveBeenCalledOnce();
    expect(result.content[0]!.text).toMatch(/saved locally.*git commit\/push failed.*not committed yet/);
    expect(result.content[0]!.text).toContain('push failed');
  });

  it('appendMealNote rejection → resolves to a sanitized isError result (never throws)', async () => {
    const deps = makeDeps({
      appendMealNote: vi.fn().mockRejectedValue(new Error('boom at /abs/vault/path')),
      sanitizeError: (msg: string) => msg.replace('/abs/vault/path', '<scrubbed>'),
    });

    const result = await logMeal({ description: 'eggs and toast' }, deps);

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('<scrubbed>');
    expect(result.content[0]!.text).not.toContain('/abs/vault/path');
    expect(deps.commitAndPush).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Insertion logic
// ---------------------------------------------------------------------------

describe('insertMealLine — nutrition.md insertion logic', () => {
  const LINE = '**Lunch (1:00pm):** salad';

  it('missing file → scaffolds a doc with the ## Meal Notes heading and the entry', () => {
    const { content, outcome } = insertMealLine(null, '2026-07-06', LINE);

    expect(outcome).toBe('appended');
    const headingAt = content.indexOf('## Meal Notes');
    const dateAt = content.indexOf('### 2026-07-06');
    const lineAt = content.indexOf(LINE);
    expect(headingAt).toBeGreaterThanOrEqual(0);
    expect(dateAt).toBeGreaterThan(headingAt);
    expect(lineAt).toBeGreaterThan(dateAt);
    expect(content.endsWith('\n')).toBe(true);
  });

  it('new date → heading + line inserted at the TOP of the dated list (newest-first)', () => {
    const current = [
      '# Nutrition',
      '',
      '## Meal Notes',
      '',
      '### 2026-07-04',
      '**Dinner (7:00pm):** pasta',
      '',
    ].join('\n');

    const { content, outcome } = insertMealLine(current, '2026-07-06', LINE);

    expect(outcome).toBe('appended');
    const newDateAt = content.indexOf('### 2026-07-06');
    const oldDateAt = content.indexOf('### 2026-07-04');
    expect(newDateAt).toBeGreaterThanOrEqual(0);
    expect(newDateAt).toBeLessThan(oldDateAt);
    expect(content.indexOf(LINE)).toBeLessThan(oldDateAt);
    // Existing content preserved
    expect(content).toContain('**Dinner (7:00pm):** pasta');
  });

  it('existing date heading → line appended at the end of that date’s block, no second heading', () => {
    const current = [
      '## Meal Notes',
      '',
      '### 2026-07-06',
      '**Breakfast (8:00am):** eggs',
      '',
      '### 2026-07-05',
      '**Dinner (7:00pm):** pasta',
      '',
    ].join('\n');

    const { content, outcome } = insertMealLine(current, '2026-07-06', LINE);

    expect(outcome).toBe('appended');
    expect(content.match(/### 2026-07-06/g)).toHaveLength(1);
    const breakfastAt = content.indexOf('**Breakfast (8:00am):** eggs');
    const lunchAt = content.indexOf(LINE);
    const olderAt = content.indexOf('### 2026-07-05');
    expect(lunchAt).toBeGreaterThan(breakfastAt);
    expect(lunchAt).toBeLessThan(olderAt);
  });

  it('exact same line already under that date → duplicate, content unchanged', () => {
    const current = ['## Meal Notes', '', '### 2026-07-06', LINE, ''].join('\n');

    const { content, outcome } = insertMealLine(current, '2026-07-06', LINE);

    expect(outcome).toBe('duplicate');
    expect(content).toBe(current);
  });

  it('same line under a DIFFERENT date is not a duplicate', () => {
    const current = ['## Meal Notes', '', '### 2026-07-05', LINE, ''].join('\n');

    const { outcome } = insertMealLine(current, '2026-07-06', LINE);

    expect(outcome).toBe('appended');
  });

  it('existing file without a ## Meal Notes section → section created, entry appended', () => {
    const current = '# Nutrition\n\nSome preamble prose.\n';

    const { content, outcome } = insertMealLine(current, '2026-07-06', LINE);

    expect(outcome).toBe('appended');
    expect(content).toContain('Some preamble prose.');
    const headingAt = content.indexOf('## Meal Notes');
    expect(headingAt).toBeGreaterThan(content.indexOf('Some preamble prose.'));
    expect(content.indexOf('### 2026-07-06')).toBeGreaterThan(headingAt);
    expect(content.indexOf(LINE)).toBeGreaterThan(headingAt);
  });

  it('entry stays inside the Meal Notes section when another ## section follows', () => {
    const current = ['## Meal Notes', '', '## Recipes', 'Chili con carne.'].join('\n');

    const { content, outcome } = insertMealLine(current, '2026-07-06', LINE);

    expect(outcome).toBe('appended');
    const dateAt = content.indexOf('### 2026-07-06');
    const recipesAt = content.indexOf('## Recipes');
    expect(dateAt).toBeGreaterThan(content.indexOf('## Meal Notes'));
    expect(dateAt).toBeLessThan(recipesAt);
    expect(content.indexOf(LINE)).toBeLessThan(recipesAt);
  });
});
