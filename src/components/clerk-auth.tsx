"use client";

// Compatibility shim for Clerk v7, which removed the <SignedIn>/<SignedOut>
// control components in favor of a single <Show when="signed-in|signed-out">.
// We re-expose the old names so the rest of the app can stay declarative.
import { Show } from "@clerk/nextjs";
import type { ReactNode } from "react";

export function SignedIn({ children }: { children: ReactNode }) {
  return <Show when="signed-in">{children}</Show>;
}

export function SignedOut({ children }: { children: ReactNode }) {
  return <Show when="signed-out">{children}</Show>;
}

export { SignInButton, SignUpButton, UserButton } from "@clerk/nextjs";
