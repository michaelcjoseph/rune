/**
 * Best-effort redaction of known secret/token patterns before content crosses
 * a local UI or transcript boundary. Best-effort, not a guarantee.
 */
/**
 * A short, deterministic, non-secret tag derived from the matched secret. It
 * makes every redacted value distinguishable from a bare placeholder literal.
 *
 * A per-secret tag prevents a raw redaction fixture from collapsing into the
 * same literal that a test may name as its expected redacted output.
 */
function redactionTag(secret: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < secret.length; i++) {
    h = Math.imul(h ^ secret.charCodeAt(i), 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0').slice(0, 6);
}

const REDACTIONS: ReadonlyArray<
  readonly [RegExp, (match: string, ...groups: string[]) => string]
> = [
  [/(https?:\/\/)[^\s/@]+@/gi, (_m, scheme: string) => `${scheme}<redacted>@`],
  [/\bBearer\s+[-A-Za-z0-9._~+/=]+/gi, (m) => `Bearer <redacted-${redactionTag(m)}>`],
  [/\bsk-[A-Za-z0-9_-]{6,}/g, (m) => `sk-<redacted-${redactionTag(m)}>`],
  [/\b\d{8,10}:[A-Za-z0-9_-]{35}\b/g, (m) => `<tg-token-redacted-${redactionTag(m)}>`],
  [/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36}\b/g, (m) => `<gh-token-redacted-${redactionTag(m)}>`],
  [/\bgithub_pat_[A-Za-z0-9_]{22,}\b/g, (m) => `<gh-token-redacted-${redactionTag(m)}>`],
  [/\bAKIA[A-Z0-9]{16}\b/g, (m) => `<aws-key-redacted-${redactionTag(m)}>`],
  [/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, (m) => `<jwt-redacted-${redactionTag(m)}>`],
];

export function redactSecrets(text: string): string {
  let out = text;
  for (const [re, repl] of REDACTIONS) out = out.replace(re, repl);
  return out;
}
