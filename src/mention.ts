function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Boundary-anchored on the trailing side so "@issue-bot2" (a
 * different, unrelated handle) doesn't false-positive against the
 * configured mention string.
 */
export function mentionPattern(mention: string): RegExp {
  return new RegExp(`${escapeRegExp(mention)}(?![\\w-])`, "i");
}

export function hasMention(body: string, mention: string): boolean {
  return mentionPattern(mention).test(body);
}
