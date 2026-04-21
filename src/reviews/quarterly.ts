import { registerReviewHandler } from './orchestrator.js';
import { createInterviewHandler, toScannerDate } from './interview.js';
import type { InterviewReviewConfig } from './interview.js';
import type { ReviewSession } from './session.js';

/** Get the three month ranges for the quarter containing targetDate */
export function getQuarterMonths(targetDate: string): Array<{ first: string; last: string; label: string }> {
  const parts = targetDate.split('-').map(Number) as [number, number, number];
  const year = parts[0];
  const month = parts[1];
  const quarterStart = Math.floor((month - 1) / 3) * 3 + 1; // 1, 4, 7, or 10

  const months: Array<{ first: string; last: string; label: string }> = [];
  for (let m = quarterStart; m < quarterStart + 3; m++) {
    const first = new Date(year, m - 1, 1);
    const last = new Date(year, m, 0);
    const fmt = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const monthName = first.toLocaleDateString('en-US', { month: 'long' });
    months.push({ first: fmt(first), last: fmt(last), label: `Journal Scanner (${monthName})` });
  }
  return months;
}

export function getQuarterLabel(targetDate: string): string {
  const month = Number(targetDate.split('-')[1]);
  const q = Math.ceil(month / 3);
  const year = targetDate.split('-')[0];
  return `Q${q} ${year}`;
}

const quarterlyConfig: InterviewReviewConfig = {
  type: 'quarterly',
  outlineMarker: 'review outline:',
  skillPath: '.claude/skills/quarterly/SKILL.md',
  defaultInstructions: 'Conduct a quarterly review interview covering: this month\'s highlights, theme assessment with grade, patterns (family, energy, work, attention vs intentions, psychology), study, strategic decisions (start/stop/continue), and deep reflection. End by presenting a "Q[X] [Year] Review outline:" with key points for each section.',
  buildPromptHeader: (session: ReviewSession) => {
    const label = getQuarterLabel(session.targetDate);
    const months = getQuarterMonths(session.targetDate);
    return `You are conducting a quarterly review interview. This review covers ${label} (${months[0]!.first} to ${months[2]!.last}).`;
  },
  prepAgents: (session: ReviewSession) => {
    const months = getQuarterMonths(session.targetDate);
    return [
      ...months.map(m => ({
        agent: 'journal-scanner',
        prompt: `start_date: ${toScannerDate(m.first)}, end_date: ${toScannerDate(m.last)}, focus_areas: [family, projects, tags, emotions, study, health, reading, psychology, unresolved]`,
        label: m.label,
      })),
      { agent: 'system-scanner', prompt: 'systems: [health, study, career, investments, psychology, writing]', label: 'System Scanner Results' },
    ];
  },
  postAgents: 'psychology-only',
  psychologyScope: 'reassessment',
};

export const quarterlyHandler = createInterviewHandler(quarterlyConfig);

registerReviewHandler('quarterly', quarterlyHandler);
