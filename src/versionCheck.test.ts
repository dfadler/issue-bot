import { beforeEach, describe, expect, it, vi } from "vitest";
import * as core from "@actions/core";
import type { TagApi } from "./octokit.js";
import {
  buildStaleMessage,
  builtVersion,
  evaluateVersion,
  fetchLatestRelease,
  parseVersionCheckMode,
  runVersionCheck,
  type LatestRelease,
  type VersionCheckOctokit,
} from "./versionCheck.js";

vi.mock("@actions/core", () => ({
  info: vi.fn(),
  warning: vi.fn(),
  setFailed: vi.fn(),
}));

const info = vi.mocked(core.info);
const warning = vi.mocked(core.warning);
const setFailed = vi.mocked(core.setFailed);

function tag(name: string, sha = `sha-${name}`): TagApi {
  return { name, commit: { sha } };
}

/**
 * Fakes only what the version check touches. `listTags` is a `vi.fn` so a
 * test can both script its response and assert whether it was called.
 */
function createFakeOctokit(listTags: VersionCheckOctokit["rest"]["repos"]["listTags"]): VersionCheckOctokit {
  return {
    paginate: async (route, params) => {
      const { data } = await route(params);
      return data;
    },
    rest: { repos: { listTags } },
  };
}

function tagsResponse(...tags: TagApi[]): VersionCheckOctokit["rest"]["repos"]["listTags"] {
  return vi.fn(async () => ({ data: tags }));
}

const LATEST_1_2_0: LatestRelease = { version: { major: 1, minor: 2, patch: 0 }, tag: "v1.2.0", sha: "abc123" };

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.ISSUE_BOT_VERSION;
});

describe("parseVersionCheckMode", () => {
  it.each([
    ["fail", "fail"],
    ["warn", "warn"],
    ["off", "off"],
    ["FAIL", "fail"],
    [" warn ", "warn"],
  ])("accepts %j as %s", (input, expected) => {
    expect(parseVersionCheckMode(input)).toBe(expected);
  });

  it.each(["", "true", "false", "error", "strict", "fail,warn"])("rejects %j", (input) => {
    expect(parseVersionCheckMode(input)).toBeNull();
  });
});

describe("builtVersion", () => {
  it("is undefined when the bundle was built without a version", () => {
    expect(builtVersion()).toBeUndefined();
    process.env.ISSUE_BOT_VERSION = "";
    expect(builtVersion()).toBeUndefined();
  });

  it("returns the stamped version", () => {
    process.env.ISSUE_BOT_VERSION = "1.2.3";
    expect(builtVersion()).toBe("1.2.3");
  });
});

describe("fetchLatestRelease", () => {
  it("picks the highest vX.Y.Z tag by semver, ignoring major-only aliases and non-version tags", async () => {
    // Deliberately not in semver order, and "v1.10.0" sorts before "v1.9.0"
    // lexically - the comparison must be numeric. "v1" is the moving major
    // alias the release workflow also maintains; it points at the same
    // commit as the newest full tag but must never itself be "the latest".
    const octokit = createFakeOctokit(
      tagsResponse(tag("v1.9.0"), tag("v1"), tag("v1.10.0"), tag("v1.2.0"), tag("nightly"), tag("v0.9.9")),
    );

    await expect(fetchLatestRelease(octokit)).resolves.toEqual({
      version: { major: 1, minor: 10, patch: 0 },
      tag: "v1.10.0",
      sha: "sha-v1.10.0",
    });
  });

  it("returns null when no tag is a full semver version", async () => {
    const octokit = createFakeOctokit(tagsResponse(tag("v1"), tag("latest")));
    await expect(fetchLatestRelease(octokit)).resolves.toBeNull();
  });

  it("queries the canonical upstream repo, not the consumer's", async () => {
    const listTags = tagsResponse(tag("v1.0.0"));
    await fetchLatestRelease(createFakeOctokit(listTags));
    expect(listTags).toHaveBeenCalledWith(expect.objectContaining({ owner: "dfadler", repo: "issue-bot" }));
  });
});

describe("evaluateVersion", () => {
  it("is stale when the running version is older than the latest tag", () => {
    const outcome = evaluateVersion("1.1.0", LATEST_1_2_0);
    expect(outcome.status).toBe("stale");
  });

  it("is current when the running version equals the latest tag", () => {
    expect(evaluateVersion("1.2.0", LATEST_1_2_0).status).toBe("current");
    expect(evaluateVersion("v1.2.0", LATEST_1_2_0).status).toBe("current");
  });

  it("is current (not stale) when the running version is newer than every tag", () => {
    // A release build whose tags haven't been pushed yet, or a fork ahead of
    // upstream - neither is an out-of-date consumer.
    expect(evaluateVersion("1.3.0", LATEST_1_2_0).status).toBe("current");
    expect(evaluateVersion("2.0.0", LATEST_1_2_0).status).toBe("current");
  });

  it("skips when the bundle has no embedded version", () => {
    const outcome = evaluateVersion(undefined, LATEST_1_2_0);
    expect(outcome.status).toBe("skipped");
    expect(outcome).toMatchObject({ reason: expect.stringContaining("built without a release version") });
  });

  it("skips when the embedded version is not semver", () => {
    const outcome = evaluateVersion("main", LATEST_1_2_0);
    expect(outcome.status).toBe("skipped");
    expect(outcome).toMatchObject({ reason: expect.stringContaining('"main"') });
  });

  it("skips when upstream has no semver tags", () => {
    const outcome = evaluateVersion("1.1.0", null);
    expect(outcome.status).toBe("skipped");
    expect(outcome).toMatchObject({ reason: expect.stringContaining("no vX.Y.Z release tags") });
  });
});

describe("buildStaleMessage", () => {
  it("names both versions and gives the exact SHA-pinned uses: line plus the tag form", () => {
    const message = buildStaleMessage({ major: 1, minor: 1, patch: 0 }, LATEST_1_2_0);
    expect(message).toContain("v1.1.0 is running");
    expect(message).toContain("v1.2.0 is the latest release");
    expect(message).toContain("uses: dfadler/issue-bot@abc123 # v1.2.0");
    expect(message).toContain("uses: dfadler/issue-bot@v1.2.0");
    expect(message).toContain("version-check");
  });
});

describe("runVersionCheck", () => {
  describe("mode: fail", () => {
    it("fails the run and stops when the running version is stale", async () => {
      const proceed = await runVersionCheck(createFakeOctokit(tagsResponse(tag("v1.2.0", "abc123"))), "fail", "1.1.0");

      expect(proceed).toBe(false);
      expect(setFailed).toHaveBeenCalledTimes(1);
      expect(setFailed).toHaveBeenCalledWith(expect.stringContaining("uses: dfadler/issue-bot@abc123 # v1.2.0"));
      expect(warning).not.toHaveBeenCalled();
    });

    it("proceeds silently (info only) when up to date", async () => {
      const proceed = await runVersionCheck(createFakeOctokit(tagsResponse(tag("v1.2.0"))), "fail", "1.2.0");

      expect(proceed).toBe(true);
      expect(setFailed).not.toHaveBeenCalled();
      expect(warning).not.toHaveBeenCalled();
      expect(info).toHaveBeenCalledWith(expect.stringContaining("up to date"));
    });

    it("warns and proceeds - never fails - when the tag lookup throws (network, rate limit, 404)", async () => {
      const listTags = vi.fn(async () => {
        throw new Error("API rate limit exceeded");
      });
      const proceed = await runVersionCheck(createFakeOctokit(listTags), "fail", "1.1.0");

      expect(proceed).toBe(true);
      expect(setFailed).not.toHaveBeenCalled();
      expect(warning).toHaveBeenCalledWith(expect.stringContaining("API rate limit exceeded"));
    });

    it("warns and proceeds for a dev build with no embedded version", async () => {
      const proceed = await runVersionCheck(createFakeOctokit(tagsResponse(tag("v1.2.0"))), "fail", undefined);

      expect(proceed).toBe(true);
      expect(setFailed).not.toHaveBeenCalled();
      expect(warning).toHaveBeenCalledWith(expect.stringContaining("built without a release version"));
    });
  });

  describe("mode: warn", () => {
    it("warns with the same message but proceeds when stale", async () => {
      const proceed = await runVersionCheck(createFakeOctokit(tagsResponse(tag("v1.2.0", "abc123"))), "warn", "1.1.0");

      expect(proceed).toBe(true);
      expect(setFailed).not.toHaveBeenCalled();
      expect(warning).toHaveBeenCalledTimes(1);
      expect(warning).toHaveBeenCalledWith(expect.stringContaining("uses: dfadler/issue-bot@abc123 # v1.2.0"));
    });

    it("proceeds without warning when up to date", async () => {
      const proceed = await runVersionCheck(createFakeOctokit(tagsResponse(tag("v1.2.0"))), "warn", "1.2.0");

      expect(proceed).toBe(true);
      expect(warning).not.toHaveBeenCalled();
      expect(setFailed).not.toHaveBeenCalled();
    });
  });

  describe("mode: off", () => {
    it("proceeds without calling the API at all", async () => {
      const listTags = tagsResponse(tag("v9.9.9"));
      const proceed = await runVersionCheck(createFakeOctokit(listTags), "off", "1.0.0");

      expect(proceed).toBe(true);
      expect(listTags).not.toHaveBeenCalled();
      expect(setFailed).not.toHaveBeenCalled();
      expect(warning).not.toHaveBeenCalled();
    });
  });
});
