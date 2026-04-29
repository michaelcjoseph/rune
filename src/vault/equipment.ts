import { readVaultFile } from './files.js';

const EQUIPMENT_PATH = 'health/equipment.md';

/** Raw equipment inventory split by location. Missing file → both sections empty. */
export interface Equipment {
  home: string;
  gym: string;
}

/** Read `health/equipment.md` and return the raw block content under each
 *  `## Home` / `## Gym` heading. The agent consumes raw markdown, so we don't
 *  parse bullets — just hand back the section bodies. */
export function readEquipment(): Equipment {
  const content = readVaultFile(EQUIPMENT_PATH);
  if (content === null) return { home: '', gym: '' };
  return {
    home: extractSection(content, 'Home'),
    gym: extractSection(content, 'Gym'),
  };
}

function extractSection(content: string, heading: 'Home' | 'Gym'): string {
  const lines = content.split('\n');
  const headingPattern = new RegExp(`^##\\s+${heading}\\s*$`, 'i');
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (headingPattern.test(lines[i]!)) {
      start = i + 1;
      break;
    }
  }
  if (start === -1) return '';
  let end = lines.length;
  for (let i = start; i < lines.length; i++) {
    if (/^##\s/.test(lines[i]!)) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join('\n').trim();
}
