import { describe, expect, it } from "vitest";
import { hasMention } from "./mention.js";

describe("hasMention", () => {
  it("matches a plain mention", () => {
    expect(hasMention("please file this @dfadler-issue-bot", "@dfadler-issue-bot")).toBe(true);
  });

  it("is case-insensitive", () => {
    expect(hasMention("@DFADLER-ISSUE-BOT do it", "@dfadler-issue-bot")).toBe(true);
  });

  it("does not match a longer, unrelated handle", () => {
    expect(hasMention("cc @dfadler-issue-bot2", "@dfadler-issue-bot")).toBe(false);
  });

  it("does not match when the mention is absent", () => {
    expect(hasMention("just a normal comment", "@dfadler-issue-bot")).toBe(false);
  });

  it("matches when followed by punctuation", () => {
    expect(hasMention("@dfadler-issue-bot, please file this.", "@dfadler-issue-bot")).toBe(true);
  });
});
