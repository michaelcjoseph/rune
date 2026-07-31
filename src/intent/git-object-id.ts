/** Git object-id shape shared by canonical review and validation evidence. */
const GIT_OBJECT_ID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

export function isGitObjectId(value: string): boolean {
  return GIT_OBJECT_ID.test(value);
}
