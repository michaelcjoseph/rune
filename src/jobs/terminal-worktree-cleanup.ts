/**
 * The only destructive terminal worktree transaction: invalidate resumability
 * synchronously before beginning removal. A thrown invalidation prevents the
 * removal effect from running.
 */
export async function invalidateCursorThenRemoveWorktree(args: {
  runId: string;
  reason: string;
  invalidateCursor: (runId: string, reason: string) => void;
  removeWorktree: () => Promise<void>;
}): Promise<void> {
  args.invalidateCursor(args.runId, args.reason);
  await args.removeWorktree();
}
