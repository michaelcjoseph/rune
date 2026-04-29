import { describe, it, expect, vi, afterAll } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmpDir = join(tmpdir(), `jarvis-equipment-test-${Date.now()}`);
mkdirSync(join(tmpDir, 'health'), { recursive: true });

afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

vi.mock('../config.js', () => ({
  default: { VAULT_DIR: tmpDir },
}));

const { readEquipment } = await import('./equipment.js');

const EQUIPMENT_PATH = join(tmpDir, 'health/equipment.md');

function writeEquipmentFile(content: string) {
  writeFileSync(EQUIPMENT_PATH, content, 'utf8');
}

function removeEquipmentFile() {
  try {
    rmSync(EQUIPMENT_PATH);
  } catch {
    // file may not exist
  }
}

describe('vault/equipment', () => {
  describe('readEquipment — happy path', () => {
    it('returns trimmed content for both Home and Gym sections', () => {
      writeEquipmentFile(
        '## Home\n- Dumbbells\n- Pull-up bar\n\n## Gym\n- Barbell\n- Squat rack\n',
      );
      const result = readEquipment();
      expect(result.home).toBe('- Dumbbells\n- Pull-up bar');
      expect(result.gym).toBe('- Barbell\n- Squat rack');
    });
  });

  describe('readEquipment — missing file', () => {
    it('returns empty strings for both sections when file does not exist', () => {
      removeEquipmentFile();
      const result = readEquipment();
      expect(result.home).toBe('');
      expect(result.gym).toBe('');
    });
  });

  describe('readEquipment — malformed content', () => {
    it('returns empty strings when neither heading is present', () => {
      writeEquipmentFile('Just some text without headings\n- item\n');
      const result = readEquipment();
      expect(result.home).toBe('');
      expect(result.gym).toBe('');
    });

    it('returns content for the present heading and empty for the missing one', () => {
      writeEquipmentFile('## Home\n- Dumbbells\n');
      const result = readEquipment();
      expect(result.home).toBe('- Dumbbells');
      expect(result.gym).toBe('');
    });

    it('returns gym content and empty home when only Gym heading is present', () => {
      writeEquipmentFile('## Gym\n- Barbell\n');
      const result = readEquipment();
      expect(result.home).toBe('');
      expect(result.gym).toBe('- Barbell');
    });
  });

  describe('readEquipment — section ordering', () => {
    it('works when Gym appears before Home', () => {
      writeEquipmentFile(
        '## Gym\n- Barbell\n- Squat rack\n\n## Home\n- Dumbbells\n- Pull-up bar\n',
      );
      const result = readEquipment();
      expect(result.home).toBe('- Dumbbells\n- Pull-up bar');
      expect(result.gym).toBe('- Barbell\n- Squat rack');
    });
  });

  describe('readEquipment — trailing headings do not bleed', () => {
    it('does not include content from a ## heading after Gym section', () => {
      writeEquipmentFile(
        '## Home\n- Dumbbells\n\n## Gym\n- Barbell\n\n## Other\n- Should not appear\n',
      );
      expect(readEquipment().gym).toBe('- Barbell');
    });

    it('does not include content from a ## heading after Home section when Home comes last', () => {
      writeEquipmentFile(
        '## Gym\n- Barbell\n\n## Home\n- Dumbbells\n\n## Notes\n- Extra\n',
      );
      expect(readEquipment().home).toBe('- Dumbbells');
    });
  });

  describe('readEquipment — sub-headings do not terminate sections', () => {
    it('keeps a ### sub-heading inside Home as part of the home content', () => {
      writeEquipmentFile(
        '## Home\n- Dumbbells\n\n### Outdoor\n- Hill\n\n## Gym\n- Barbell\n',
      );
      const result = readEquipment();
      expect(result.home).toContain('### Outdoor');
      expect(result.home).toContain('- Hill');
      expect(result.gym).toBe('- Barbell');
    });
  });
});
