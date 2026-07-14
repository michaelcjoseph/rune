/** Where the first accepted request to cancel a live child operation came
 * from. User-facing sources map to user-cancel semantics; internal requests
 * map to system-cancel semantics. */
export type CancellationSource = 'telegram' | 'cockpit' | 'internal';

/** Provider-neutral cancellation correlation captured before a live operation
 * is unregistered and safe to propagate into durable run state. */
export interface OperationCancellation {
  operationId: string;
  source: CancellationSource;
  requestedAt: string;
}
