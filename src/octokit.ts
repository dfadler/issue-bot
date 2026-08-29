import { getOctokit } from "@actions/github";

export type ReviewCommentApi = {
  id: number;
  in_reply_to_id?: number;
  body: string;
  user: { login: string } | null;
  created_at: string;
};

export type IssueCommentApi = {
  id: number;
  body?: string;
  user: { login: string } | null;
  created_at: string;
};

export type IssueApi = {
  number: number;
  html_url: string;
  body?: string | null;
};

export type CreatedIssueApi = {
  number: number;
  html_url: string;
};

/**
 * The minimal slice of Octokit's REST surface this action actually calls -
 * exactly the methods used by threadContext.ts, followUpIssue.ts, and
 * index.ts's event dispatch. Hand-rolled instead of exporting
 * `ReturnType<typeof getOctokit>` (the full, deeply overloaded SDK client
 * type) so tests can pass a plain fake object literal implementing just
 * these methods - no type assertion needed to bridge the gap, which matters
 * because this repo's eslint config (`consistent-type-assertions`,
 * `assertionStyle: "never"`) forbids `as` casts outright. The real Octokit
 * instance from `@actions/github` still satisfies this structurally, so
 * production call sites need no cast either.
 */
export type Octokit = {
  paginate<T, P>(route: (params: P) => Promise<{ data: T[] }>, params: P): Promise<T[]>;
  rest: {
    pulls: {
      listReviewComments(params: {
        owner: string;
        repo: string;
        pull_number: number;
        per_page?: number;
      }): Promise<{ data: ReviewCommentApi[] }>;
    };
    issues: {
      listComments(params: {
        owner: string;
        repo: string;
        issue_number: number;
        per_page?: number;
      }): Promise<{ data: IssueCommentApi[] }>;
      listForRepo(params: {
        owner: string;
        repo: string;
        state?: "open" | "closed" | "all";
        per_page?: number;
      }): Promise<{ data: IssueApi[] }>;
      getLabel(params: { owner: string; repo: string; name: string }): Promise<unknown>;
      createLabel(params: { owner: string; repo: string; name: string; color?: string }): Promise<unknown>;
      create(params: {
        owner: string;
        repo: string;
        title: string;
        body?: string;
        labels?: string[];
      }): Promise<{ data: CreatedIssueApi }>;
    };
  };
};

/**
 * Not called at runtime - exists purely so `tsc` fails loudly if the real
 * Octokit client ever stops structurally satisfying the minimal `Octokit`
 * type above (e.g. after an `@actions/github` upgrade renames a method).
 */
export function assertRealOctokitSatisfiesMinimalOctokit(real: ReturnType<typeof getOctokit>): Octokit {
  return real;
}
