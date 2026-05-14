import config, { PROJECT_ROOT } from '../config.js';

const MAX_DETAIL_LEN = 80;

function truncate(s: string, max = MAX_DETAIL_LEN): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + '…';
}

/** Strip the vault or project-root prefix from an absolute file path so the
 *  user sees a short relative path in the activity log. */
function shortenPath(p: string): string {
  if (typeof p !== 'string' || !p) return String(p);
  if (config.VAULT_DIR && p.startsWith(config.VAULT_DIR + '/')) {
    return p.slice(config.VAULT_DIR.length + 1);
  }
  if (config.WORKSPACE_DIR && p.startsWith(config.WORKSPACE_DIR + '/')) {
    return p.slice(config.WORKSPACE_DIR.length + 1);
  }
  if (p.startsWith(PROJECT_ROOT + '/')) {
    return p.slice(PROJECT_ROOT.length + 1);
  }
  return p;
}

/** Strip vault / workspace / project-root prefixes from path-like tokens
 *  embedded in free-form text (e.g. a Bash command string). Does global
 *  replacement so a command like `rg foo /vault/notes /vault/journals` is
 *  rendered as `rg foo notes journals`. */
function scrubPathsInText(s: string): string {
  let out = s;
  if (config.VAULT_DIR)     out = out.split(config.VAULT_DIR + '/').join('');
  if (config.WORKSPACE_DIR) out = out.split(config.WORKSPACE_DIR + '/').join('');
  out = out.split(PROJECT_ROOT + '/').join('');
  return out;
}

/** Just the hostname of a URL (for WebFetch). Falls back to the raw string if
 *  it doesn't parse — short and unsurprising rather than throw. */
function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

interface Input {
  [k: string]: unknown;
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

/** Map a Claude `tool_use` content block to a one-line user-facing phrase.
 *  Truncated to ~80 chars. Used to populate `op-event.detail` so the webview
 *  activity panel shows "Read: knowledge/index.md" rather than the raw JSON. */
export function formatToolUse(name: string, input: unknown): string {
  const inp = (input && typeof input === 'object' ? input : {}) as Input;

  switch (name) {
    case 'Read':
      return truncate(`Read: ${shortenPath(str(inp['file_path']))}`);
    case 'Edit':
      return truncate(`Edit: ${shortenPath(str(inp['file_path']))}`);
    case 'Write':
      return truncate(`Write: ${shortenPath(str(inp['file_path']))}`);
    case 'Glob':
      return truncate(`Glob: ${str(inp['pattern'])}`);
    case 'Grep':
      return truncate(`Grep: ${str(inp['pattern'])}`);
    case 'WebSearch':
      return truncate(`WebSearch: ${str(inp['query'])}`);
    case 'WebFetch':
      return truncate(`WebFetch: ${hostOf(str(inp['url']))}`);
    case 'Bash':
      // Bash detail is surfaced to the browser over the auth-gated WS; scrub
      // absolute paths so an `rg foo /Users/…/vault/notes` doesn't leak the
      // host directory layout into the UI.
      return truncate(`Bash: ${scrubPathsInText(str(inp['command']))}`);
    case 'Task':
      return truncate(`Agent: ${str(inp['subagent_type']) || str(inp['description'])}`);
    case 'TodoWrite':
      return 'Updating todo list';
    case 'NotebookEdit':
      return truncate(`Edit notebook: ${shortenPath(str(inp['notebook_path']))}`);
    default: {
      // MCP tools follow the convention `mcp__<server>__<method>`. Surface
      // the method with a sensible prefix.
      if (name.startsWith('mcp__jarvis-kb__')) {
        const method = name.slice('mcp__jarvis-kb__'.length);
        const query = str(inp['query'] ?? inp['question']);
        const label = method === 'kb_query'  ? 'KB query'
                    : method === 'kb_search' ? 'KB search'
                    : method === 'kb_ingest' ? 'KB ingest'
                    : method === 'kb_stats'  ? 'KB stats'
                    : method === 'kb_lint'   ? 'KB lint'
                    : `KB ${method}`;
        return truncate(query ? `${label}: ${query}` : label);
      }
      if (name.startsWith('mcp__')) {
        const rest = name.slice('mcp__'.length);
        return truncate(`MCP: ${rest}`);
      }
      // Unknown tool — show name + a short JSON preview of the input.
      let preview = '';
      try { preview = JSON.stringify(inp); } catch { /* BigInt / circular — ignore */ }
      return truncate(preview ? `${name}: ${preview}` : name);
    }
  }
}
