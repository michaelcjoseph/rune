import { describe, expect, it, vi } from 'vitest';

type RoleCallInput = { role: string; systemPrompt: string; message: string };

async function loadScoping(): Promise<any> {
  try {
    const mod = await import('./pm-techlead-bug-scoping.js');
    expect(mod.runPmTechLeadBugScoping, 'expected pm-techlead-bug-scoping.ts to export runPmTechLeadBugScoping').toBeTypeOf('function');
    return mod;
  } catch (err) {
    throw new Error(
      `pm-techlead-bug-scoping module missing or invalid: expected src/jobs/pm-techlead-bug-scoping.ts exporting runPmTechLeadBugScoping (${(err as Error).message})`,
    );
  }
}

function bug(overrides: Record<string, unknown> = {}) {
  return {
    id: 'bug-123',
    kind: 'bugs',
    text: 'Settings save button throws after selecting timezone',
    status: 'open',
    body: ['Repro: open Settings, choose UTC, click Save.', 'Expected: settings persist. Actual: toast shows 500.'],
    source: { file: 'docs/projects/bugs.md', lineNumber: 7, raw: '- [ ] Settings save button throws after selecting timezone' },
    warnings: [],
    ...overrides,
  };
}

describe('pm-techlead-bug-scoping - cockpit redesign Phase 3', () => {
  it('uses the real PM and Tech-Lead role seams over the bug title and body to produce BugScopingFacts', async () => {
    const { runPmTechLeadBugScoping } = await loadScoping();
    const calls: RoleCallInput[] = [];
    const modelCall = vi.fn(async (input: RoleCallInput) => {
      calls.push(input);
      if (input.role === 'pm') {
        return [
          '```pm-bug-scope',
          JSON.stringify({ wellScoped: true, reason: 'Bug has repro, expected behavior, and actual behavior.' }),
          '```',
        ].join('\n');
      }
      if (input.role === 'tech-lead') {
        return [
          '```tech-lead-bug-scope',
          JSON.stringify({ objection: null }),
          '```',
        ].join('\n');
      }
      return '';
    });

    const facts = await runPmTechLeadBugScoping({
      product: 'aura',
      bug: bug(),
      modelCall,
    });

    expect(facts).toMatchObject({
      itemEligible: true,
      fieldsComplete: true,
      pmAssessed: true,
      pmWellScoped: true,
      techLeadReviewed: true,
    });
    expect(facts.pmReason).toBeUndefined();
    expect(facts.techLeadObjection).toBeUndefined();
    expect(modelCall).toHaveBeenCalledTimes(2);
    expect(calls.map((c) => c.role)).toEqual(['pm', 'tech-lead']);
    expect(calls[0]!.systemPrompt.toLowerCase()).toContain('product manager');
    expect(calls[1]!.systemPrompt.toLowerCase()).toContain('tech lead');
    expect(calls[0]!.message).toContain('Settings save button throws');
    expect(calls[0]!.message).toContain('Repro: open Settings');
    expect(calls[1]!.message).toContain('Settings save button throws');
  });

  it('fails closed on an unparseable PM reply and never asks Tech-Lead to rubber-stamp it', async () => {
    const { runPmTechLeadBugScoping } = await loadScoping();
    const modelCall = vi.fn(async (input: RoleCallInput) => {
      if (input.role === 'pm') return 'looks fine to me';
      if (input.role === 'tech-lead') throw new Error('Tech-Lead should not be called after PM parse failure');
      return '';
    });

    const facts = await runPmTechLeadBugScoping({ product: 'aura', bug: bug(), modelCall });

    expect(facts).toMatchObject({
      itemEligible: true,
      fieldsComplete: true,
      pmAssessed: false,
      pmWellScoped: false,
      techLeadReviewed: false,
      pmReason: expect.stringMatching(/unparseable|parse/i),
    });
    expect(modelCall).toHaveBeenCalledTimes(1);
  });

  it('fails closed on an unparseable Tech-Lead reply with a gate-blocking objection detail', async () => {
    const { runPmTechLeadBugScoping } = await loadScoping();
    const modelCall = vi.fn(async (input: RoleCallInput) => {
      if (input.role === 'pm') {
        return [
          '```pm-bug-scope',
          JSON.stringify({ wellScoped: true, reason: 'Bug has enough detail.' }),
          '```',
        ].join('\n');
      }
      if (input.role === 'tech-lead') return 'ship it';
      return '';
    });

    const facts = await runPmTechLeadBugScoping({ product: 'aura', bug: bug(), modelCall });

    expect(facts).toMatchObject({
      itemEligible: true,
      fieldsComplete: true,
      pmAssessed: true,
      pmWellScoped: true,
      techLeadReviewed: false,
      techLeadObjection: expect.stringMatching(/unparseable|parse/i),
    });
    expect(modelCall).toHaveBeenCalledTimes(2);
  });

  it('preserves the PM not-well-scoped reason as the gate detail', async () => {
    const { runPmTechLeadBugScoping } = await loadScoping();
    const modelCall = vi.fn(async (input: RoleCallInput) => {
      if (input.role === 'pm') {
        return [
          '```pm-bug-scope',
          JSON.stringify({
            wellScoped: false,
            reason: 'The report names a broken screen but has no reproduction path or observed error.',
          }),
          '```',
        ].join('\n');
      }
      if (input.role === 'tech-lead') {
        return [
          '```tech-lead-bug-scope',
          JSON.stringify({ objection: null }),
          '```',
        ].join('\n');
      }
      return '';
    });

    const facts = await runPmTechLeadBugScoping({ product: 'aura', bug: bug(), modelCall });

    expect(facts).toMatchObject({
      itemEligible: true,
      fieldsComplete: true,
      pmAssessed: true,
      pmWellScoped: false,
      pmReason: 'The report names a broken screen but has no reproduction path or observed error.',
    });
  });

  it('preserves a Tech-Lead feasibility or scope objection as a gate-blocking fact', async () => {
    const { runPmTechLeadBugScoping } = await loadScoping();
    const modelCall = vi.fn(async (input: RoleCallInput) => {
      if (input.role === 'pm') {
        return [
          '```pm-bug-scope',
          JSON.stringify({ wellScoped: true, reason: 'Bug has repro, expected behavior, and actual behavior.' }),
          '```',
        ].join('\n');
      }
      if (input.role === 'tech-lead') {
        return [
          '```tech-lead-bug-scope',
          JSON.stringify({ objection: 'The fix likely spans auth and billing; split scope before one-click Fix.' }),
          '```',
        ].join('\n');
      }
      return '';
    });

    const facts = await runPmTechLeadBugScoping({ product: 'aura', bug: bug(), modelCall });

    expect(facts).toMatchObject({
      itemEligible: true,
      fieldsComplete: true,
      pmAssessed: true,
      pmWellScoped: true,
      techLeadReviewed: true,
      techLeadObjection: 'The fix likely spans auth and billing; split scope before one-click Fix.',
    });
  });

  it('marks non-open, promoted, or warning-bearing backlog items ineligible before a Fix gate can proceed', async () => {
    const { runPmTechLeadBugScoping } = await loadScoping();
    const modelCall = vi.fn(async () => {
      throw new Error('ineligible bugs should not need PM or Tech-Lead assessment');
    });

    await expect(
      runPmTechLeadBugScoping({
        product: 'aura',
        bug: bug({ status: 'done' }),
        modelCall,
      }),
    ).resolves.toMatchObject({ itemEligible: false });
    await expect(
      runPmTechLeadBugScoping({
        product: 'aura',
        bug: bug({ promotedTo: '17-cockpit-redesign' }),
        modelCall,
      }),
    ).resolves.toMatchObject({ itemEligible: false });
    await expect(
      runPmTechLeadBugScoping({
        product: 'aura',
        bug: bug({ warnings: ['bad-promotion-marker'] }),
        modelCall,
      }),
    ).resolves.toMatchObject({ itemEligible: false });
    expect(modelCall).not.toHaveBeenCalled();
  });

  it('marks a bug with no title or body detail incomplete without inventing role facts', async () => {
    const { runPmTechLeadBugScoping } = await loadScoping();
    const modelCall = vi.fn(async () => {
      throw new Error('incomplete bugs should not need PM or Tech-Lead assessment');
    });

    await expect(
      runPmTechLeadBugScoping({
        product: 'aura',
        bug: bug({ text: '', body: [] }),
        modelCall,
      }),
    ).resolves.toMatchObject({
      itemEligible: true,
      fieldsComplete: false,
      pmAssessed: false,
      pmWellScoped: false,
      techLeadReviewed: false,
    });
    expect(modelCall).not.toHaveBeenCalled();
  });
});
