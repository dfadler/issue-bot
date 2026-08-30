import { describe, expect, it } from "vitest";
import { hasMention } from "./mention.js";

describe("hasMention", () => {
  it("matches a plain mention", () => {
    expect(hasMention("please file this @issue-bot", "@issue-bot")).toBe(true);
  });

  it("is case-insensitive", () => {
    expect(hasMention("@ISSUE-BOT do it", "@issue-bot")).toBe(true);
  });

  it("does not match a longer, unrelated handle", () => {
    expect(hasMention("cc @issue-bot2", "@issue-bot")).toBe(false);
  });

  it("does not match when the mention is absent", () => {
    expect(hasMention("just a normal comment", "@issue-bot")).toBe(false);
  });

  it("matches when followed by punctuation", () => {
    expect(hasMention("@issue-bot, please file this.", "@issue-bot")).toBe(true);
  });
});
