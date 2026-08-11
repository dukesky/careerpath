import { clerkMiddleware } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import { corsHeaders, isAllowedOrigin, preflightResponse } from "@/lib/cors";

// Makes auth available everywhere but protects nothing by default — anonymous
// use must keep working. Individual routes check `auth()` themselves.
//
// Also answers CORS preflights from allowlisted Chrome-extension origins and
// stamps the CORS headers onto API responses, so route files stay untouched.
export default clerkMiddleware(async (_auth, request) => {
  const origin = request.headers.get("origin");
  if (!isAllowedOrigin(origin)) return;

  const allowed = origin as string;
  if (request.method === "OPTIONS") {
    return preflightResponse(allowed);
  }

  const response = NextResponse.next();
  for (const [key, value] of Object.entries(corsHeaders(allowed))) {
    response.headers.set(key, value);
  }
  return response;
});

export const config = {
  matcher: [
    // Run on everything except Next internals and static assets…
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|gif|png|svg|ico|webp|woff2?|ttf|map)).*)",
    // …and always on API routes.
    "/(api|trpc)(.*)",
  ],
};
