import type { AuthorAssociation } from "./payloads.js";

/**
 * Associations that carry push/write access to the repo. Chosen over also
 * allowing `CONTRIBUTOR` (merged a PR but has no ongoing write access) so a
 * comment from an outside contributor can't file issues on the repo owner's
 * behalf without a maintainer's say-so.
 */
const AUTHORIZED_ASSOCIATIONS: ReadonlySet<AuthorAssociation> = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);

export function isAuthorizedAssociation(association: AuthorAssociation): boolean {
  return AUTHORIZED_ASSOCIATIONS.has(association);
}
