/** Durable user-facing identity for a supervised work run. */
export interface WorkRunTarget {
  kind: 'project' | 'bug';
  slug: string;
}

interface TargetDescriptor {
  id: string;
  target: { ref: string };
  payload: unknown;
}

/** Resolve the explicit mutation target, with legacy payload fallbacks. */
export function runTargetFromDescriptor(descriptor: TargetDescriptor): WorkRunTarget {
  const payload = descriptor.payload as Record<string, unknown>;
  const target = payload['target'];
  if (target && typeof target === 'object' && !Array.isArray(target)) {
    const obj = target as Record<string, unknown>;
    if ((obj['kind'] === 'project' || obj['kind'] === 'bug') && typeof obj['slug'] === 'string') {
      return { kind: obj['kind'], slug: obj['slug'] };
    }
  }
  if (typeof payload['bugId'] === 'string') return { kind: 'bug', slug: payload['bugId'] };
  const slug =
    typeof payload['projectSlug'] === 'string' ? payload['projectSlug']
    : typeof payload['ref'] === 'string' ? payload['ref']
    : descriptor.target.ref || descriptor.id;
  return { kind: 'project', slug };
}
