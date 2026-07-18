import { clerkMiddleware } from "@clerk/nextjs/server";

// Makes auth available everywhere but protects nothing by default — anonymous
// use must keep working. Individual routes check `auth()` themselves.
export default clerkMiddleware();

export const config = {
  matcher: [
    // Run on everything except Next internals and static assets…
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|gif|png|svg|ico|webp|woff2?|ttf|map)).*)",
    // …and always on API routes.
    "/(api|trpc)(.*)",
  ],
};
