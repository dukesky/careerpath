import "../styles.css";
import { getClerk } from "@/lib/clerk";
import { markSignInCompleted, setHasSignedIn } from "@/lib/storage";

// The element is a <div> in index.html; getElementById only knows
// HTMLElement, and mountSignIn's type requires HTMLDivElement specifically.
const container = document.getElementById("clerk-signin") as HTMLDivElement | null;

if (!container) {
  // Should be impossible — index.html always ships with this element — but
  // failing loudly here beats a blank page with no clue why nothing mounted.
  throw new Error("signin: #clerk-signin container missing from index.html");
}

/**
 * Shown instead of the form when the user who opened this page is already
 * signed in — which happens on the redirect back here after a successful
 * sign-in (`signInForceRedirectUrl`/`signUpForceRedirectUrl` in clerk.ts
 * both point at this page), and on any later re-open of the tab while a
 * session is still active. Without this check, `mountSignIn` would render a
 * second sign-in form to someone who just finished signing in — a dead end
 * at best, and confusing if they try to sign in again.
 */
function renderSignedIn(container: HTMLDivElement, email: string | null): void {
  container.textContent = "";
  const p = document.createElement("p");
  p.className = "muted tiny center";
  p.textContent = email
    ? `Signed in as ${email}. The panel is ready — you can close this tab.`
    : "You're signed in. The panel is ready — you can close this tab.";
  container.appendChild(p);
}

/**
 * `openSignIn({})` — the brief's assumed call — opens Clerk's SignIn
 * component as a floating MODAL; it takes no target node. Verified against
 * @clerk/shared's Clerk type (`openSignIn: (props?: SignInModalProps) =>
 * void`), which has no node parameter, alongside the actually-matching
 * `mountSignIn: (targetNode: HTMLDivElement, signInProps?: SignInProps) =>
 * void`. A modal has nothing to float over on a page whose entire content
 * IS the sign-in flow, so this uses `mountSignIn` into the container
 * instead — the real API for "render inline here," not the brief's
 * mismatched guess.
 */
getClerk()
  .then(async (clerk) => {
    if (clerk.isSignedIn) {
      // Order matters. These two writes are what tell the panel (via
      // chrome.storage.onChanged) that sign-in finished, so both must be
      // written BEFORE this tab tries to close itself — a close that lands
      // first would take the notification with it. Both swallow their own
      // failures, so neither can reject.
      //
      // Two writes, two different jobs. `setHasSignedIn` records the
      // durable "this browser has signed in before" hint lib/clerk.ts reads
      // when Clerk is unreachable — a genuine window this closes.
      // `markSignInCompleted` is the NOTIFICATION: the flag above is
      // already `true` on any browser that has signed in before, and Chrome
      // fires no storage.onChanged for a write that leaves a value
      // unchanged, so on its own it never reaches the panel for exactly the
      // returning users this auto-return exists to serve.
      await setHasSignedIn();
      await markSignInCompleted();
      // Rendered before the close attempt, not after: window.close() may be
      // refused for a tab the extension did not open with script (this one
      // is opened by a plain <a target="_blank">), and the user must not be
      // left staring at a blank page in that case.
      renderSignedIn(container, clerk.user?.primaryEmailAddress?.emailAddress ?? null);
      window.close();
      return;
    }
    clerk.mountSignIn(container, {});
  })
  .catch((err) => {
    console.error(
      JSON.stringify({
        evt: "signin_load_failed",
        message: err instanceof Error ? err.message : String(err),
      }),
    );
    container.textContent =
      "Couldn't load sign-in. Check your connection and try again.";
  });
