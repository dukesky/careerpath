import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ApiResult } from "../api";
import { fetchQuota } from "../quota";

let apiGetImpl: (path: string) => Promise<ApiResult<unknown>> = async () => ({
  ok: true,
  data: {},
});
let apiGetPaths: string[] = [];

vi.mock("../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api")>();
  return {
    ...actual,
    apiGet: <T,>(path: string) => {
      apiGetPaths.push(path);
      return apiGetImpl(path) as Promise<ApiResult<T>>;
    },
  };
});

beforeEach(() => {
  apiGetPaths = [];
  apiGetImpl = async () => ({ ok: true, data: {} });
});

describe("fetchQuota", () => {
  it("reads the caller's remaining count from /api/quota", async () => {
    apiGetImpl = async () => ({ ok: true, data: { remaining: 3, used: 0, limit: 3 } });

    expect(await fetchQuota()).toEqual({ remaining: 3, unlimited: false });
    expect(apiGetPaths).toEqual(["/api/quota"]);
  });

  it("reports unlimited when a beta code is in force", async () => {
    apiGetImpl = async () => ({ ok: true, data: { remaining: null, unlimited: true } });

    expect(await fetchQuota()).toEqual({ remaining: null, unlimited: true });
  });

  // The server returns this shape when its store is unreachable. "Remaining
  // is unknown" must not collapse into "remaining is zero" — the panel would
  // tell a user with a full allowance that they are out of runs.
  it("reports an unknown remaining count as null, not zero", async () => {
    apiGetImpl = async () => ({ ok: true, data: { remaining: null } });

    expect(await fetchQuota()).toEqual({ remaining: null, unlimited: false });
  });

  // A failed request is NOT the same as "no allowance". Returning null lets
  // the panel render "unknown" rather than inventing a number.
  it("returns null when the request itself fails", async () => {
    apiGetImpl = async () => ({ ok: false, kind: "network", message: "nope" });

    expect(await fetchQuota()).toBeNull();
  });

  // Guards against a shape change on the server silently becoming NaN or a
  // string in the panel's headline.
  it("ignores a non-numeric remaining", async () => {
    apiGetImpl = async () => ({ ok: true, data: { remaining: "3" } });

    expect(await fetchQuota()).toEqual({ remaining: null, unlimited: false });
  });
});
