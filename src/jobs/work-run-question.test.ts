import { describe, expect, it } from 'vitest';
import { parseAskUserQuestionEnvelope, parseAskUserQuestionToolUse } from './work-run-question.js';

describe('work-run AskUserQuestion parser', () => {
  it('parses string options from an assistant tool_use block', () => {
    const parsed = parseAskUserQuestionEnvelope({
      type: 'assistant',
      message: {
        content: [{
          type: 'tool_use',
          id: 'toolu_1',
          name: 'AskUserQuestion',
          input: { question: 'Which path?', options: ['Ship now', 'Add tests'] },
        }],
      },
    });

    expect(parsed).toEqual({
      question: 'Which path?',
      options: [
        { id: '0', label: 'Ship now', value: 'Ship now' },
        { id: '1', label: 'Add tests', value: 'Add tests' },
      ],
      toolUseId: 'toolu_1',
    });
  });

  it('parses object options from common choices/answers shapes', () => {
    expect(parseAskUserQuestionToolUse({
      type: 'tool_use',
      name: 'AskUserQuestion',
      input: {
        prompt: 'Pick a scope',
        choices: [
          { label: 'Small', value: 'small', description: 'Minimal patch' },
          { label: 'Full', value: 'full' },
        ],
      },
    })).toEqual({
      question: 'Pick a scope',
      options: [
        { id: '0', label: 'Small', value: 'small', description: 'Minimal patch' },
        { id: '1', label: 'Full', value: 'full' },
      ],
    });
  });

  it('returns a malformed fallback when the tool payload is unusable', () => {
    const parsed = parseAskUserQuestionToolUse({
      type: 'tool_use',
      id: 'toolu_bad',
      name: 'AskUserQuestion',
      input: { options: [] },
    });

    expect(parsed?.malformed).toBe(true);
    expect(parsed?.question).toMatch(/could not be parsed/i);
    expect(parsed?.options).toHaveLength(1);
    expect(parsed?.toolUseId).toBe('toolu_bad');
  });

  it('ignores other tool names', () => {
    expect(parseAskUserQuestionToolUse({
      type: 'tool_use',
      name: 'Bash',
      input: { question: 'Nope', options: ['A'] },
    })).toBeNull();
  });
});
