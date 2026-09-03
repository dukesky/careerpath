import { TEST_CODE, TEST_EMAIL } from "./clerkTestUser.mjs";

/**
 * Drives the extension's OWN sign-in page (src/signin/index.html) through
 * Clerk's email-code first factor, in the DEVELOPMENT instance's test mode.
 *
 * The instance reports `first_factors: ["email_code"]` for email addresses and
 * no password first factor, so this is the only interactive flow available —
 * no password is ever typed, no OAuth is ever touched, and the address is a
 * `+clerk_test` one whose verification code is fixed at 424242 and whose mail
 * is never actually sent.
 *
 * Every wait here polls the DOM directly rather than using locator.waitFor:
 * Clerk's markup moves between SDK versions, and a poll that can report what
 * it DID see is worth far more when it fails than a bare selector timeout.
 */
const OTP_SELECTOR =
  'input[autocomplete="one-time-code"], input[data-input-otp], input[name^="codeInput"]';

export async function signIn({ page, signinUrl, shot, log }) {
  await page.goto(signinUrl, { waitUntil: "domcontentloaded" });

  const identifier = page.locator(
    'input[name="identifier"], input[type="email"], input[name="emailAddress"]',
  );
  await identifier.first().waitFor({ state: "visible", timeout: 60_000 });
  await shot("signin-01-form");

  await identifier.first().fill(TEST_EMAIL);
  log(`sign-in: submitting ${TEST_EMAIL}`);
  // Enter, not a click on the primary button. Clerk renders a hidden
  // aria-hidden `button[type=submit]` ahead of the visible "Continue" in
  // document order, and a selector union picks that one up and then waits
  // forever for it to become visible. Submitting the form from the field the
  // user is typing in sidesteps the whole question.
  await identifier.first().press("Enter");

  const codeScreen = await waitFor(page, 60_000, async () => {
    const state = await readState(page);
    if (state.otpInputs > 0) return { done: true, state };
    if (state.error) return { done: true, state };
    return { done: false, state };
  });
  if (!codeScreen.state.otpInputs) {
    await shot("signin-02-no-code-screen");
    return {
      ok: false,
      stage: "identifier",
      error: codeScreen.state.error ?? "no verification-code field appeared",
      observed: codeScreen.state,
    };
  }

  await shot("signin-02-code");
  log("sign-in: entering the test-mode verification code");
  await page.locator(OTP_SELECTOR).first().focus();
  await page.keyboard.type(TEST_CODE, { delay: 60 });

  // Success is the extension's own page saying so: after Clerk redirects back
  // here, signin/main.ts renders "Signed in as <email>". It also calls
  // window.close(), which Chrome may or may not honour for a tab the harness
  // opened — a closed page counts as success too.
  const finished = await waitFor(page, 90_000, async () => {
    if (page.isClosed()) return { done: true, state: { closed: true } };
    const state = await readState(page);
    if (/Signed in as|You're signed in/i.test(state.text)) return { done: true, state };
    if (state.error) return { done: true, state };
    return { done: false, state };
  });

  if (finished.state.closed) return { ok: true, closed: true, email: TEST_EMAIL };
  if (/Signed in as|You're signed in/i.test(finished.state.text ?? "")) {
    await shot("signin-03-done");
    return {
      ok: true,
      closed: false,
      email: TEST_EMAIL,
      bodyText: finished.state.text.trim().slice(0, 300),
    };
  }
  await shot("signin-03-failed");
  return {
    ok: false,
    stage: "code",
    error: finished.state.error ?? "timed out waiting for the signed-in screen",
    observed: finished.state,
  };
}

async function readState(page) {
  return page.evaluate((otpSelector) => {
    const errorNode = document.querySelector(".cl-formFieldErrorText, .cl-alertText");
    return {
      text: document.body?.innerText ?? "",
      otpInputs: document.querySelectorAll(otpSelector).length,
      error: errorNode ? (errorNode.textContent ?? "").trim() || null : null,
    };
  }, OTP_SELECTOR);
}

async function waitFor(page, timeoutMs, probe) {
  const deadline = Date.now() + timeoutMs;
  let last = { done: false, state: {} };
  while (Date.now() < deadline) {
    last = await probe().catch((err) => ({ done: false, state: { probeError: String(err) } }));
    if (last.done) return last;
    await page.waitForTimeout(500).catch(() => {});
  }
  return last;
}
