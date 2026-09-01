# GitHub App hosting options (personal, install-once use)

Status: research only, no implementation. Written 2026-09-01.

Scope: this document re-evaluates the hosting question from issue [#28](https://github.com/dfadler/issue-bot/issues/28) under a **narrower framing** than that issue's investigation — personal use, installed once across a small, known set of the maintainer's own repos, at low volume (a handful to at most a few hundred `pull_request_review_comment`/`issue_comment` webhook events per month). Issue #28's conclusion ("don't build a GitHub App — hosting/ops burden isn't worth it") assumed OSS-scale, unknown-consumer distribution. This document does **not** relitigate the OSS-distribution case; it asks a different question: *given that volume and trust level, what is the lowest-ops way to run the webhook receiver, and does that change the calculus?*

## Summary and recommendation

**Recommended: Cloudflare Workers**, with **AWS Lambda + Function URL** as the strongest alternative if the maintainer prefers to stay in the AWS ecosystem or wants IAM-based access control on the endpoint.

Both options:
- Cost **$0/month** at this volume — the request/compute volume described (a handful to a few hundred events/month) is a rounding error against either platform's free tier (Workers: 100,000 requests/day; Lambda: 1,000,000 requests + 400,000 GB-seconds/month, and this is Lambda's *standing* free tier, not a 12-month trial allowance — see [AWS Lambda pricing](https://aws.amazon.com/lambda/pricing/), accessed 2026-09-01).
- Have cold-start latency far inside GitHub's 10-second delivery deadline ([Handling webhook deliveries](https://docs.github.com/en/webhooks/using-webhooks/handling-webhook-deliveries)): Workers' V8-isolate model has no traditional cold start at all ("any given isolate can start around a hundred times faster than a Node process on a container or virtual machine" — [How Workers works](https://developers.cloudflare.com/workers/reference/how-workers-works/)); Lambda Node.js cold starts run roughly 150–400ms in typical 2026 production benchmarks, well under 1 second ([Deno's Lambda cold-start benchmarks](https://deno.com/blog/aws-lambda-coldstart-benchmarks); general 2026 benchmark discussion, see Sources).
- Provide TLS automatically with zero certificate management (Workers: served from Cloudflare's edge under `*.workers.dev`/a custom domain; Lambda: HTTPS is baked into the auto-generated `https://<url-id>.lambda-url.<region>.on.aws` endpoint — [Creating and managing Lambda function URLs](https://docs.aws.amazon.com/lambda/latest/dg/lambda-urls.html)).
- Need no separate API-gateway component: a Lambda **Function URL** (not API Gateway) is sufficient and carries no extra charge beyond standard Lambda pricing — the Lambda pricing page lists no separate Function URL line item.
- Store the GitHub App's private key as a native encrypted secret with a one-line CLI command (Workers: `wrangler secret put`, values "not visible within Wrangler or Cloudflare dashboard after you define them" — [Workers secrets](https://developers.cloudflare.com/workers/configuration/secrets/); Lambda: AWS Secrets Manager or SSM Parameter Store `SecureString`).
- Can sign the GitHub App JWT (RS256 / RSASSA-PKCS1-v1.5) using each platform's native runtime — Workers via the standard Web Crypto `crypto.subtle` API, which supports RSASSA-PKCS1-v1.5 sign/verify ([Web Crypto API](https://developers.cloudflare.com/workers/runtime-apis/web-crypto/)); Lambda via Node's built-in `crypto` module (unchanged from any other Node host).
- Deploy from something close to the existing single-bundle `esbuild` output with only a thin adapter layer, not a rewrite (see [Architecture sketch](#minimal-viable-architecture-sketch) below).

**Recommended for the redelivery-catchup job regardless of hosting choice: don't build it on the webhook-hosting platform at all.** GitHub's own documented pattern is a **GitHub Actions scheduled workflow** that lists and redelivers failed deliveries every 6 hours ([Automatically redelivering failed deliveries](https://docs.github.com/en/webhooks/using-webhooks/automatically-redelivering-failed-deliveries-for-a-github-app-webhook)). Since issue-bot's repo is already a GitHub Actions project, this reuses existing tooling and sidesteps every hosting platform's own cron quirks entirely (notably Vercel Hobby's cron jobs are capped at once-per-day — see the Vercel section below — which would be materially coarser than GitHub's own 6-hour example if you tried to build the redelivery job as a platform-native cron job on that specific platform).

Neither recommendation trades away issue-bot's low-ops character in any way that matters at this scale: both are pay-per-use with a $0 floor, need no server patching, and need no TLS renewal. The real cost this document surfaces relative to the current Action model is not infrastructure spend — it's the one-time build of a webhook-receiving shell (signature verification, JWT signing, installation-token minting) around the already-decoupled `handleEvent` core, plus the standing (if small) responsibility of monitoring that shell for failures GitHub won't retry for you past 3 days ([Testing webhooks](https://docs.github.com/en/webhooks/testing-and-troubleshooting-webhooks/testing-webhooks)).

---

## Facts from issue #28 — re-verified

All three facts issue #28 cited are still accurate as of 2026-09-01 (re-fetched from the same URLs):

- **2XX within 10 seconds**, or GitHub "terminates the connection and considers the delivery a failure" — [Handling webhook deliveries](https://docs.github.com/en/webhooks/using-webhooks/handling-webhook-deliveries).
- **No automatic retry.** GitHub's own redelivery mechanism is `GET /app/hook/deliveries` to list, `POST /app/hook/deliveries/{delivery_id}/attempts` to redeliver one — self-built, with GitHub's example being a GitHub Actions workflow on a 6-hour schedule — [Automatically redelivering failed deliveries](https://docs.github.com/en/webhooks/using-webhooks/automatically-redelivering-failed-deliveries-for-a-github-app-webhook).
- **Failed/undelivered records discarded after 3 days** — [Testing webhooks](https://docs.github.com/en/webhooks/testing-and-troubleshooting-webhooks/testing-webhooks).

These facts don't change with volume or trust level — they're properties of GitHub's webhook infrastructure, not of how many consumers install the App. What changes under the personal-use framing is the *practical* consequence: a 3-day outage window losing "a handful to a few hundred events/month" is a much smaller blast radius than losing events across many unrelated OSS consumers, and the maintainer is both the operator and the sole affected party, so there's no external SLA to violate.

---

## Per-option comparison

### AWS Lambda (+ Function URL)

- **Cold start**: 2026 production benchmarks put Node.js Lambda cold starts around 150–400ms at P50 for typical small deployments with no VPC config; ARM64 (Graviton) trims another 15–40% ([search-aggregated 2026 benchmark discussion](https://deno.com/blog/aws-lambda-coldstart-benchmarks) and related sources — see Sources section). This is roughly 25–65x inside GitHub's 10-second deadline even in the worst commonly-cited case.
- **Free tier**: 1,000,000 requests + 400,000 GB-seconds/month, presented as a standing (not time-limited) tier — [AWS Lambda pricing](https://aws.amazon.com/lambda/pricing/), accessed 2026-09-01. Beyond free tier: $0.20/million requests, ~$0.0000166667/GB-second (x86; Arm64 comparable or cheaper) — same source.
- **Ops burden**: TLS is automatic via the Function URL's `on.aws` domain — no cert to manage ([Lambda function URLs](https://docs.aws.amazon.com/lambda/latest/dg/lambda-urls.html)). Secrets: AWS Secrets Manager at $0.40/secret/month + $0.05/10,000 API calls ([Secrets Manager pricing](https://aws.amazon.com/secrets-manager/pricing/), accessed 2026-09-01), or SSM Parameter Store `SecureString` (no per-secret fee, standard-tier parameters are free) if the extra Secrets Manager cost isn't wanted for a single key. Logging is CloudWatch Logs, on by default. The redelivery-catchup job doesn't need to live here at all (see recommendation above) — but if it did, EventBridge Scheduler can trigger a Lambda on a cron with no separate product to stand up.
- **Deployment complexity**: needs an AWS account, IAM role/policy for the function, and either the AWS CLI/console or IaC (CDK/SAM/Terraform) to manage the Function URL resource. More moving parts than Workers, but well-trodden and scriptable.
- **Fit for the current build**: issue-bot already targets Node (the Action runs `node24`, matching Lambda's current `nodejs24.x` GA runtime — [Lambda runtimes](https://docs.aws.amazon.com/lambda/latest/dg/lambda-runtimes.html)) and already produces a single bundled `dist/index.js` via `esbuild --bundle --platform=node --format=esm`. A Lambda handler only needs a thin wrapper translating the Function URL's `APIGatewayProxyEventV2`-shaped request (raw body + headers) into `EventContext` and an installation-token-backed `Octokit`, then calling `handleEvent` unchanged. The esbuild command needs only a target/output-path tweak (Lambda's own entrypoint convention), not a build-process rewrite.

### Cloudflare Workers

- **Cold start**: effectively none in the traditional sense — V8 isolates start "around a hundred times faster than a Node process on a container or virtual machine," with an order-of-magnitude-lower memory footprint at startup ([How Workers works](https://developers.cloudflare.com/workers/reference/how-workers-works/)). Cloudflare's docs don't publish an absolute millisecond figure, but the architecture is specifically designed to avoid the VM/container cold-start class of problem entirely.
- **Free tier**: 100,000 requests/day (≈3M/month) and 10ms of CPU time per invocation on the free plan; paid plan is $5/month base, including 10M requests and 30M CPU-ms, with $0.30/additional-million requests and $0.02/additional-million CPU-ms ([Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/), accessed 2026-08-28 per the page's own "last updated" stamp). At "a handful to a few hundred events/month," this stays inside the free tier's request budget by 3–4 orders of magnitude; the only free-tier variable worth watching is the 10ms-CPU-per-invocation cap, since JWT signing + a few Octokit REST calls could plausibly exceed 10ms of *active CPU* (not wall-clock) on a cold isolate — worth a one-time real-world measurement before assuming $0 forever, though even tripping into the $5/mo paid tier is negligible.
- **Ops burden**: TLS is automatic (Cloudflare terminates it at the edge; no cert to provision or rotate). Secrets are set via `wrangler secret put <KEY>`, stored encrypted and not visible again after being set ([Workers secrets](https://developers.cloudflare.com/workers/configuration/secrets/)). Cron Triggers exist natively (`0 */6 * * *` syntax works, docs use exactly a 6-hour example) if you wanted the redelivery job here instead of GitHub Actions ([Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/)) — though the recommendation above is to keep that job on GitHub Actions regardless.
- **Deployment complexity**: `wrangler deploy` from a single JS/TS entrypoint — no account-wide IAM model to configure, no VPC/networking concepts. Lowest deployment ceremony of any option evaluated.
- **Fit for the current build**: Workers support a large, and by default enabled, subset of Node.js APIs (`nodejs_compat`/`nodejs_compat_v2` on by default for compatibility dates from 2026-08-04 onward — [Node.js compatibility](https://developers.cloudflare.com/workers/runtime-apis/nodejs/)), including `crypto` (needed for HMAC signature verification and RS256 JWT signing) and `fetch`. Octokit's REST client is fetch-based and should run with little or no change, but this is the one item in this comparison worth a smoke test before committing — Workers doesn't run arbitrary npm packages with 100% Node parity, only "a subset of Node.js APIs." issue-bot's `esbuild` bundle step is directly reusable (esbuild is also Wrangler's own bundler under the hood), just pointed at a Workers-shaped entrypoint (`fetch(request, env, ctx)`) instead of the current Action's `run()`.

### Google Cloud Run

- **Cold start**: scale-to-zero is the default when a revision gets no traffic, and Cloud Run's own request-queuing docs note requests "pend for up to 3.5 times average startup time of container instances of this service, or 10 seconds, whichever is greater" while a cold instance spins up ([About instance autoscaling](https://docs.cloud.google.com/run/docs/about-instance-autoscaling), accessed 2026-09-01). No absolute Node.js cold-start figure is published, but container-based cold starts are structurally slower than Lambda's or Workers' — a small Node container is typically sub-second to low-seconds, still comfortably inside GitHub's 10-second window for this use case, but with the least headroom of the three top-tier options if the container image or dependency tree grows. `min-instances >= 1` removes cold starts entirely but "will incur cost even when the service is not actively serving requests" (same source) — not needed at this volume, since scale-to-zero cold start still fits inside the deadline.
- **Free tier**: 2,000,000 requests, 180,000 vCPU-seconds, and 360,000 GiB-seconds free per month ([Cloud Run pricing](https://cloud.google.com/run/pricing), accessed 2026-09-01, confirmed via the page's own published free-tier figures). Paid tier-1 pricing beyond that: $0.00002400/vCPU-second, $0.00000250/GiB-second, $0.40/million requests (same source). At this project's volume, cost is $0.
- **Ops burden**: TLS is automatic on the `*.run.app` domain (or a custom domain via Cloud Run domain mapping). Secrets go in Secret Manager, integrated natively with Cloud Run's env-var/volume mounting. Redelivery cron would use Cloud Scheduler (a separate product to provision, with its own small free tier) — one more moving part than Workers or Lambda if built here.
- **Deployment complexity**: highest of the three top-tier options. Cloud Run deploys a **container image**, not a bundled JS file directly — issue-bot would need a `Dockerfile` (or Cloud Build's buildpacks) added to the build pipeline, a real (if small) change to how the project ships versus its current `esbuild → dist/index.js` model. This is the most meaningful build-process delta of any option in this comparison.
- **Fit for the current build**: full Node.js compatibility (it's a real container, not a restricted runtime), so no API-compatibility risk the way Workers has — but it's the only option here that requires containerizing a project that has deliberately stayed at "bundle to one file" simplicity.

### Vercel serverless/edge functions

- **Cold start**: Vercel's current "Fluid compute" billing model bills Active CPU only while code executes and pauses billing during I/O wait, implying an instance-reuse model similar in spirit to Lambda's warm-container reuse; Vercel's docs don't publish a cold-start figure in the fetched pricing page, and this document did not find one on a primary Vercel source strong enough to cite confidently — treat as **unverified**, likely comparable to Lambda's given both are container/microVM-based, but not confirmed via a primary source.
- **Free tier (Hobby)**: 1,000,000 function invocations, 4 hours of Active CPU, and 360 GB-hours of Provisioned Memory included per month ([Functions usage and pricing](https://vercel.com/docs/functions/usage-and-pricing), page's own `last_updated: 2026-06-16` stamp); a broader summary of Hobby limits (100GB data transfer, etc.) is corroborated by third-party trackers citing Vercel's own docs, not independently re-verified here beyond the functions page itself. At this project's volume this is comfortably $0.
- **Ops burden**: TLS automatic on `*.vercel.app`/custom domains. Secrets via project environment variables (encrypted at rest per Vercel's standard env-var handling — not independently re-verified here). **Important constraint for the redelivery-catchup job specifically**: Vercel Cron Jobs are supported on every plan, but Hobby-plan cron jobs are capped at **once per day**, with only per-hour (±59 min) scheduling precision — "Cron expressions that would run more frequently will fail during deployment" ([Cron Jobs usage and pricing](https://vercel.com/docs/cron-jobs/usage-and-pricing), page's own `last_updated: 2026-07-15` stamp). GitHub's own example runs the redelivery sweep every 6 hours; a Hobby-plan Vercel cron can't natively match that cadence (a once-daily sweep is still inside the 3-day discard window, just coarser) — another point in favor of keeping the redelivery job on GitHub Actions regardless of where the webhook receiver itself lives.
- **Deployment complexity**: `vercel deploy` from a repo, git-integration-first — very low ceremony, similar spirit to Workers.
- **Fit for the current build**: Node.js-compatible serverless functions accept a bundled entrypoint with little adaptation. **Licensing/ToS note specific to this use case**: the Hobby (free) plan's Terms of Service restrict it to "non-commercial, personal use" — this actually matches the stated use case (personal, own repos) well, but is worth flagging explicitly since it's a real contractual constraint, not just a soft nudge, per third-party summaries of Vercel's ToS (not independently re-verified against the raw ToS text in this pass).

### Fly.io

- **Cold start / wake latency**: Fly's `autostop`/`autostart` machine feature lets the Fly Proxy automatically start a stopped machine on an incoming request ("Fly Machines are fast to start and stop," faster from a "suspended" state than a fully "stopped" one — [Autostop/autostart](https://fly.io/docs/launch/autostop-autostart/), accessed 2026-09-01). No absolute latency figure is published in Fly's docs; this is architecturally similar to Cloud Run's scale-to-zero pattern (a real VM/container boot, not an isolate), so treat wake latency as "probably sub-few-seconds, unconfirmed" rather than instant.
- **Free tier**: Fly's pricing page does not describe a standing free tier in the fetched content — only a "Free Trial" reference, with no further detail available in this pass. Fly's own framing is straightforward pay-for-what's-provisioned rather than a monthly free allowance: with `auto_stop_machines`/`min_machines_running = 0`, you "only pay for CPU and RAM" while a machine is actually running ([Fly.io pricing](https://fly.io/docs/about/pricing/), accessed 2026-09-01). The smallest shared-CPU VM (`shared-cpu-1x`, 256MB) runs roughly $2/month if kept running continuously in the cited region example (same source) — at this project's request volume with autostop/autostart, actual monthly compute time would be a small fraction of that, likely low cents, but this is an estimate, not a quoted line-item price for intermittent usage.
- **Ops burden**: TLS is handled by the Fly Proxy for `*.fly.dev` and custom domains. Secrets via `fly secrets set`. No native cron product surfaced in this pass — a redelivery job here would most likely still be the GitHub Actions workflow rather than something Fly-native.
- **Deployment complexity**: higher than Workers/Lambda — Fly deploys a container (via `fly deploy`, typically from a `Dockerfile` or a buildpack), plus `fly.toml` app configuration and (for autostop/autostart) explicit machine-scaling config. Meaningfully more setup than a single-file deploy.
- **Fit for the current build**: like Cloud Run, needs containerizing the project rather than deploying the existing bundle directly — a real change to the build pipeline. Full Node compatibility since it's a real Linux VM under the hood.

### Deno Deploy

- **Cold start**: not confirmed via a primary Deno source in this pass — the fetched pricing page didn't include a startup-latency figure. Deno Deploy is (like Workers) an isolate-based edge platform, so cold starts are plausibly in the same "very fast" class as Workers, but this is an inference, not a cited fact.
- **Free tier**: 1,000,000 requests/month, 10 hours of active CPU/month, 20GiB outbound bandwidth/month ([Deno Deploy pricing](https://deno.com/deploy/pricing), accessed 2026-09-01). At this project's volume, $0/month.
- **Ops burden**: similar shape to Workers — edge platform, no server to patch, TLS automatic. Secret/env-var handling and a native cron product exist on Deno Deploy but weren't independently verified in this pass.
- **Deployment complexity**: low — `deno deploy` from a TS entrypoint, no bundler required (Deno runs TS natively), which is actually a point of friction *relative* to issue-bot's current esbuild-bundle-to-one-file workflow rather than a simplification — the project would likely keep its existing bundle step anyway for consistency with the Action build, or drop it and let Deno handle TS directly (a small build-process decision either way, not a blocker).
- **Fit for the current build**: viable, but is the least-verified option in this comparison (fewer primary-source facts gathered here than for the top four) — worth a deeper look only if Cloudflare Workers turns out to have a real Octokit-compatibility problem in a smoke test.

### Netlify Functions

- **Cold start**: not surfaced in this pass from a primary Netlify source.
- **Free tier**: Netlify moved to a credit-based pricing model; the Free plan includes a "300 credit" monthly allowance covering functions, builds, and other usage together rather than a dedicated function-invocation number ([Netlify pricing](https://www.netlify.com/pricing/), accessed 2026-09-01 — the fetched page confirmed the 300-credit Free tier and $20/month Pro tier with 3,000 credits, but did not expose a clean "credits per function invocation" conversion). This makes free-tier headroom harder to reason about precisely than the other options, though at "a handful to a few hundred events/month" it's very unlikely to be a binding constraint.
- **Ops burden / deployment complexity**: broadly similar to Vercel (git-integrated, TLS automatic, env-var secrets) but the credit-system pricing shift makes this option less legible than Vercel's more granular Hobby limits for a low-ops decision. Not independently investigated further given two stronger, more clearly-specified free options (Workers, Lambda) already cover the same niche.
- **Fit for the current build**: no specific blocker found, but given the pricing-model ambiguity above and no compelling advantage over Vercel found in this pass, this document doesn't recommend spending more research time here unless Vercel is ruled out for some other reason.

### $5 VPS (e.g. Hetzner Cloud CX22)

- **Cold start**: none — an always-on process has no cold start by definition.
- **Cost**: Hetzner's smallest current shared-vCPU plan (`CX22`: 2 vCPU, 4GB RAM, 40GB disk) is listed at €3.79/month (~$4/month at typical EUR/USD rates) per Hetzner's own pricing pages, with hourly billing and no minimum contract; Hetzner also includes 20TB/month of free egress (per third-party summaries of Hetzner's own published terms — the live pricing page itself renders client-side and didn't yield plain-text figures in this pass, so the exact current CX22 price should be re-checked directly against [hetzner.com/cloud/pricing](https://www.hetzner.com/cloud/pricing/) before committing, since Hetzner has also announced region-specific price increases effective April 2026).
- **Ops burden**: this is the one option in the whole comparison with **real, standing ops burden**: OS patching, a reverse proxy (e.g. Caddy, which does get you free automatic TLS/Let's Encrypt renewal with minimal config), process supervision (systemd or similar) to keep the Node process running and restart it on crash/reboot, and your own monitoring/alerting if you want to know the receiver is actually up — none of that is provided for you the way it is on any of the managed platforms above. The GitHub Actions redelivery-workflow approach still applies here and remains the simplest choice even though the VPS *could* run its own cron.
- **Deployment complexity**: closest to "just run `node dist/index.js`" of any option — the existing esbuild output can run essentially unchanged behind a reverse proxy, no bundler/runtime-compatibility questions at all (it's real Node). But "closest to zero code change" trades directly against "most standing infrastructure to babysit," which is the opposite of what this document is optimizing for. Listed for completeness since the task asked for it, not recommended.

---

## Cost summary at low volume (a handful–few hundred events/month)

| Option | Monthly cost at this volume | Pricing accessed |
|---|---|---|
| AWS Lambda + Function URL | $0 (inside standing free tier) | 2026-09-01, [aws.amazon.com/lambda/pricing](https://aws.amazon.com/lambda/pricing/) |
| Cloudflare Workers | $0 (inside free tier; watch the 10ms-CPU/invocation cap) | 2026-08-28 per page, [developers.cloudflare.com/workers/platform/pricing](https://developers.cloudflare.com/workers/platform/pricing/) |
| Google Cloud Run | $0 (inside free tier) | 2026-09-01, [cloud.google.com/run/pricing](https://cloud.google.com/run/pricing) |
| Vercel Functions (Hobby) | $0 (inside free tier; non-commercial ToS) | 2026-06-16 per page, [vercel.com/docs/functions/usage-and-pricing](https://vercel.com/docs/functions/usage-and-pricing) |
| Fly.io (autostop/autostart) | Roughly low cents–~$1 (estimated; no confirmed intermittent-usage price) | 2026-09-01, [fly.io/docs/about/pricing](https://fly.io/docs/about/pricing/) |
| Deno Deploy | $0 (inside free tier) | 2026-09-01, [deno.com/deploy/pricing](https://deno.com/deploy/pricing) |
| Netlify Functions | Likely $0, imprecise due to credit-system pricing | 2026-09-01, [netlify.com/pricing](https://www.netlify.com/pricing/) |
| $5 VPS (Hetzner CX22 example) | ~$4/month flat, regardless of traffic | 2026-09-01 (search-corroborated; verify directly before committing) |

At this event volume, every managed serverless/edge option evaluated lands at $0/month — the deciding factors are cold-start risk, ops burden, and build-pipeline fit, not price. The VPS is the only option with a non-zero flat cost, and it's the one option that trades money for *less* infrastructure-provider risk (you own the whole stack) at the cost of *more* maintainer ops burden (you own the whole stack).

---

## Minimal viable architecture sketch

```
GitHub App webhook (pull_request_review_comment / issue_comment)
        │  POST, X-Hub-Signature-256, X-GitHub-Event headers
        ▼
Cloudflare Worker (or Lambda Function URL)
        │
        ├─ 1. Read raw body; compute HMAC-SHA256 over it using the
        │     webhook secret; compare against X-Hub-Signature-256 in
        │     constant time. Reject (401) on mismatch.
        │     (docs.github.com/.../validating-webhook-deliveries)
        │
        ├─ 2. Parse JSON body; read X-GitHub-Event for eventName.
        │     Build EventContext { eventName, payload, repo } —
        │     the exact same shape src/index.ts already defines.
        │
        ├─ 3. Sign a GitHub App JWT (RS256, from the App's private
        │     key, stored as a platform secret) and exchange it for
        │     an installation access token
        │     (POST /app/installations/{id}/access_tokens).
        │
        ├─ 4. Construct an Octokit satisfying src/octokit.ts's
        │     minimal Octokit type with that installation token.
        │
        └─ 5. Call handleEvent(octokit, context, options) — the
              existing, already-decoupled core — UNCHANGED.
              Respond 200 once it resolves.

Separately, decoupled from hosting choice:
GitHub Actions scheduled workflow (every 6h, per GitHub's own
example) → GET /app/hook/deliveries → redeliver anything that
never succeeded → POST /app/hook/deliveries/{id}/attempts
```

The only genuinely new code this requires beyond what already exists in `src/authorization.ts`, `src/followUpIssue.ts`, and `handleEvent` itself is steps 1–4 above: signature verification, JWT signing, and installation-token minting — none of which touch the core dispatch/authorization/issue-filing logic at all. `src/octokit.ts`'s comment about the minimal `Octokit` type existing so "tests can pass a plain fake object literal... no type assertion needed" continues to hold under this design without modification, since the App's Octokit instance still just needs to structurally satisfy that same minimal type.

---

## Sources

GitHub:
- [Handling webhook deliveries](https://docs.github.com/en/webhooks/using-webhooks/handling-webhook-deliveries)
- [Automatically redelivering failed deliveries for a GitHub App webhook](https://docs.github.com/en/webhooks/using-webhooks/automatically-redelivering-failed-deliveries-for-a-github-app-webhook)
- [Testing webhooks](https://docs.github.com/en/webhooks/testing-and-troubleshooting-webhooks/testing-webhooks)
- [Validating webhook deliveries](https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries)

AWS:
- [AWS Lambda pricing](https://aws.amazon.com/lambda/pricing/) (accessed 2026-09-01)
- [Lambda runtimes](https://docs.aws.amazon.com/lambda/latest/dg/lambda-runtimes.html) (accessed 2026-09-01)
- [Creating and managing Lambda function URLs](https://docs.aws.amazon.com/lambda/latest/dg/lambda-urls.html) (accessed 2026-09-01)
- [AWS Secrets Manager pricing](https://aws.amazon.com/secrets-manager/pricing/) (accessed 2026-09-01)
- [Benchmarking AWS Lambda Cold Starts Across JavaScript Runtimes](https://deno.com/blog/aws-lambda-coldstart-benchmarks) (Deno-authored benchmark of Lambda; cited for cold-start figures where AWS's own docs don't publish absolute latency numbers)

Cloudflare:
- [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/) (page's own "Last Updated: August 28, 2026")
- [How Workers works](https://developers.cloudflare.com/workers/reference/how-workers-works/) (accessed 2026-09-01)
- [Node.js compatibility in Workers](https://developers.cloudflare.com/workers/runtime-apis/nodejs/) (accessed 2026-09-01)
- [Workers secrets](https://developers.cloudflare.com/workers/configuration/secrets/) (accessed 2026-09-01)
- [Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/) (accessed 2026-09-01)
- [Web Crypto API](https://developers.cloudflare.com/workers/runtime-apis/web-crypto/) (accessed 2026-09-01)

Google Cloud:
- [Cloud Run pricing](https://cloud.google.com/run/pricing) (accessed 2026-09-01)
- [About instance autoscaling](https://docs.cloud.google.com/run/docs/about-instance-autoscaling) (accessed 2026-09-01)

Vercel:
- [Functions usage and pricing](https://vercel.com/docs/functions/usage-and-pricing) (page's own `last_updated: 2026-06-16`)
- [Cron Jobs](https://vercel.com/docs/cron-jobs) (page's own `last_updated: 2026-08-11`)
- [Cron Jobs usage and pricing](https://vercel.com/docs/cron-jobs/usage-and-pricing) (page's own `last_updated: 2026-07-15`)

Fly.io:
- [Fly.io pricing](https://fly.io/docs/about/pricing/) (accessed 2026-09-01)
- [Autostop/autostart Machines](https://fly.io/docs/launch/autostop-autostart/) (accessed 2026-09-01)

Deno Deploy:
- [Deno Deploy pricing](https://deno.com/deploy/pricing) (accessed 2026-09-01)

Netlify:
- [Netlify pricing](https://www.netlify.com/pricing/) (accessed 2026-09-01)

Hetzner (VPS reference option):
- [Hetzner Cloud pricing](https://www.hetzner.com/cloud/pricing/) — the live page renders pricing client-side and did not yield plain-text figures via automated fetch in this pass; the CX22 (~€3.79/month) figure in this document is search-engine-corroborated from Hetzner's own domain rather than directly quoted from a fetched page, and should be re-verified against the live page before being relied on for a purchase decision.

Repo-internal:
- `dfadler/issue-bot` issue [#28](https://github.com/dfadler/issue-bot/issues/28) — prior App-vs-Action investigation this document builds on
- `src/index.ts`, `src/authorization.ts`, `src/octokit.ts`, `action.yml`, `package.json` — current codebase structure referenced throughout
