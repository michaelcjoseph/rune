import { describe, expect, it } from 'vitest';

import {
  assertUnambiguousValidationTags,
  planValidationProfiles,
  validateValidationCommandProfiles,
} from './validation-profiles.js';

const parse = (command: string) => ({ ok: true as const, argv: command.split(' ') });

describe('validation profile contracts', () => {
  it('rejects missing, duplicate, unknown-command, and unknown-profile assignments', () => {
    expect(() => validateValidationCommandProfiles(['npm test'], []))
      .toThrow(/missing assignment/i);
    expect(() => validateValidationCommandProfiles(['npm test'], [
      { command: 'npm test', profile: 'isolated' },
      { command: 'npm test', profile: 'loopback' },
    ])).toThrow(/duplicate assignment/i);
    expect(() => validateValidationCommandProfiles(['npm test'], [
      { command: 'npm run build', profile: 'isolated' },
    ])).toThrow(/unknown command/i);
    expect(() => validateValidationCommandProfiles(['npm test'], [
      { command: 'npm test', profile: 'internet' as never },
    ])).toThrow(/unknown profile/i);
  });

  it('expands strict Vitest tags in stable capability order', () => {
    const plan = planValidationProfiles({
      commands: ['npm run build', 'npm test'],
      commandProfiles: [
        { command: 'npm run build', profile: 'isolated' },
        { command: 'npm test', profile: 'isolated' },
      ],
      adapters: [{
        command: 'npm test',
        runner: 'vitest',
        profileSelection: 'strict-tags-v1',
      }],
      parseCommand: parse,
    });

    expect(plan.shards.map(({ command, profile }) => ({ command, profile }))).toEqual([
      { command: 'npm run build', profile: 'isolated' },
      { command: 'npm test', profile: 'isolated' },
      { command: 'npm test', profile: 'loopback' },
      { command: 'npm test', profile: 'sandbox-integration' },
    ]);
    expect(plan.shards.slice(1).every((shard) =>
      shard.argv.some((arg) => arg.startsWith('--tags-filter=')),
    )).toBe(true);
  });

  it('rejects ambiguous test tags and fingerprints plan drift', () => {
    expect(() => assertUnambiguousValidationTags([
      'validation-loopback',
      'validation-sandbox-integration',
    ])).toThrow(/conflicting capability tags/i);

    const make = (profile: 'isolated' | 'loopback') => planValidationProfiles({
      commands: ['npm test'],
      commandProfiles: [{ command: 'npm test', profile }],
      adapters: [],
      parseCommand: parse,
    });
    expect(make('isolated').definitionFingerprint)
      .not.toBe(make('loopback').definitionFingerprint);
  });
});
