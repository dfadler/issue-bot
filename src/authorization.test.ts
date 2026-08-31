import { describe, expect, it } from "vitest";
import { isAuthorizedAssociation } from "./authorization.js";

describe("isAuthorizedAssociation", () => {
  it.each(["OWNER", "MEMBER", "COLLABORATOR"] as const)("allows %s", (association) => {
    expect(isAuthorizedAssociation(association)).toBe(true);
  });

  it.each([
    "CONTRIBUTOR",
    "FIRST_TIMER",
    "FIRST_TIME_CONTRIBUTOR",
    "MANNEQUIN",
    "NONE",
  ] as const)("denies %s", (association) => {
    expect(isAuthorizedAssociation(association)).toBe(false);
  });
});
