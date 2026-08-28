import { describe, expect, it } from "vitest";
import { collectThreadComments, threadRootId, type ThreadableComment } from "./threadContext.js";

describe("threadRootId", () => {
  it("returns the comment itself when it has no parent", () => {
    const byId = new Map<number, ThreadableComment>([[1, { id: 1 }]]);
    expect(threadRootId(1, byId)).toBe(1);
  });

  it("resolves a direct reply to its root", () => {
    const byId = new Map<number, ThreadableComment>([
      [1, { id: 1 }],
      [2, { id: 2, in_reply_to_id: 1 }],
    ]);
    expect(threadRootId(2, byId)).toBe(1);
  });

  it("walks a multi-hop chain to the root", () => {
    const byId = new Map<number, ThreadableComment>([
      [1, { id: 1 }],
      [2, { id: 2, in_reply_to_id: 1 }],
      [3, { id: 3, in_reply_to_id: 2 }],
    ]);
    expect(threadRootId(3, byId)).toBe(1);
  });

  it("does not infinite-loop on a cycle", () => {
    const byId = new Map<number, ThreadableComment>([
      [1, { id: 1, in_reply_to_id: 2 }],
      [2, { id: 2, in_reply_to_id: 1 }],
    ]);
    expect(threadRootId(1, byId)).toBeTypeOf("number");
  });
});

describe("collectThreadComments", () => {
  it("groups only comments belonging to the same thread", () => {
    const comments = [
      { id: 1 },
      { id: 2, in_reply_to_id: 1 },
      { id: 3, in_reply_to_id: 1 },
      { id: 10 },
      { id: 11, in_reply_to_id: 10 },
    ];
    const thread = collectThreadComments(2, comments);
    expect(thread.map((c) => c.id).sort()).toEqual([1, 2, 3]);
  });
});
