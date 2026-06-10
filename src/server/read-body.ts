/**
 * Shared bounded request-body reader for the daemon HTTP server. One
 * implementation so the overflow behavior (destroy the socket, typed error)
 * can't silently diverge between routes — it previously existed as three
 * drifting copies in webview.ts / mcp-transport.ts / mcp-oauth.ts.
 */

import type { IncomingMessage } from 'node:http';

export const DEFAULT_MAX_BODY_BYTES = 1 * 1024 * 1024; // 1 MB

export class BodyTooLargeError extends Error {
  constructor() {
    super('request body too large');
  }
}

/** Read the full request body as utf8, rejecting with BodyTooLargeError
 *  (and destroying the socket) past `maxBytes`. */
export function readBody(req: IncomingMessage, maxBytes = DEFAULT_MAX_BODY_BYTES): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) {
        reject(new BodyTooLargeError());
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
