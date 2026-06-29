/**
 * Project 19, W1 Phase 3: expanded MCP content functions.
 *
 * TEST-FIRST contract suite for:
 * - journal_range
 * - follow_wikilinks
 * - tag_date_query
 *
 * These tests exercise the real MCP server factory and the real warm vault
 * index against a fixture vault. They are expected to be red until the content
 * tools are registered and implemented.
 */

import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as serverModule from './server.js';
import { buildVaultIndex } from '../kb/vault-index.js';

type RuntimeMcpFactory = (opts: { tools: string[]; name?: string }) => McpServer;

const createRuneMcpServer = (serverModule as Record<string, unknown>)
  .createRuneMcpServer as RuntimeMcpFactory | undefined;

let fixtureVault: string | null = null;
let previousVaultDir: string | undefined;

async function connectClient(server: McpServer): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'content-functions-test-client', version: '1.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

function writeVaultFile(relPath: string, content: string): void {
  if (!fixtureVault) throw new Error('fixture vault not initialized');
  const fullPath = join(fixtureVault, relPath);
  mkdirSync(dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, content, 'utf8');
}

function textOf(result: Awaited<ReturnType<Client['callTool']>>): string {
  const content = result.content as Array<{ type: string; text: string }>;
  expect(result.isError).toBeFalsy();
  expect(content).toHaveLength(1);
  expect(content[0]).toMatchObject({ type: 'text' });
  expect(typeof content[0]?.text).toBe('string');
  return content[0]!.text;
}

function requireServerWithTools(tools: string[]): McpServer {
  if (typeof createRuneMcpServer !== 'function') {
    expect.fail('createRuneMcpServer is not exported - implementation pending');
  }

  try {
    return createRuneMcpServer({ tools, name: 'rune-mcp' });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    expect.fail(`${tools.join(', ')} must be registered MCP tools - ${message}`);
  }
}

function seedFixtureVault(): void {
  writeVaultFile(
    'journals/2026_06_09.md',
    [
      '# 2026-06-09',
      '',
      'OUTSIDE_RANGE_JOURNAL_MARKER #writing',
      '',
    ].join('\n'),
  );
  writeVaultFile(
    'journals/2026_06_10.md',
    [
      '# 2026-06-10',
      '',
      'RANGE_START_MARKER planned the [[Velocity Note]] draft. #writing',
      'DIFFERENT_TAG_MARKER family note. #family',
      '',
    ].join('\n'),
  );
  writeVaultFile(
    'journals/2026_06_11.md',
    [
      '# 2026-06-11',
      '',
      'RANGE_END_MARKER revised the writing outline. #writing',
      '',
    ].join('\n'),
  );
  writeVaultFile(
    'journals/2026_06_12.md',
    [
      '# 2026-06-12',
      '',
      'OUTSIDE_RANGE_END_MARKER shipped a later draft. #writing',
      '',
    ].join('\n'),
  );
  writeVaultFile(
    'knowledge/velocity-note.md',
    [
      '# Velocity Note',
      '',
      'RESOLVED_WIKILINK_TARGET content from the target note.',
      '',
    ].join('\n'),
  );
  writeVaultFile(
    'knowledge/unlinked.md',
    [
      '# Unlinked',
      '',
      'UNLINKED_TARGET_SHOULD_NOT_APPEAR',
      '',
    ].join('\n'),
  );
}

beforeEach(() => {
  previousVaultDir = process.env['VAULT_DIR'];
  fixtureVault = mkdtempSync(join(tmpdir(), 'rune-mcp-content-functions-'));
  process.env['VAULT_DIR'] = fixtureVault;
  seedFixtureVault();
  buildVaultIndex();
  // Prove these content tools are served from the warm index, not by a
  // per-call file read or cold vault walk.
  rmSync(fixtureVault, { recursive: true, force: true });
  mkdirSync(fixtureVault, { recursive: true });
});

afterEach(() => {
  if (previousVaultDir === undefined) {
    delete process.env['VAULT_DIR'];
  } else {
    process.env['VAULT_DIR'] = previousVaultDir;
  }

  if (fixtureVault) {
    rmSync(fixtureVault, { recursive: true, force: true });
    fixtureVault = null;
  }
});

describe('expanded MCP content functions', () => {
  it('journal_range is registered with required ISO start/end date inputs', async () => {
    const server = requireServerWithTools(['journal_range']);
    const client = await connectClient(server);

    try {
      const { tools } = await client.listTools();
      const tool = tools.find((entry) => entry.name === 'journal_range');
      expect(tool).toBeDefined();
      expect(tool?.description).toMatch(/journal/i);

      const schema = tool?.inputSchema as {
        type?: string;
        required?: string[];
        properties?: Record<string, { type?: string; description?: string }>;
      };
      expect(schema.type).toBe('object');
      expect(schema.required).toEqual(expect.arrayContaining(['startDate', 'endDate']));
      expect(schema.properties?.startDate).toMatchObject({ type: 'string' });
      expect(schema.properties?.startDate?.description).toMatch(/YYYY-MM-DD/i);
      expect(schema.properties?.endDate).toMatchObject({ type: 'string' });
      expect(schema.properties?.endDate?.description).toMatch(/YYYY-MM-DD/i);
    } finally {
      await client.close();
    }
  });

  it('journal_range returns journal entries for an inclusive date range from the warm index', async () => {
    const server = requireServerWithTools(['journal_range']);
    const client = await connectClient(server);

    try {
      const result = await client.callTool({
        name: 'journal_range',
        arguments: {
          startDate: '2026-06-10',
          endDate: '2026-06-11',
        },
      });

      const text = textOf(result);
      expect(text).toContain('journals/2026_06_10.md');
      expect(text).toContain('RANGE_START_MARKER');
      expect(text).toContain('journals/2026_06_11.md');
      expect(text).toContain('RANGE_END_MARKER');
      expect(text).not.toContain('OUTSIDE_RANGE_JOURNAL_MARKER');
      expect(text).not.toContain('OUTSIDE_RANGE_END_MARKER');
    } finally {
      await client.close();
    }
  });

  it('follow_wikilinks resolves wikilinks from a source file to target vault content', async () => {
    const server = requireServerWithTools(['follow_wikilinks']);
    const client = await connectClient(server);

    try {
      const result = await client.callTool({
        name: 'follow_wikilinks',
        arguments: {
          sourceFile: 'journals/2026_06_10.md',
          maxDepth: 1,
          maxResults: 5,
        },
      });

      const text = textOf(result);
      expect(text).toContain('[[Velocity Note]]');
      expect(text).toContain('knowledge/velocity-note.md');
      expect(text).toContain('RESOLVED_WIKILINK_TARGET');
      expect(text).not.toContain('UNLINKED_TARGET_SHOULD_NOT_APPEAR');
    } finally {
      await client.close();
    }
  });

  it('tag_date_query returns only entries matching both tag and date-range filters', async () => {
    const server = requireServerWithTools(['tag_date_query']);
    const client = await connectClient(server);

    try {
      const result = await client.callTool({
        name: 'tag_date_query',
        arguments: {
          tag: 'writing',
          startDate: '2026-06-10',
          endDate: '2026-06-11',
          maxResults: 10,
        },
      });

      const text = textOf(result);
      expect(text).toContain('journals/2026_06_10.md');
      expect(text).toContain('RANGE_START_MARKER');
      expect(text).toContain('journals/2026_06_11.md');
      expect(text).toContain('RANGE_END_MARKER');
      expect(text).not.toContain('DIFFERENT_TAG_MARKER');
      expect(text).not.toContain('OUTSIDE_RANGE_JOURNAL_MARKER');
      expect(text).not.toContain('OUTSIDE_RANGE_END_MARKER');
    } finally {
      await client.close();
    }
  });
});
