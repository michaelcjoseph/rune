/** Production bindings for the product-scoped Cockpit run tools. */

import config from '../../config.js';
import { readRecentOrchestratedTaskRunRecords } from '../../jobs/task-run-record-store.js';
import {
  readTranscriptDisplayTail,
  type WorkRunDiagnosticsDeps,
} from '../../jobs/work-run-diagnostics.js';
import {
  readRecentIndexBounded,
  readWorkRunSummary,
  readWorkRunSummaryResult,
} from '../../jobs/work-run-store.js';
import { readAllRunsBounded } from '../../jobs/supervision-store.js';

export function buildProductionWorkRunDiagnosticsDeps(): WorkRunDiagnosticsDeps {
  return {
    readRecentSummaries: (limit) => readRecentIndexBounded(config.WORK_RUNS_INDEX_FILE, limit)
      .flatMap(row => {
        const summary = readWorkRunSummary(config.WORK_RUNS_DIR, row.id);
        return summary ? [summary] : [];
      }),
    readSummary: runId => readWorkRunSummaryResult(config.WORK_RUNS_DIR, runId),
    readSupervisedRuns: () => readAllRunsBounded(config.SUPERVISED_RUNS_FILE),
    readTaskRunRecords: runId => readRecentOrchestratedTaskRunRecords(config.WORK_RUNS_DIR, runId, 20),
    readTranscriptTail: runId => readTranscriptDisplayTail(config.WORK_RUNS_DIR, runId),
  };
}
