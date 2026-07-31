import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  openSync,
  readSync,
} from 'node:fs';

export interface BoundedRegularFileOptions {
  maxBytes: number;
  minBytes?: number;
  nonBlocking?: boolean;
}

/**
 * Read a regular file without following its final symlink and without allowing
 * the file to grow beyond the caller's byte budget. Product-controlled
 * artifact parsers keep their schema and minimum-content policy local.
 */
export function readBoundedRegularFileNoFollow(
  path: string,
  options: BoundedRegularFileOptions,
): Buffer | undefined {
  if (
    !Number.isSafeInteger(options.maxBytes) ||
    options.maxBytes < 0 ||
    !Number.isSafeInteger(options.minBytes ?? 0) ||
    (options.minBytes ?? 0) < 0 ||
    (options.minBytes ?? 0) > options.maxBytes
  ) {
    return undefined;
  }
  let fd: number | undefined;
  try {
    const noFollow = fsConstants.O_NOFOLLOW ?? 0;
    const nonBlocking = options.nonBlocking ? fsConstants.O_NONBLOCK : 0;
    fd = openSync(path, fsConstants.O_RDONLY | noFollow | nonBlocking);
    const stats = fstatSync(fd);
    const minBytes = options.minBytes ?? 0;
    if (
      !stats.isFile() ||
      stats.size < minBytes ||
      stats.size > options.maxBytes
    ) {
      return undefined;
    }
    const buffer = Buffer.alloc(stats.size);
    let offset = 0;
    while (offset < buffer.length) {
      const read = readSync(fd, buffer, offset, buffer.length - offset, offset);
      if (read === 0) return undefined;
      offset += read;
    }
    const eofProbe = Buffer.alloc(1);
    if (readSync(fd, eofProbe, 0, 1, buffer.length) !== 0) return undefined;
    const after = fstatSync(fd);
    if (!after.isFile() || after.size !== stats.size) return undefined;
    return buffer;
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // Callers fail closed; cleanup failure must not expose the path.
      }
    }
  }
}
