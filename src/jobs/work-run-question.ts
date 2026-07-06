import type { StreamJsonEnvelope } from './work-run-transcript.js';

export interface WorkRunQuestionOption {
  id: string;
  label: string;
  value: string;
  description?: string;
}

export interface WorkRunParkedQuestion {
  source: 'ask-user-question';
  question: string;
  options: WorkRunQuestionOption[];
  toolUseId?: string;
  askedAt: string;
}

export interface ParsedAskUserQuestion {
  question: string;
  options: WorkRunQuestionOption[];
  toolUseId?: string;
  malformed?: boolean;
}

const MALFORMED_QUESTION =
  'AskUserQuestion payload could not be parsed; inspect the run transcript.';

function stringField(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

function optionFromUnknown(value: unknown, index: number): WorkRunQuestionOption | null {
  if (typeof value === 'string') {
    const text = value.trim();
    return text ? { id: String(index), label: text, value: text } : null;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const obj = value as Record<string, unknown>;
  const label = stringField(obj['label']) ?? stringField(obj['title']) ?? stringField(obj['text']) ?? stringField(obj['value']);
  const rawValue = stringField(obj['value']) ?? label;
  if (!label || !rawValue) return null;
  const option: WorkRunQuestionOption = { id: String(index), label, value: rawValue };
  const description = stringField(obj['description']);
  if (description) option.description = description;
  return option;
}

function normalizeOptions(input: Record<string, unknown>): WorkRunQuestionOption[] {
  const raw = input['options'] ?? input['choices'] ?? input['answers'];
  if (!Array.isArray(raw)) return [];
  const options: WorkRunQuestionOption[] = [];
  for (const item of raw) {
    const option = optionFromUnknown(item, options.length);
    if (option) options.push(option);
  }
  return options;
}

function fallback(toolUseId?: string): ParsedAskUserQuestion {
  return {
    question: MALFORMED_QUESTION,
    options: [{ id: '0', label: 'Inspect transcript', value: 'inspect-transcript' }],
    ...(toolUseId ? { toolUseId } : {}),
    malformed: true,
  };
}

export function parseAskUserQuestionToolUse(block: unknown): ParsedAskUserQuestion | null {
  if (!block || typeof block !== 'object' || Array.isArray(block)) return null;
  const obj = block as Record<string, unknown>;
  if (obj['type'] !== 'tool_use' || obj['name'] !== 'AskUserQuestion') return null;
  const toolUseId = stringField(obj['id']) ?? stringField(obj['tool_use_id']) ?? undefined;
  const input = obj['input'];
  if (!input || typeof input !== 'object' || Array.isArray(input)) return fallback(toolUseId);
  const inputObj = input as Record<string, unknown>;
  const question = stringField(inputObj['question']) ?? stringField(inputObj['prompt']);
  const options = normalizeOptions(inputObj);
  if (!question || options.length === 0) return fallback(toolUseId);
  return {
    question,
    options,
    ...(toolUseId ? { toolUseId } : {}),
  };
}

export function parseAskUserQuestionEnvelope(envelope: StreamJsonEnvelope): ParsedAskUserQuestion | null {
  if (envelope.type !== 'assistant') return null;
  const message = envelope['message'];
  if (!message || typeof message !== 'object') return null;
  const content = (message as Record<string, unknown>)['content'];
  if (!Array.isArray(content)) return null;
  let malformed: ParsedAskUserQuestion | null = null;
  for (const block of content) {
    const parsed = parseAskUserQuestionToolUse(block);
    if (!parsed) continue;
    if (!parsed.malformed) return parsed;
    malformed = parsed;
  }
  return malformed;
}

export function pendingCheckForQuestion(question: ParsedAskUserQuestion): string {
  return question.malformed ? question.question : `Answer required: ${question.question}`;
}
