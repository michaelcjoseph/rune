/** Fixed-byte JSONL tail reader for model-facing diagnostic surfaces. */

import { closeSync, fstatSync, openSync, readSync } from 'node:fs';

export interface TextTail {
  text: string;
  sourceTruncated: boolean;
}

/** Read a fixed-byte text tail, dropping a partial leading line. */
export function readTextTail(filePath: string, maxBytes: number): TextTail | null {
  if (!Number.isInteger(maxBytes) || maxBytes < 1) return null;
  let fd: number | null = null;
  try {
    fd = openSync(filePath, 'r');
    const size = fstatSync(fd).size;
    const length = Math.min(size, maxBytes);
    const offset = Math.max(0, size - length);
    const buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, offset);
    let text = buffer.toString('utf8');
    const sourceTruncated = offset > 0;
    if (sourceTruncated) {
      const firstNewline = text.indexOf('\n');
      text = firstNewline === -1 ? '' : text.slice(firstNewline + 1);
    }
    return { text, sourceTruncated };
  } catch {
    return null;
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

export function readJsonlTail(filePath: string, maxBytes: number, maxRecords: number): unknown[] {
  if (!Number.isInteger(maxRecords) || maxRecords < 1) return [];
  const tail = readTextTail(filePath, maxBytes);
  if (!tail) return [];
  const records: unknown[] = [];
  for (const line of tail.text.split('\n')) {
    if (!line.trim()) continue;
    try { records.push(JSON.parse(line)); } catch { /* torn/malformed line */ }
  }
  return records.slice(-maxRecords);
}
