import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  resolveWorkDispatch,
  readDispatchModeInput,
  ORCHESTRATED_WORK_KIND,
  LEGACY_WORK_KIND,
} from './work-dispatch.js';

// ---------------------------------------------------------------------------
// Phase 5 dispatch seam (project 14): the cockpit per-project Start action
// resolves which applier to dispatch — the orchestrated loop or the legacy
// `/work --auto` runner — through this seam. The toggle that selects the mode
// is read from products.json (per-product) over a global default. A legacy
// fallback ALWAYS carries a recorded reason so it can never silently
// masquerade as orchestrated execution.
// ---------------------------------------------------------------------------

describe('resolveWorkDispatch — mode → applier kind', () => {
  it('dispatches the orchestrated applier when orchestrated mode is enabled', () => {
    const res = resolveWorkDispatch({ orchestratedEnabled: true });
    expect(res.mode).toBe('orchestrated');
    expect(res.kind).toBe(ORCHESTRATED_WORK_KIND);
    expect(res.fallbackReason).toBeUndefined();
  });

  it('falls back to the legacy /work --auto applier when orchestrated mode is disabled, and records the reason', () => {
    const res = resolveWorkDispatch({ orchestratedEnabled: false });
    expect(res.mode).toBe('legacy');
    expect(res.kind).toBe(LEGACY_WORK_KIND);
    // A fallback must NEVER be silent — the reason rides through for the run record.
    expect(res.fallbackReason).toBeTruthy();
  });

  it('forceLegacy wins even when orchestrated mode is enabled, carrying its reason', () => {
    const res = resolveWorkDispatch({
      orchestratedEnabled: true,
      forceLegacy: true,
      forceLegacyReason: 'operator override',
    });
    expect(res.mode).toBe('legacy');
    expect(res.kind).toBe(LEGACY_WORK_KIND);
    expect(res.fallbackReason).toBe('operator override');
  });
});

describe('readDispatchModeInput — toggle read from products.json over a global default', () => {
  let dir: string;
  let cfgPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'work-dispatch-'));
    cfgPath = join(dir, 'products.json');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function writeConfig(obj: Record<string, unknown>): void {
    writeFileSync(cfgPath, JSON.stringify(obj), 'utf8');
  }

  it('per-product orchestratedMode:true overrides a global-disabled default', () => {
    writeConfig({
      jarvis: { repoPath: '/repo/jarvis', baseBranch: 'main', orchestratedMode: true },
    });
    const input = readDispatchModeInput({
      product: 'jarvis',
      productsConfigPath: cfgPath,
      globalEnabled: false,
    });
    expect(input.orchestratedEnabled).toBe(true);
  });

  it('per-product orchestratedMode:false overrides a global-enabled default', () => {
    writeConfig({
      jarvis: { repoPath: '/repo/jarvis', baseBranch: 'main', orchestratedMode: false },
    });
    const input = readDispatchModeInput({
      product: 'jarvis',
      productsConfigPath: cfgPath,
      globalEnabled: true,
    });
    expect(input.orchestratedEnabled).toBe(false);
  });

  it('falls back to the global default when the product omits orchestratedMode', () => {
    writeConfig({ jarvis: { repoPath: '/repo/jarvis', baseBranch: 'main' } });
    const input = readDispatchModeInput({
      product: 'jarvis',
      productsConfigPath: cfgPath,
      globalEnabled: true,
    });
    expect(input.orchestratedEnabled).toBe(true);
  });

  it('falls back to the global default (no crash) for an unknown/unreadable product', () => {
    writeConfig({ jarvis: { repoPath: '/repo/jarvis', baseBranch: 'main' } });
    const input = readDispatchModeInput({
      product: 'does-not-exist',
      productsConfigPath: cfgPath,
      globalEnabled: false,
    });
    expect(input.orchestratedEnabled).toBe(false);
  });

  it('threads forceLegacy + reason through to the DispatchModeInput', () => {
    writeConfig({ jarvis: { repoPath: '/repo/jarvis', baseBranch: 'main', orchestratedMode: true } });
    const input = readDispatchModeInput({
      product: 'jarvis',
      productsConfigPath: cfgPath,
      globalEnabled: true,
      forceLegacy: true,
      forceLegacyReason: 'rollback',
    });
    expect(input.forceLegacy).toBe(true);
    expect(input.forceLegacyReason).toBe('rollback');
  });
});
