#!/usr/bin/env node
/**
 * career-path end-to-end evaluator.
 *
 *   node run-eval.mjs [--mutation=stale-build|hang-tailor] [options]
 *
 * What this is for: this project's characteristic failure is a feature that is
 * green in 391 unit tests, green in tsc/lint/build, deployed successfully, and
 * broken in a real browser. Nothing short of a real Chromium with the real
 * extension loaded, a real Clerk session, and a real generate can tell those
 * apart. This harness builds that situation and asserts the ONE thing that
 * cannot be faked from inside the code under test: after a signed-in user
 * clicks "Tailor my resume", does the signed-in user's own allowance go down?
 *
 * The verdict of the no-mutation run is NOT the success criterion for the
 * harness. A well-evidenced FAIL is exactly as useful as a PASS; what matters
 * is that the measurement is real, and the two mutation modes exist to prove
 * this harness can produce a FAIL when the product is broken.
 *
 * Nothing here modifies product code. Everything lives under evaluator/.
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { launchBrowser, extensionIdFor, waitForServiceWorker } from "./lib/browser.mjs";
import { ensureTestUser, readClerkSecret, TEST_EMAIL } from "./lib/clerkTestUser.mjs";
import { DevServer, waitForApi } from "./lib/devserver.mjs";
import { FixtureServer } from "./lib/fixtureserver.mjs";
import {
  clickPrimary,
  panelText,
  panelUrl,
  primaryButtonLabel,
  readAccount,
  readBetaCode,
  readQuotaLine,
  readRunStores,
  readScoreLine,
  seedResume,
  signinUrl,
  signOutViaPanel,
  waitForJd,
  waitForRunOutcome,
} from "./lib/panel.mjs";
import { RecordingProxy } from "./lib/proxy.mjs";
import { computeVerdict, writeReport } from "./lib/report.mjs";
import { signIn } from "./lib/signin.mjs";
import { buildStaleExtension, cleanupStaleBuild } from "./lib/staleBuild.mjs";

const run = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..");
const EXT_DIR = path.join(REPO_ROOT, "extension");
const REPORTS_DIR = path.join(HERE, "reports");
const PROFILE_ROOT = path.join(HERE, "profile");
const WORK_DIR = path.join(HERE, ".work");

/** The last commit before the extension side learned about run tokens. */
const STALE_REF = "d19021d";

// Above parseArgs's call site: `parseArgs` runs at module top level (line ~70),
// so a `const` declared any later is still in its temporal dead zone when
// --help or an unknown argument tries to print it.
const HELP = `
Usage: node run-eval.mjs [options]

  --mutation=stale-build   build the extension from ${STALE_REF} (before the panel
                           minted run tokens) and load that. MUST produce FAIL.
  --mutation=hang-tailor   hold POST /api/tailor open and never answer it.
                           MUST produce a timeout FAIL.
  --headed                 run Chromium headed (default: new headless).
  --stub-llm               answer parse-jd/analyze/tailor from the proxy with
                           canned JSON. Spends no OpenRouter money, charges no
                           quota, and therefore ALWAYS reports CANNOT_MEASURE.
                           For debugging this harness only.
  --skip-anonymous         skip A6 (saves one paid generate).
  --run-timeout-ms=N       A5's ceiling (default 180000).
  --rescore-timeout-ms=N   A7's ceiling for the rescore leg (default 90000).
`;

const JD_TITLE = "Backend Engineer, Billing";

const options = parseArgs(process.argv.slice(2));

/** Replaced by main() once there is anything to tear down. */
let teardown = async () => {};

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const logLines = [];
function log(message) {
  const line = `[${new Date().toISOString()}] ${message}`;
  logLines.push(line);
  process.stdout.write(line + "\n");
}

function parseArgs(argv) {
  const out = {
    mutation: null,
    headless: true,
    stubLlm: false,
    runTimeoutMs: 180_000,
    devPort: 3001,
    apiPort: 3000,
    fixturePort: 4599,
    skipAnonymous: false,
    maxGenerates: 4,
    // A7's own ceiling, separate from A5's on purpose. The rescore is a fourth
    // model call that starts only after the run is already on screen, so it
    // buys nothing to fold it into the latency budget for first paint — but it
    // still has to land, and within a time a user would plausibly still have
    // the panel open.
    rescoreTimeoutMs: 90_000,
  };
  for (const arg of argv) {
    if (arg.startsWith("--mutation=")) out.mutation = arg.slice("--mutation=".length);
    else if (arg === "--headed") out.headless = false;
    else if (arg === "--stub-llm") out.stubLlm = true;
    else if (arg === "--skip-anonymous") out.skipAnonymous = true;
    else if (arg.startsWith("--run-timeout-ms=")) out.runTimeoutMs = Number(arg.split("=")[1]);
    else if (arg.startsWith("--rescore-timeout-ms=")) out.rescoreTimeoutMs = Number(arg.split("=")[1]);
    else if (arg.startsWith("--dev-port=")) out.devPort = Number(arg.split("=")[1]);
    else if (arg.startsWith("--fixture-port=")) out.fixturePort = Number(arg.split("=")[1]);
    else if (arg === "--help" || arg === "-h") {
      process.stdout.write(HELP);
      process.exit(0);
    } else {
      process.stderr.write(`unknown argument: ${arg}\n${HELP}`);
      process.exit(2);
    }
  }
  if (out.mutation && !["stale-build", "hang-tailor"].includes(out.mutation)) {
    process.stderr.write(`unknown mutation: ${out.mutation}\n${HELP}`);
    process.exit(2);
  }
  return out;
}

async function main() {
  const started = Date.now();
  const report = {
    startedAt: new Date().toISOString(),
    mutation: options.mutation,
    verdict: "CANNOT_MEASURE",
    config: {
      distDir: null,
      extensionId: null,
      headless: options.headless,
      stubLlm: options.stubLlm,
      runTimeoutMs: options.runTimeoutMs,
      rescoreTimeoutMs: options.rescoreTimeoutMs,
      apiOrigin: `http://localhost:${options.apiPort}`,
      devServerPort: options.devPort,
      staleRef: options.mutation === "stale-build" ? STALE_REF : null,
    },
    preflight: {},
    assertions: {},
    quota: {},
    apiRequests: [],
    timings: {},
    screenshots: [],
    notes: [],
    generatesSpent: 0,
    fatal: null,
    durationMs: 0,
  };

  const screenshotsDir = path.join(REPORTS_DIR, `${stamp}-shots`);
  await mkdir(screenshotsDir, { recursive: true });

  let devServer = null;
  let proxy = null;
  let fixtures = null;
  let context = null;
  let staleWorktree = null;
  const profileDir = path.join(PROFILE_ROOT, stamp);

  // Assigned to the module-level hook so an interrupt tears the same things
  // down that the finally block would.
  teardown = async () => {
    if (context) await context.close().catch(() => {});
    if (proxy) await proxy.stop().catch(() => {});
    if (fixtures) await fixtures.stop().catch(() => {});
    if (devServer) await devServer.stop().catch(() => {});
    if (staleWorktree) await cleanupStaleBuild(REPO_ROOT, staleWorktree, log).catch(() => {});
    await rm(profileDir, { recursive: true, force: true }).catch(() => {});
    context = proxy = fixtures = devServer = staleWorktree = null;
  };

  const shot = async (page, name) => {
    if (!page || page.isClosed()) return;
    const file = path.join(screenshotsDir, `${name}.png`);
    try {
      await page.screenshot({ path: file, fullPage: true });
      report.screenshots.push(path.relative(REPORTS_DIR, file));
    } catch (err) {
      log(`screenshot ${name} failed: ${err.message}`);
    }
  };

  try {
    // ---------------------------------------------------------------- P1
    let distDir = path.join(EXT_DIR, "dist");
    if (options.mutation === "stale-build") {
      const stale = await buildStaleExtension({
        repoRoot: REPO_ROOT,
        ref: STALE_REF,
        workDir: WORK_DIR,
        log,
      });
      distDir = stale.dist;
      staleWorktree = stale.worktree;
    } else {
      log("building the extension dev build (npm run build:dev)");
      await run("npm", ["run", "build:dev"], { cwd: EXT_DIR, maxBuffer: 32 * 1024 * 1024 });
    }
    report.config.distDir = distDir;

    const greps = await grepDist(distDir);
    const freshnessOk = greps.runToken.length > 0 && greps.localhost.length > 0;
    if (options.mutation === "stale-build") {
      // The mutation IS a stale build, so the freshness check is expected to
      // fail. Record what it saw as evidence, but do not gate on it — gating
      // would turn the self-falsification run into CANNOT_MEASURE and hide
      // the FAIL the mutation exists to produce.
      report.preflight.P1 = {
        status: "N/A",
        evidence: {
          note: `mutation stale-build: dist built from ${STALE_REF}, freshness check is expected to fail and is not gating`,
          runTokenHits: greps.runToken,
          localhostHits: greps.localhost,
        },
      };
      report.notes.push(
        `P1 not gating under --mutation=stale-build; "api/run-token" present in dist: ${greps.runToken.length > 0}`,
      );
    } else {
      report.preflight.P1 = {
        status: freshnessOk ? "PASS" : "FAIL",
        evidence: {
          distDir,
          runTokenHits: greps.runToken,
          localhostHits: greps.localhost,
        },
      };
    }

    // ---------------------------------------------------------------- servers
    fixtures = new FixtureServer({
      port: options.fixturePort,
      htmlPath: path.join(HERE, "fixtures", "jd.html"),
    });
    await fixtures.start();
    log(`fixture server on 127.0.0.1:${options.fixturePort}, serving ${fixtures.url}`);

    proxy = new RecordingProxy({ listenPort: options.apiPort, targetPort: options.devPort });
    if (options.mutation === "hang-tailor") proxy.hang(["/api/tailor"]);
    if (options.stubLlm) proxy.stub = stubResponder;
    await proxy.start();
    log(`recording proxy on :${options.apiPort} -> dev server :${options.devPort}`);

    devServer = new DevServer({ repoRoot: REPO_ROOT, port: options.devPort, log });
    await devServer.start();
    log("dev server starting…");

    // ---------------------------------------------------------------- P2
    const apiOrigin = `http://localhost:${options.apiPort}`;
    const ready = await waitForApi(apiOrigin, 180_000, log);
    report.preflight.P2 = {
      status: ready.ok ? "PASS" : "FAIL",
      evidence: ready.ok
        ? `GET ${apiOrigin}/api/quota -> ${ready.status} ${ready.body}`
        : `dev server never became ready: ${ready.error}\n${devServer.tail(15)}`,
    };
    if (!ready.ok) throw new Error("dev server never became ready");

    // ---------------------------------------------------------------- Clerk
    const secret = await readClerkSecret(REPO_ROOT);
    if (!secret) throw new Error("CLERK_SECRET_KEY not found in .env.local");
    const user = await ensureTestUser(secret, log);
    if (!user.ok) throw new Error(`could not ensure the Clerk test user: ${user.error}`);
    report.config.clerkUserId = user.userId;

    // ---------------------------------------------------------------- browser
    const extensionId = await extensionIdFor(distDir);
    report.config.extensionId = extensionId;
    log(`extension id derived from manifest key: ${extensionId}`);

    context = await launchWithFallback(profileDir, distDir, report);
    const worker = await waitForServiceWorker(context, 30_000).catch(() => null);
    report.notes.push(
      worker
        ? `extension service worker: ${worker.url()}`
        : "no extension service worker seen within 30s",
    );
    if (worker && !worker.url().includes(extensionId)) {
      report.notes.push(
        `WARNING: service worker URL does not carry the derived extension id (${worker.url()})`,
      );
    }

    // ---------------------------------------------------------------- P4 sign-in
    const signinPage = context.pages()[0] ?? (await context.newPage());
    const signInResult = await signIn({
      page: signinPage,
      signinUrl: signinUrl(extensionId),
      shot: (name) => shot(signinPage, name),
      log,
    });
    report.timings.signInMs = Date.now() - started;
    if (!signInResult.ok) {
      report.preflight.P4 = {
        status: "FAIL",
        evidence: `Clerk test-mode sign-in failed at stage "${signInResult.stage}": ${signInResult.error}`,
      };
      throw new Error(`sign-in failed: ${signInResult.error}`);
    }
    log("signed in via Clerk test mode");

    // ---------------------------------------------------------------- seed + tabs
    const storedResume = JSON.parse(
      await readFile(path.join(HERE, "fixtures", "resume.json"), "utf8"),
    );
    // The sign-in page closed itself on some Chromium builds; any extension
    // page can write chrome.storage, so fall back to a fresh one.
    const seedPage = signinPage.isClosed() ? await context.newPage() : signinPage;
    if (seedPage !== signinPage) await seedPage.goto(signinUrl(extensionId));
    await seedResume(seedPage, storedResume);
    log("seeded cp_resume into chrome.storage.local");

    const jdPage = await context.newPage();
    await jdPage.goto(fixtures.url, { waitUntil: "domcontentloaded" });

    const panelPage = await context.newPage();
    const panelRequests = [];
    panelPage.on("response", (res) => {
      const url = res.url();
      if (url.includes("/api/")) {
        panelRequests.push({ url, status: res.status(), method: res.request().method() });
      }
    });
    await panelPage.goto(panelUrl(extensionId), { waitUntil: "domcontentloaded" });

    // The JD tab must be the ACTIVE one — see lib/panel.mjs for why.
    await jdPage.bringToFront();
    const jdSeen = await waitForJd(panelPage, JD_TITLE, 45_000);
    report.notes.push(`panel JD read: ${JSON.stringify(jdSeen)}`);
    if (!jdSeen.ok) {
      report.preflight.P3 = {
        status: "FAIL",
        evidence: `panel never extracted the JD fixture; header showed ${JSON.stringify(jdSeen)}`,
      };
      await shot(panelPage, "panel-no-jd");
      throw new Error("panel never extracted the JD fixture");
    }

    // ---------------------------------------------------------------- P3 / P4
    const betaCode = await readBetaCode(panelPage);
    // The panel clears its allowance to null before every GET /api/quota (see
    // App.tsx's refreshQuota), so a read taken the instant the JD lands can
    // legitimately find "unknown". Wait for the number rather than treating
    // that intermediate state as the answer.
    const quotaBefore = await pollQuota(panelPage, (q) => q.remaining !== null, 30_000);
    report.quota.beforeSignedInRun = { kind: quotaBefore.kind, remaining: quotaBefore.remaining, line: quotaBefore.line };

    const account = await readAccount(panelPage);
    report.preflight.P4 = {
      status: account.signedIn && account.emailShown ? "PASS" : "FAIL",
      evidence: `panel account block: signedIn=${account.signedIn}, shows ${TEST_EMAIL}=${account.emailShown}`,
    };

    const p3Ok =
      betaCode === null && quotaBefore.kind === "daily" && quotaBefore.remaining === 5;
    report.preflight.P3 = {
      status: p3Ok ? "PASS" : "FAIL",
      evidence: {
        cp_beta_code: betaCode,
        quotaLine: quotaBefore.line,
        kind: quotaBefore.kind,
        remaining: quotaBefore.remaining,
        expected: 'a numeric daily allowance of 5 ("5 runs left today")',
      },
    };

    await shot(panelPage, "panel-01-before-click");
    await jdPage.bringToFront();
    await waitForJd(panelPage, JD_TITLE, 20_000);

    // ---------------------------------------------------------------- A1/A2/A3/A5
    const beforeStores = await readRunStores(panelPage);
    const knownGeneratedAt = Object.values(beforeStores.results)
      .map((r) => r.generatedAt)
      .filter(Boolean);

    if (report.generatesSpent >= options.maxGenerates) throw new Error("generate budget exhausted");
    const clickAt = Date.now();
    const clicked = await clickPrimary(panelPage);
    report.generatesSpent += 1;
    log(`clicked the primary button: ${JSON.stringify(clicked)}`);
    if (!clicked.clicked) {
      report.notes.push(`primary button was not clickable: ${clicked.reason}`);
    }

    const outcome = await waitForRunOutcome(panelPage, options.runTimeoutMs, {
      knownGeneratedAt,
    });
    report.timings.signedInRunMs = outcome.elapsedMs;
    report.notes.push(`signed-in run phases: ${JSON.stringify(outcome.phases)}`);
    log(`signed-in run outcome=${outcome.outcome} in ${outcome.elapsedMs}ms`);

    // A1 — did the panel mint a run token?
    const runTokenCalls = proxy.records_for("/api/run-token");
    const panelRunTokenResponses = panelRequests.filter((r) => r.url.includes("/api/run-token"));
    const mintedToken = runTokenCalls.find((r) => r.status === 200 && r.facts?.hasToken);
    report.assertions.A1 = {
      status: mintedToken ? "PASS" : "FAIL",
      evidence: {
        proxyRecords: runTokenCalls.map(summarizeRecord),
        panelPageResponses: panelRunTokenResponses,
        tokenInResponse: Boolean(mintedToken),
        note: runTokenCalls.length === 0
          ? "the panel never issued POST /api/run-token at all"
          : undefined,
      },
    };

    // A2 — what identity did the WORKER's requests actually carry?
    const analyzeCalls = proxy.records_for("/api/analyze");
    const workerCalls = proxy.records.filter((r) => r.realm === "worker");
    const a2 = judgeIdentity(analyzeCalls, workerCalls);
    report.assertions.A2 = a2;

    // A5 — latency ceiling.
    report.assertions.A5 = {
      status: outcome.outcome === "done" ? "PASS" : "FAIL",
      evidence: {
        outcome: outcome.outcome,
        elapsedMs: outcome.elapsedMs,
        ceilingMs: options.runTimeoutMs,
        phases: outcome.phases,
        runError: outcome.error ?? null,
      },
    };

    // A3 — the end-to-end observable outcome.
    const a3 = await measureQuotaDrop({
      page: panelPage,
      jdPage,
      before: quotaBefore,
      proxy,
      log,
    });
    report.quota.afterSignedInRun = a3.after;
    report.assertions.A3 = a3.assertion;

    await shot(panelPage, "panel-02-after-run");
    await jdPage.bringToFront();
    await waitForJd(panelPage, JD_TITLE, 20_000);

    // ---------------------------------------------------------------- A7
    //
    // Before A4, deliberately. Signing out navigates the panel away and puts
    // the caller on a different identity; the rescore leg belongs to the run
    // that is still settling and has to be observed while the signed-in panel
    // is still the thing on screen.
    if (outcome.outcome !== "done") {
      report.assertions.A7 = {
        status: "SKIPPED",
        evidence: "the signed-in run never reached a terminal state, so no rescore was ever fired",
      };
    } else {
      report.assertions.A7 = await measureRescore({
        page: panelPage,
        proxy,
        analyzeCalls,
        quotaBefore,
        clickAt,
        apiOrigin,
        timeoutMs: options.rescoreTimeoutMs,
        log,
      });
      report.timings.rescoreCallMs = report.assertions.A7.evidence?.rescoreCallMs ?? null;
      report.timings.msFromClickToRescoreSettled =
        report.assertions.A7.evidence?.msFromClickToRescoreSettled ?? null;
      await shot(panelPage, "panel-02b-after-rescore");
      await jdPage.bringToFront();
      await waitForJd(panelPage, JD_TITLE, 45_000);
      // A7 reloads the panel to force a fresh allowance read, and Clerk is
      // re-checked asynchronously on mount. A4 signs out through a button that
      // does not exist until that check lands, so wait for the account block
      // rather than handing A4 a panel that merely looks signed out.
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline) {
        if ((await readAccount(panelPage)).signedIn) break;
        await panelPage.waitForTimeout(700);
      }
    }

    // ---------------------------------------------------------------- A4
    if (outcome.outcome === "timeout") {
      report.assertions.A4 = {
        status: "SKIPPED",
        evidence: "the run never reached a terminal state, so the panel's Sign out stays disabled",
      };
      report.assertions.A6 = {
        status: "SKIPPED",
        evidence: "not attempted: the signed-in run never finished",
      };
    } else {
      const signedOut = await signOutViaPanel(panelPage);
      log(`sign-out: ${JSON.stringify(signedOut)}`);
      let deviceQuota = null;
      if (signedOut.ok) {
        if (signedOut.navigatedAway) {
          // lib/clerk.ts signs out with a redirectUrl, so the panel tab is now
          // showing the sign-in page. Reopening the panel is what the user
          // does next, and it re-reads GET /api/quota on mount — this time as
          // the device caller.
          log("panel navigated to the sign-in page on sign-out; reopening the panel");
          await panelPage.goto(panelUrl(extensionId), { waitUntil: "domcontentloaded" });
          await jdPage.bringToFront();
          await waitForJd(panelPage, JD_TITLE, 45_000);
        }
        deviceQuota = await pollQuota(panelPage, (q) => q.remaining !== null, 30_000);
        report.quota.afterSignOut = {
          kind: deviceQuota.kind,
          remaining: deviceQuota.remaining,
          line: deviceQuota.line,
        };
      }
      const deviceTokenCalls = proxy.records_for("/api/device-token");
      const workerCarriedDid = workerCalls.some((r) => r.authorization?.kind === "device-token(did)");
      report.assertions.A4 = {
        status: !signedOut.ok
          ? "UNMEASURED"
          : deviceQuota?.remaining === 3
            ? "PASS"
            : "FAIL",
        evidence: {
          signOut: signedOut,
          deviceQuotaLine: deviceQuota?.line ?? null,
          deviceRemaining: deviceQuota?.remaining ?? null,
          expected: 3,
          deviceTokenMints: deviceTokenCalls.map(summarizeRecord),
          workerRequestsCarriedDeviceToken: workerCarriedDid,
        },
      };

      await shot(panelPage, "panel-03-signed-out");
      await jdPage.bringToFront();
      await waitForJd(panelPage, JD_TITLE, 20_000);

      // ------------------------------------------------------------- A6
      if (options.skipAnonymous) {
        report.assertions.A6 = { status: "SKIPPED", evidence: "--skip-anonymous" };
      } else if (report.generatesSpent >= options.maxGenerates) {
        report.assertions.A6 = { status: "SKIPPED", evidence: "generate budget exhausted" };
      } else if (!signedOut.ok) {
        report.assertions.A6 = { status: "UNMEASURED", evidence: "could not sign out" };
      } else {
        const anonBefore = await readRunStores(panelPage);
        const anonKnown = Object.values(anonBefore.results)
          .map((r) => r.generatedAt)
          .filter(Boolean);
        const anonClicked = await clickPrimary(panelPage);
        report.generatesSpent += 1;
        log(`anonymous run click: ${JSON.stringify(anonClicked)}`);
        const anonOutcome = await waitForRunOutcome(panelPage, options.runTimeoutMs, {
          knownGeneratedAt: anonKnown,
        });
        report.timings.anonymousRunMs = anonOutcome.elapsedMs;
        let anonQuota = await pollQuota(
          panelPage,
          (q) => q.remaining !== null && q.remaining < 3,
          30_000,
        );
        let anonReopened = false;
        if (!(anonQuota.remaining !== null && anonQuota.remaining < 3)) {
          // Same fallback as A3: reopening the panel is what a user does, and
          // it re-reads GET /api/quota on mount. It separates "the device
          // bucket was not charged" from "the panel did not repaint".
          log("device allowance unchanged after the anonymous run; reopening the panel");
          await panelPage.reload({ waitUntil: "domcontentloaded" });
          await jdPage.bringToFront();
          await waitForJd(panelPage, JD_TITLE, 30_000).catch(() => {});
          anonQuota = await pollQuota(panelPage, (q) => q.remaining !== null, 25_000);
          anonReopened = true;
        }
        report.quota.afterAnonymousRun = {
          kind: anonQuota.kind,
          remaining: anonQuota.remaining,
          line: anonQuota.line,
        };
        report.assertions.A6 = {
          status:
            anonOutcome.outcome === "done" && anonQuota.remaining === 2 ? "PASS" : "FAIL",
          evidence: {
            clicked: anonClicked,
            outcome: anonOutcome.outcome,
            elapsedMs: anonOutcome.elapsedMs,
            phases: anonOutcome.phases,
            deviceQuotaAfter: anonQuota.line,
            panelWasReopened: anonReopened,
            expected: 'run completes and the device trial reads "2 runs left"',
            runError: anonOutcome.error ?? null,
          },
        };
        await shot(panelPage, "panel-04-after-anonymous-run");
      }
    }

    report.notes.push(`panel-page API responses observed: ${JSON.stringify(panelRequests)}`);
    report.panelFinalText = await panelText(panelPage).catch(() => null);
    report.buttonFinal = await primaryButtonLabel(panelPage).catch(() => null);
  } catch (err) {
    report.fatal = err instanceof Error ? `${err.message}\n${err.stack}` : String(err);
    log(`FATAL: ${report.fatal}`);
  } finally {
    if (proxy) report.apiRequests = proxy.records.map(summarizeRecord);
    report.durationMs = Date.now() - started;

    for (const id of ["P1", "P2", "P3", "P4"]) {
      report.preflight[id] ??= { status: "FAIL", evidence: "never reached" };
    }
    for (const id of ["A1", "A2", "A3", "A4", "A5", "A6", "A7"]) {
      report.assertions[id] ??= { status: "UNMEASURED", evidence: "never reached" };
    }
    report.verdict = options.stubLlm
      ? "CANNOT_MEASURE"
      : computeVerdict(report.preflight, report.assertions);
    if (options.stubLlm) {
      report.notes.push(
        "--stub-llm was set: parse-jd/analyze/tailor were answered by the proxy, no quota was charged, so this run says nothing about the product.",
      );
    }

    await teardown();

    report.log = logLines;
    const written = await writeReport(REPORTS_DIR, stamp, report);
    process.stdout.write(
      `\nVERDICT: ${report.verdict}\n  ${written.jsonPath}\n  ${written.mdPath}\n`,
    );
    process.exitCode = report.verdict === "PASS" ? 0 : 1;
  }
}

/** New headless first (it supports MV3 extensions); headed is the fallback. */
async function launchWithFallback(profileDir, distDir, report) {
  const attempt = async (headless) =>
    launchBrowser({
      profileDir,
      distDir,
      fixturePort: options.fixturePort,
      headless,
      log,
    });
  if (!options.headless) {
    report.config.headless = false;
    return attempt(false);
  }
  try {
    const context = await attempt(true);
    // A context with no extension service worker within a few seconds is the
    // symptom of headless refusing to load the extension.
    const worker = await waitForServiceWorker(context, 15_000).catch(() => null);
    if (worker) return context;
    log("headless produced no extension service worker; falling back to headed");
    await context.close().catch(() => {});
  } catch (err) {
    log(`headless launch failed (${err.message}); falling back to headed`);
  }
  report.config.headless = false;
  report.notes.push("fell back to headed Chromium: the new headless mode did not load the extension");
  await rm(profileDir, { recursive: true, force: true }).catch(() => {});
  return attempt(false);
}

/**
 * A3, the assertion the whole harness exists for.
 *
 * The number the PANEL states is the primary signal, because that is what the
 * user sees. The proxy's copy of the server's own answers is recorded
 * alongside it so a UI-refresh problem can be told apart from a billing
 * problem.
 */
async function measureQuotaDrop({ page, jdPage, before, proxy, log }) {
  let after = await pollQuota(
    page,
    (q) => q.remaining !== null && q.remaining !== before.remaining,
    25_000,
  );
  let reopened = false;
  if (after.remaining === before.remaining || after.remaining === null) {
    // The panel may simply have missed its refresh window. Reopening the panel
    // is what a user would do, and it re-reads GET /api/quota on mount — so
    // this distinguishes "the server did not charge" from "the panel did not
    // repaint". Recorded either way.
    log("panel allowance unchanged; reloading the panel and re-reading");
    await page.reload({ waitUntil: "domcontentloaded" });
    await jdPage.bringToFront();
    await waitForJd(page, JD_TITLE, 30_000).catch(() => {});
    after = await pollQuota(page, (q) => q.remaining !== null, 25_000);
    reopened = true;
  }

  const serverRemaining = proxy.records
    .filter((r) => ["/api/analyze", "/api/tailor", "/api/quota"].includes(r.path))
    .map((r) => ({
      path: r.path,
      status: r.status,
      remaining: r.facts?.remaining ?? null,
      limit: r.facts?.limit ?? null,
      used: r.facts?.used ?? null,
    }));

  const expected = before.remaining === null ? null : before.remaining - 1;
  const pass =
    before.kind === "daily" &&
    after.kind === "daily" &&
    expected !== null &&
    after.remaining === expected;

  return {
    after: { kind: after.kind, remaining: after.remaining, line: after.line },
    assertion: {
      status: pass ? "PASS" : "FAIL",
      evidence: {
        panelBefore: before.line,
        panelAfter: after.line,
        expectedAfter: expected === null ? null : `${expected} runs left today`,
        panelWasReopened: reopened,
        serverReportedRemaining: serverRemaining,
      },
    },
  };
}

/**
 * A7 — the tailored resume is re-measured with analyze's own instrument, that
 * measurement costs no quota, and it is the number the user ends up reading.
 *
 * Four separate things, because three of them can be true while the fourth is
 * the bug:
 *
 *  1. The request happened, succeeded, and travelled under the SAME identity
 *     as the run's other legs. A rescore that fell back to the device token
 *     would 403 against the marker gate (the marker is keyed on the caller),
 *     so this is also what proves the marker gate is being satisfied honestly
 *     rather than bypassed.
 *  2. The allowance moved by exactly one for the whole generate. The rescore
 *     is a fourth model call and the entire billing claim is that it is free;
 *     a stray consumeRun in that route is invisible in unit tests that mock
 *     the store and immediately visible here.
 *  3. The panel's AFTER number equals the score in the response body. This is
 *     the assertion the whole feature exists for — a rescore that lands on
 *     the wire and never reaches the DOM leaves the product shipping the old
 *     self-assessed number while the logs say otherwise.
 *  4. A forged runId is refused. The route trades quota for a marker check;
 *     if that check is wrong, career-path is running a free public LLM
 *     endpoint and nothing in the product would look broken.
 */
async function measureRescore({
  page,
  proxy,
  analyzeCalls,
  quotaBefore,
  clickAt,
  apiOrigin,
  timeoutMs,
  log,
}) {
  // (1) Wait for the leg to settle on the wire.
  const deadline = Date.now() + timeoutMs;
  let record = null;
  while (Date.now() < deadline) {
    record = proxy.records_for("/api/rescore").find((r) => r.status !== null) ?? null;
    if (record) break;
    await page.waitForTimeout(1000);
  }
  // TWO different latencies, and conflating them is how a report ends up
  // claiming a 96-second rescore against a 90-second ceiling on a run that
  // passed. `rescoreCallMs` is the leg itself — what the ceiling is about, and
  // what a user waits through AFTER their result is already on screen.
  // `msFromClickToRescoreSettled` is the whole generate plus that leg, useful
  // only as context and never compared against anything.
  const rescoreCallMs = record?.durationMs ?? null;
  const msFromClickToRescoreSettled = record ? record.at + (record.durationMs ?? 0) - clickAt : null;

  if (!record) {
    return {
      status: "FAIL",
      evidence: {
        note: "no POST /api/rescore reached the proxy within the ceiling",
        ceilingMs: timeoutMs,
        rescoreCallMs: null,
        msFromClickToRescoreSettled: null,
        seenPaths: [...new Set(proxy.records.map((r) => r.path))],
      },
    };
  }
  log(`rescore landed: status=${record.status} score=${record.facts?.score ?? null}`);

  // (2) The panel's own number. Poll: the request settling on the wire and the
  // worker publishing the patch the panel reads are two different moments.
  const target = record.facts?.score ?? null;
  let score = await readScoreLine(page);
  const scoreDeadline = Date.now() + 30_000;
  while (Date.now() < scoreDeadline && score.after !== target) {
    await page.waitForTimeout(700);
    score = await readScoreLine(page);
  }

  // (3) The allowance, re-read AFTER the rescore has landed.
  //
  // The panel is RELOADED first, and that is not incidental: nothing in the
  // product refetches the allowance just because a rescore landed (correctly —
  // the rescore does not change it), so without a forced remount the newest
  // `GET /api/quota` on the wire could predate the charge entirely and the
  // `used` evidence below would describe the moment before the run. A mount is
  // what a returning user does, and it re-reads the count.
  await page.reload({ waitUntil: "domcontentloaded" });
  const quotaAfterRescore = await pollQuota(page, (q) => q.remaining !== null, 25_000);
  // Only the signed-in panel's own reads: an anonymous read taken before
  // sign-in and a device read taken after sign-out describe different buckets,
  // and averaging across them would compare two allowances rather than
  // measuring one.
  const usedReadings = proxy
    .records_for("/api/quota")
    .filter((r) => r.authorization?.kind === "clerk-session" && r.facts?.used !== undefined)
    .map((r) => r.facts.used);
  const usedDelta =
    usedReadings.length >= 2 ? usedReadings.at(-1) - usedReadings[0] : null;

  // (4) The forged-runId probe. Sent through the proxy so it lands in the
  // traffic table like everything else, and with no Authorization header —
  // the weakest possible caller, which is exactly who would be abusing this.
  const forgedRunId = `forged-${Math.random().toString(16).slice(2)}`;
  let forged = { status: null, error: null };
  try {
    const res = await fetch(`${apiOrigin}/api/rescore`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        structuredResume: { contact: { name: "Forged" } },
        structuredJD: { company: "Forged" },
        quality: "quality",
        runId: forgedRunId,
      }),
    });
    forged = { status: res.status, body: (await res.text()).slice(0, 200) };
  } catch (err) {
    forged = { status: null, error: err.message };
  }
  log(`forged-runId probe: ${JSON.stringify(forged)}`);

  const analyzeUid = analyzeCalls.find((r) => r.authorization?.claims?.uid)?.authorization?.claims
    ?.uid ?? null;
  const rescoreUid = record.authorization?.claims?.uid ?? null;
  const identityMatches = Boolean(analyzeUid) && rescoreUid === analyzeUid;
  // "Unchanged BY THE RESCORE" — the generate itself is supposed to cost one
  // unit, so the allowance is expected to be exactly one lower than before the
  // click and no lower than that.
  const quotaUnchanged =
    quotaBefore.remaining !== null &&
    quotaAfterRescore.remaining === quotaBefore.remaining - 1 &&
    usedDelta === 1;
  const forgedRefused = typeof forged.status === "number" && forged.status >= 400 && forged.status < 500;
  const panelShowsRescore = target !== null && score.after === target;

  const pass =
    record.status === 200 &&
    identityMatches &&
    quotaUnchanged &&
    forgedRefused &&
    panelShowsRescore;

  return {
    status: pass ? "PASS" : "FAIL",
    evidence: {
      rescoreRequest: summarizeRecord(record),
      rescoreCallMs,
      msFromClickToRescoreSettled,
      ceilingMs: timeoutMs,
      withinCeiling: rescoreCallMs !== null && rescoreCallMs <= timeoutMs,
      identity: { analyzeUid, rescoreUid, matches: identityMatches },
      quota: {
        before: quotaBefore.line,
        afterRescore: quotaAfterRescore.line,
        expectedAfter:
          quotaBefore.remaining === null ? null : `${quotaBefore.remaining - 1} runs left today`,
        signedInUsedReadings: usedReadings,
        usedDelta,
        note: "the rescore leg must charge nothing: one generate is still one unit",
      },
      panel: {
        line: score.line,
        after: score.after,
        rescoreResponseScore: target,
        matches: panelShowsRescore,
      },
      forgedRunId: { runId: forgedRunId, ...forged, expected: "4xx" },
    },
  };
}

async function pollQuota(page, predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let last = await readQuotaLine(page);
  while (Date.now() < deadline) {
    if (predicate(last)) return last;
    await page.waitForTimeout(700);
    last = await readQuotaLine(page);
  }
  return last;
}

/**
 * A2. The decisive question: what did the SERVICE WORKER's requests claim to
 * be? A `uid` claim means the run billed the signed-in user; a `did` claim
 * means it billed an anonymous device, which is the bug under investigation.
 */
function judgeIdentity(analyzeCalls, workerCalls) {
  if (workerCalls.length === 0) {
    return {
      status: "UNMEASURED",
      evidence: "the recording proxy saw no service-worker API requests at all",
    };
  }
  const subject = analyzeCalls.length > 0 ? analyzeCalls : workerCalls;
  const kinds = [...new Set(subject.map((r) => r.authorization?.kind ?? "none"))];
  const allUid = kinds.length === 1 && kinds[0] === "run-token(uid)";
  return {
    status: allUid ? "PASS" : "FAIL",
    evidence: {
      basedOn: analyzeCalls.length > 0 ? "/api/analyze" : "all service-worker requests",
      identityKinds: kinds,
      requests: subject.map(summarizeRecord),
    },
  };
}

function summarizeRecord(r) {
  return {
    seq: r.seq,
    method: r.method,
    path: r.path,
    realm: r.realm,
    status: r.status,
    outcome: r.outcome,
    durationMs: r.durationMs,
    authorization: r.authorization,
    facts: r.facts ?? null,
    responseBody: r.responseBody,
  };
}

async function grepDist(distDir) {
  const runToken = await grep(distDir, "api/run-token");
  const localhost = await grep(distDir, "localhost:3000");
  return { runToken, localhost };
}

async function grep(dir, needle) {
  if (!existsSync(dir)) return [];
  try {
    const { stdout } = await run("grep", ["-rl", needle, dir], { maxBuffer: 8 * 1024 * 1024 });
    return stdout.trim().split("\n").filter(Boolean).map((p) => path.relative(dir, p));
  } catch {
    return [];
  }
}

/** Canned LLM responses for --stub-llm. Never used in a scoring run. */
function stubResponder(pathname) {
  if (pathname === "/api/parse-jd") {
    return {
      jd: {
        company: "Northwind Labs",
        role_title: "Backend Engineer, Billing",
        must_have_requirements: ["TypeScript", "Redis quota systems"],
        nice_to_have: ["Playwright"],
        key_responsibilities: ["Own the quota service"],
        keywords: ["quota", "JWT"],
        seniority_level: "mid",
        company_context_hints: "stub",
      },
    };
  }
  if (pathname === "/api/analyze") {
    return {
      analysis: {
        overall_match_score: 72,
        rationale: "stubbed",
        requirements_matrix: [],
        strengths: ["stub"],
        gaps: [],
      },
      remaining: 4,
    };
  }
  if (pathname === "/api/rescore") {
    // Deliberately different from the tailor stub's projected_match_score
    // below: A7 asserts the panel shows THIS number, and two equal fixtures
    // would let that assertion pass with the rescore never reaching the DOM.
    return { score: 84 };
  }
  if (pathname === "/api/tailor") {
    return {
      tailored: {
        resume: {
          contact: { name: "Evaluator Fixture", email: "", phone: "", location: "", links: [] },
          summary: "stub",
          experience: [],
          projects: [],
          skills: [],
          education: [],
        },
        change_log: [],
        projected_match_score: 80,
      },
      remaining: 4,
    };
  }
  return null;
}

/**
 * Interrupting the harness must not leave a dev server, a proxy or a Chromium
 * behind — a stray `next dev` holding port 3000 silently poisons the next run.
 */
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    log(`received ${signal}; tearing down`);
    void (async () => {
      await teardown().catch(() => {});
      process.exit(130);
    })();
  });
}

await main();
