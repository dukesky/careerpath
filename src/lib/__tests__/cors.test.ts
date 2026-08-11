import { describe, it, expect, beforeEach } from "vitest";
import { isAllowedOrigin, corsHeaders, preflightResponse } from "@/lib/cors";

describe("isAllowedOrigin", () => {
  beforeEach(() => {
    process.env.ALLOWED_EXTENSION_IDS = "aaaabbbbccccddddeeeeffffgggghhhh";
  });

  it("allows a listed extension id", () => {
    expect(
      isAllowedOrigin("chrome-extension://aaaabbbbccccddddeeeeffffgggghhhh"),
    ).toBe(true);
  });

  it("rejects an unlisted extension id", () => {
    expect(isAllowedOrigin("chrome-extension://someotherextensionidhere00")).toBe(
      false,
    );
  });

  it("rejects a website pretending to be an extension", () => {
    expect(
      isAllowedOrigin("https://evil.com/chrome-extension://aaaabbbbccccddddeeeeffffgggghhhh"),
    ).toBe(false);
  });

  it("rejects null and empty origins", () => {
    expect(isAllowedOrigin(null)).toBe(false);
    expect(isAllowedOrigin("")).toBe(false);
  });

  it("allows any listed id when several are configured", () => {
    process.env.ALLOWED_EXTENSION_IDS = "idone, idtwo ,idthree";
    expect(isAllowedOrigin("chrome-extension://idtwo")).toBe(true);
    expect(isAllowedOrigin("chrome-extension://idfour")).toBe(false);
  });

  it("rejects everything when nothing is configured", () => {
    delete process.env.ALLOWED_EXTENSION_IDS;
    expect(isAllowedOrigin("chrome-extension://anything")).toBe(false);
  });
});

describe("corsHeaders", () => {
  it("echoes the origin and allows the headers we send", () => {
    const h = corsHeaders("chrome-extension://abc");
    expect(h["Access-Control-Allow-Origin"]).toBe("chrome-extension://abc");
    expect(h["Access-Control-Allow-Headers"]).toContain("authorization");
    expect(h["Access-Control-Allow-Headers"]).toContain("x-anon-id");
    expect(h["Vary"]).toBe("Origin");
  });
});

describe("preflightResponse", () => {
  it("returns 204 with the CORS headers", () => {
    const res = preflightResponse("chrome-extension://abc");
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe(
      "chrome-extension://abc",
    );
  });
});
