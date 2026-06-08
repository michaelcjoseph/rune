/**
 * Bounded per-task context assembly (project 14, Phase 3).
 *
 * Each task runs in a FRESH execution context. `assembleTaskContext` builds the
 * bounded handoff a task receives — the selected task, the project `context.md`,
 * and the spec — and deliberately NEVER splices in a prior task's transcript or
 * accumulated conversation, even when one is offered. That non-accumulation is
 * the whole point: task N+1 inherits distilled context, not N's chat history.
 *
 * Pure — no I/O.
 */

/** Default handoff char budget — bounds what one task's fresh context carries. */
export const TASK_HANDOFF_MAX_CHARS = 24000;

export interface AssembleTaskContextInput {
  /** The selected task (only its text/section are woven in). */
  task: { id: string; text: string; section?: string };
  /** The project `context.md` content — the cross-task continuity. */
  contextMd: string;
  /** The project spec (or the slice relevant to this task). */
  spec?: string;
  /** A prior task's transcript — accepted but DELIBERATELY IGNORED, so a caller
   *  can't accidentally accumulate conversation across tasks. */
  priorTranscript?: string;
  /** Override the handoff budget. */
  budget?: number;
}

export interface AssembledContext {
  /** The bounded handoff text for the task's fresh context. */
  handoff: string;
  /** The budget the handoff was bounded to. */
  budget: number;
}

/**
 * Assemble the bounded handoff. The task + context come first so they survive
 * truncation; the spec trails and is what gets cut when the budget binds. The
 * prior transcript is never included.
 */
export function assembleTaskContext(input: AssembleTaskContextInput): AssembledContext {
  const budget = input.budget ?? TASK_HANDOFF_MAX_CHARS;

  const parts = [
    `## Selected task\n\n${input.task.text}`,
    input.task.section ? `(section: ${input.task.section})` : '',
    `## Project context\n\n${input.contextMd}`,
    input.spec ? `## Spec\n\n${input.spec}` : '',
  ].filter((p) => p.length > 0);

  const assembled = parts.join('\n\n');
  let handoff = assembled;
  if (assembled.length > budget) {
    // Truncate at the last line boundary within budget so a `## ` header or a
    // sentence is never cut mid-token. Falls back to a hard slice only when the
    // first line alone already exceeds the budget.
    const cut = assembled.lastIndexOf('\n', budget);
    handoff = assembled.slice(0, cut > 0 ? cut : budget);
  }

  return { handoff, budget };
}
