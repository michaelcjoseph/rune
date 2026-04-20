import { registerReviewHandler } from './orchestrator.js';
import { createInterviewHandler, toScannerDate, detectOutline } from './interview.js';
import type { InterviewReviewConfig } from './interview.js';
import type { ReviewSession } from './session.js';
import { detectWorldviewDrift, formatDriftFlags } from './worldview-drift.js';

// Re-export for tests and backward compatibility
export { detectOutline };

/** Get Saturday (start of review week) from Friday target date */
function getWeekSaturday(fridayDate: string): string {
  const parts = fridayDate.split('-').map(Number) as [number, number, number];
  const friday = new Date(parts[0], parts[1] - 1, parts[2]);
  const saturday = new Date(friday);
  saturday.setDate(friday.getDate() - 6);
  const year = saturday.getFullYear();
  const month = String(saturday.getMonth() + 1).padStart(2, '0');
  const day = String(saturday.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

const weeklyConfig: InterviewReviewConfig = {
  type: 'weekly',
  outlineMarker: 'week in review outline:',
  skillPath: '.claude/skills/weekly/SKILL.md',
  defaultInstructions: 'Conduct a weekly review interview covering: last week\'s goals, project updates, study, memories, reflection, health, and next week\'s priorities. End by presenting a "Week in Review outline:" with key points for each section.',
  buildPromptHeader: (session: ReviewSession) => {
    const saturday = getWeekSaturday(session.targetDate);
    return `You are conducting a weekly review interview. This review covers the week of ${saturday} to ${session.targetDate}.`;
  },
  prepAgents: (session: ReviewSession) => {
    const friday = session.targetDate;
    const saturday = getWeekSaturday(friday);
    return [
      { agent: 'journal-scanner', prompt: `start_date: ${toScannerDate(saturday)}, end_date: ${toScannerDate(friday)}, focus_areas: [family, projects, tags, emotions, study, health, ideas, playbook, psychology, reading, unresolved]`, label: 'Journal Scanner Results' },
      { agent: 'system-scanner', prompt: 'systems: [health, study, psychology]', label: 'System Scanner Results' },
    ];
  },
  extraPrepContext: (session: ReviewSession) => {
    const friday = session.targetDate;
    const saturday = getWeekSaturday(friday);
    const flags = detectWorldviewDrift(toScannerDate(saturday), toScannerDate(friday));
    return formatDriftFlags(flags);
  },
  postAgents: 'dynamic',
  psychologyScope: 'observation',
};

export const weeklyHandler = createInterviewHandler(weeklyConfig);

registerReviewHandler('weekly', weeklyHandler);
