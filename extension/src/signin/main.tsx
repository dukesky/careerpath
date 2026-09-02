import "../styles.css";
import { StrictMode, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { ClerkProvider, SignIn, useAuth, useUser } from "@clerk/chrome-extension";
import { CLERK_PUBLISHABLE_KEY } from "@/lib/config";
import { markSignInCompleted, setHasSignedIn } from "@/lib/storage";

/**
 * SPIKE — validating that ClerkProvider's client writes Clerk's session JWT
 * into chrome.storage.local, which is the only place the service worker's
 * headless client can read it from.
 *
 * Why this page changed shape: the previous version used
 * `@clerk/chrome-extension/client`'s createClerkClient, whose non-background
 * branch is a bare `new Clerk(publishableKey, {})` — plain clerk-js, which
 * contains zero references to chrome.storage and keeps its session in cookies
 * on the Clerk Frontend API domain. The worker's `/background` client reads
 * chrome.storage.local and is forced to `credentials: "omit"`, so it could
 * never see that session: it loaded as a fresh anonymous client and every
 * background run transacted as the device.
 *
 * ClerkProvider is the only publicly exported path to the storage-backed
 * client (verified against the package's exports map: the root entry exports
 * React components, `/client` exports the cookie client, `/background` the
 * headless one, and `legacy` only hooks). Its client registers
 * `__internal_onAfterResponse(responseHandler(jwt))` unconditionally, which
 * is what persists the JWT — and it passes `standardBrowser: !syncHost`,
 * i.e. true here, so cookies keep working too and the panel's existing
 * cookie-based client is unaffected.
 */

const signInUrl = chrome.runtime.getURL("src/signin/index.html");

function Gate(): React.JSX.Element {
  const { isLoaded, isSignedIn } = useAuth();
  const { user } = useUser();

  useEffect(() => {
    if (!isLoaded || !isSignedIn) return;
    void (async () => {
      // Order matters. These two writes are what tell the panel (via
      // chrome.storage.onChanged) that sign-in finished, so both must land
      // BEFORE this tab tries to close itself — a close that went first would
      // take the notification with it. Both swallow their own failures.
      //
      // Two writes, two different jobs. `setHasSignedIn` records the durable
      // "this browser has signed in before" hint the token source reads when
      // Clerk is unreachable. `markSignInCompleted` is the NOTIFICATION: the
      // flag above is already true on any browser that has signed in before,
      // and Chrome fires no storage.onChanged for a write that leaves a value
      // unchanged, so on its own it never reaches the panel for exactly the
      // returning users this auto-return exists to serve.
      await setHasSignedIn();
      await markSignInCompleted();
      // window.close() may be refused for a tab the extension did not open
      // with script (this one is opened by a plain <a target="_blank">), so
      // the signed-in message below has to stand on its own.
      window.close();
    })();
  }, [isLoaded, isSignedIn]);

  if (!isLoaded) return <p className="muted tiny center">Loading…</p>;

  if (isSignedIn) {
    const email = user?.primaryEmailAddress?.emailAddress ?? null;
    return (
      <p className="muted tiny center">
        {email
          ? `Signed in as ${email}. The panel is ready — you can close this tab.`
          : "You're signed in. The panel is ready — you can close this tab."}
      </p>
    );
  }

  // Hash routing, not the default path routing: path routing needs a router
  // and real URL paths, and this is one static chrome-extension:// page.
  // ("virtual" is not offered for <SignIn> in this SDK version — its routing
  // prop is typed `"path" | "hash" | undefined`.)
  return <SignIn routing="hash" />;
}

createRoot(document.getElementById("clerk-signin")!).render(
  <StrictMode>
    <ClerkProvider
      publishableKey={CLERK_PUBLISHABLE_KEY}
      afterSignOutUrl={signInUrl}
      signInForceRedirectUrl={signInUrl}
      signUpForceRedirectUrl={signInUrl}
      // NOT optional: without this the Google leg cannot redirect back into a
      // chrome-extension:// URL and sign-in fails at its last step.
      allowedRedirectProtocols={["chrome-extension:"]}
    >
      <Gate />
    </ClerkProvider>
  </StrictMode>,
);
