import "../styles.css";
import { getClerk } from "@/lib/clerk";

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
    ? `Signed in as ${email}. You can close this tab and return to the panel.`
    : "You're signed in. You can close this tab and return to the panel.";
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
  .then((clerk) => {
    if (clerk.isSignedIn) {
      renderSignedIn(container, clerk.user?.primaryEmailAddress?.emailAddress ?? null);
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
