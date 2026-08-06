import type { SupervisedRunWaitingOn } from './supervision.js';

/** Safe operator label derived only from the closed resource type, never its key. */
export function waitingResourceLabel(
  waitingOn: SupervisedRunWaitingOn | undefined,
): string | undefined {
  return waitingOn?.resource.type.replaceAll('-', ' ');
}
