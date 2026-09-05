import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { apiPost, apiPostForm, apiGet, apiStream } from "@/lib/api";
import { setToken, getToken, setBetaCode } from "@/lib/storage";
import { setClerkTokenSource } from "@/lib/session";
import * as tokenLib from "@/lib/token";

function fakeChromeStorage() {
  const data: Record<string, unknown> = {};
  return {
    storage: {
      local: {
        get: vi.fn(async (keys: string[]) => {
          const out: Record<string, unknown> = {};
          for (const k of keys) if (k in data) out[k] = data[k];
          return out;
        }),
        set: vi.fn(async (items: Record<string, unknown>) => Object.assign(data, items)),
        remove: vi.fn(async (keys: string[]) => keys.forEach((k) => delete data[k])),
      },
    },
  };
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers });

describe("api client", () => {
  beforeEach(() => {
    vi.stubGlobal("chrome", fakeChromeStorage());
    // Default every test to a signed-out Clerk session so existing
    // device-token coverage is unaffected; tests that care about the Clerk
    // identity set their own source explicitly.
    setClerkTokenSource(async () => ({ signedIn: false }));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("returns the parsed body on success", async () => {
    await setToken("t1");
    vi.stubGlobal("fetch", vi.fn(async () => json({ jd: { company: "Acme" } })));
    const res = await apiPost<{ jd: { company: string } }>("/api/parse-jd", { text: "x" });
    expect(res).toEqual({ ok: true, data: { jd: { company: "Acme" } } });
  });

  it("sends the stored token as a bearer header", async () => {
    await setToken("t1");
    const fetchMock = vi.fn<typeof fetch>(async () => json({}));
    vi.stubGlobal("fetch", fetchMock);
    await apiPost("/api/parse-jd", { text: "x" });
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer t1");
  });

  it("refreshes once on 401 and retries with the new token", async () => {
    await setToken("stale");
    const fetchMock = vi
      .fn()
      // first attempt with the stale token
      .mockResolvedValueOnce(json({ error: "expired" }, 401))
      // the mint call
      .mockResolvedValueOnce(json({ token: "renewed" }))
      // the retry
      .mockResolvedValueOnce(json({ jd: { company: "Acme" } }));
    vi.stubGlobal("fetch", fetchMock);

    const res = await apiPost<{ jd: { company: string } }>("/api/parse-jd", { text: "x" });
    expect(res.ok).toBe(true);
    expect(await getToken()).toBe("renewed");
    const retryInit = fetchMock.mock.calls[2][1] as RequestInit;
    expect((retryInit.headers as Record<string, string>).Authorization).toBe("Bearer renewed");
  });

  it("does not loop when the retry also 401s", async () => {
    await setToken("stale");
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json({ error: "expired" }, 401))
      .mockResolvedValueOnce(json({ token: "renewed" }))
      .mockResolvedValueOnce(json({ error: "still bad" }, 401));
    vi.stubGlobal("fetch", fetchMock);

    const res = await apiPost("/api/parse-jd", { text: "x" });
    expect(res).toMatchObject({ ok: false, kind: "auth" });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("classifies 402 as a quota error", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ error: "out of runs" }, 402)));
    const res = await apiPost("/api/tailor", {});
    expect(res).toMatchObject({ ok: false, kind: "quota", message: "out of runs" });
  });

  it("classifies 429 and surfaces Retry-After", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => json({ error: "slow down" }, 429, { "Retry-After": "60" })),
    );
    const res = await apiPost("/api/tailor", {});
    expect(res).toMatchObject({ ok: false, kind: "rate_limit", retryAfter: 60 });
  });

  it("classifies 502 as a server error", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ error: "llm down" }, 502)));
    const res = await apiPost("/api/analyze", {});
    expect(res).toMatchObject({ ok: false, kind: "server" });
  });

  it("classifies a thrown fetch as a network error", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));
    const res = await apiPost("/api/analyze", {});
    expect(res).toMatchObject({ ok: false, kind: "network" });
  });

  it("does not set Content-Type on a multipart post", async () => {
    await setToken("t1");
    const fetchMock = vi.fn<typeof fetch>(async () => json({ resume: {} }));
    vi.stubGlobal("fetch", fetchMock);

    const form = new FormData();
    form.append("file", new Blob(["cv"]), "cv.pdf");
    await apiPostForm("/api/parse-resume", form);

    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect((init.headers as Record<string, string>)["Content-Type"]).toBeUndefined();
    expect(init.body).toBe(form);
  });

  it("resends the same FormData on a 401 retry", async () => {
    await setToken("stale");
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json({ error: "expired" }, 401))
      .mockResolvedValueOnce(json({ token: "renewed" }))
      .mockResolvedValueOnce(json({ resume: {} }));
    vi.stubGlobal("fetch", fetchMock);

    const form = new FormData();
    form.append("file", new Blob(["cv"]), "cv.pdf");
    const res = await apiPostForm("/api/parse-resume", form);

    expect(res.ok).toBe(true);
    expect((fetchMock.mock.calls[2][1] as RequestInit).body).toBe(form);
  });

  it("sends no Authorization header when no token can be obtained", async () => {
    // No stored token, and the mint fails — ensureToken returns null. The
    // request must still go out, unauthenticated, and be treated as success.
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json({ error: "not configured" }, 503))
      .mockResolvedValueOnce(json({ jd: { company: "Acme" } }));
    vi.stubGlobal("fetch", fetchMock);

    const res = await apiPost("/api/parse-jd", { text: "x" });

    expect(res.ok).toBe(true);
    const init = fetchMock.mock.calls[1][1] as RequestInit;
    expect((init.headers as Record<string, string>).Authorization).toBeUndefined();
  });

  it("refreshes the device token once and retries on a device-token 401", async () => {
    // No Clerk source set (beforeEach defaults it to signed-out), so
    // currentAuthToken resolves to a { kind: "device" } token backed by the
    // stored device token below.
    await setToken("stale");
    const ensureTokenSpy = vi.spyOn(tokenLib, "ensureToken");
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json({ error: "expired" }, 401))
      .mockResolvedValueOnce(json({ token: "renewed" }))
      .mockResolvedValueOnce(json({ jd: { company: "Acme" } }));
    vi.stubGlobal("fetch", fetchMock);

    const res = await apiPost<{ jd: { company: string } }>("/api/parse-jd", { text: "x" });

    expect(res.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(ensureTokenSpy).toHaveBeenCalledWith(true);
  });

  // The regression guard for the silent downgrade: a Clerk session's 401 must
  // not be treated as an expired device token. If the fork in `send` were
  // removed, this would fall through to the allowRefresh branch, `fetch`
  // would run a second time (a mint call plus the retry), and the result
  // would come back as `{ ok: false, kind: "auth" }` instead.
  it("does not refresh or retry on a Clerk-session 401", async () => {
    setClerkTokenSource(async () => ({ signedIn: true, token: "clerk-token" }));
    const ensureTokenSpy = vi.spyOn(tokenLib, "ensureToken");
    const fetchMock = vi.fn<typeof fetch>(async () => json({ error: "expired" }, 401));
    vi.stubGlobal("fetch", fetchMock);

    const res = await apiPost("/api/parse-jd", { text: "x" });

    expect(res).toEqual({
      ok: false,
      kind: "session_expired",
      message: "Your session expired. Sign in again to continue.",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(ensureTokenSpy).not.toHaveBeenCalledWith(true);
  });

  // Regression guard for the finding in task-2-report.md's fix report: the
  // Clerk-source-throws path used to fall back to a device token, which never
  // 401s — it just succeeds, silently spending a device-bucket run on a
  // signed-in user. `signedIn: true, token: null` is the same shape of
  // uncertainty (Clerk says signed in but hands back nothing usable), so
  // `send` must refuse before issuing any request rather than let
  // `currentAuthToken` degrade it to a device identity that would sail
  // through.
  it("refuses to spend a run when the session state is unavailable", async () => {
    setClerkTokenSource(async () => ({ signedIn: true, token: null }));
    const fetchMock = vi.fn<typeof fetch>(async () => json({ jd: { company: "Acme" } }));
    vi.stubGlobal("fetch", fetchMock);

    const res = await apiPost("/api/parse-jd", { text: "x" });

    expect(res).toEqual({
      ok: false,
      kind: "session_expired",
      message: "We couldn't confirm your session. Sign in again to continue.",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("apiGet issues a GET to the API base", async () => {
    await setToken("t1");
    const fetchMock = vi.fn<typeof fetch>(async () => json({ remaining: 3 }));
    vi.stubGlobal("fetch", fetchMock);

    const res = await apiGet<{ remaining: number }>("/api/quota");

    expect(res).toEqual({ ok: true, data: { remaining: 3 } });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url.endsWith("/api/quota")).toBe(true);
    expect(init.method).toBe("GET");
  });

  it("sends the beta access code when one is stored", async () => {
    // Same reason as "apiGet issues a GET to the API base" above: with no
    // token stored, currentAuthToken() mints a device token FIRST (its own
    // fetch to /api/device-token), which would land at calls[0] instead of
    // the real request and sink this assertion on an unrelated init shape.
    await setToken("t1");
    await setBetaCode("LETMEIN");
    const fetchMock = vi.fn<typeof fetch>(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await apiGet("/api/quota");

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>)["x-access-code"]).toBe("LETMEIN");
  });

  it("sends no beta access header when none is stored", async () => {
    await setToken("t1");
    const fetchMock = vi.fn<typeof fetch>(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await apiGet("/api/quota");

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect("x-access-code" in (init.headers as Record<string, string>)).toBe(false);
  });

  describe("explicit token override", () => {
    it("sends the override instead of consulting the ambient identity", async () => {
      await setToken("device-token");
      const fetchMock = vi.fn<typeof fetch>(async () => json({}));
      vi.stubGlobal("fetch", fetchMock);

      await apiPost("/api/analyze", { a: 1 }, "run-token-xyz");

      const init = fetchMock.mock.calls[0][1] as RequestInit;
      expect((init.headers as Record<string, string>).Authorization).toBe(
        "Bearer run-token-xyz",
      );
    });

    // THE RULE THIS OVERRIDE EXISTS FOR. A run token is the user's identity in
    // a form the worker cannot re-mint. Refreshing to a device token on 401
    // would succeed, and the run would silently finish against the 3-per-30-days
    // device bucket while the panel showed the user their daily allowance — the
    // exact silent downgrade this whole change is undoing. One fetch, no mint,
    // no retry.
    it("never refreshes to a device token when the override is rejected", async () => {
      await setToken("device-token");
      const fetchMock = vi.fn<typeof fetch>(async () => json({ error: "expired" }, 401));
      vi.stubGlobal("fetch", fetchMock);

      const res = await apiPost("/api/analyze", { a: 1 }, "run-token-xyz");

      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.kind).toBe("session_expired");
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("falls back to the ambient identity when no override is given", async () => {
      await setToken("device-token");
      const fetchMock = vi.fn<typeof fetch>(async () => json({}));
      vi.stubGlobal("fetch", fetchMock);

      await apiPost("/api/analyze", { a: 1 });

      const init = fetchMock.mock.calls[0][1] as RequestInit;
      expect((init.headers as Record<string, string>).Authorization).toBe(
        "Bearer device-token",
      );
    });

    // An empty override is a caller bug, but it must fail LOUDLY. Falling back
    // to the ambient identity here would bill the run to the device bucket
    // while the panel showed the user their daily allowance — the silent
    // downgrade this override exists to prevent, reachable through an empty
    // string.
    //
    // Asserted POSITIVELY, on the exact header. `not.toBe("Bearer
    // device-token")` also passes when there is no Authorization header at
    // all — and an absent header resolves server-side to an anonymous caller,
    // which is the same silent downgrade wearing a different hat. `Bearer `
    // is what must go out: a loud 401 the panel forks into session_expired.
    it("sends an empty bearer rather than falling back for an empty override", async () => {
      await setToken("device-token");
      const fetchMock = vi.fn<typeof fetch>(async () => json({}));
      vi.stubGlobal("fetch", fetchMock);

      await apiPost("/api/analyze", { a: 1 }, "");

      const init = fetchMock.mock.calls[0][1] as RequestInit;
      expect((init.headers as Record<string, string>).Authorization).toBe("Bearer ");
    });
  });

  // ------------------------------------------------------------- apiStream
  //
  // Same identity, same error mapping, different way of reading the body. The
  // frame contract is src/lib/sse.ts's, verbatim:
  //   data: {"d":"…"}  ×n, data: {"final":<buffered body>}, data: [DONE]
  // and a failure emits data: {"error":"…"} with no [DONE].
  describe("apiStream", () => {
    /** A streaming Response whose body arrives in the given chunks. */
    const sse = (chunks: string[], status = 200) => {
      const encoder = new TextEncoder();
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
          controller.close();
        },
      });
      return new Response(body, {
        status,
        headers: { "Content-Type": "text/event-stream" },
      });
    };

    const frames = (...payloads: string[]) => payloads.map((p) => `data: ${p}\n\n`);

    it("delivers every delta in order and resolves with the final payload", async () => {
      await setToken("t1");
      vi.stubGlobal(
        "fetch",
        vi.fn<typeof fetch>(async () =>
          sse(
            frames(
              '{"d":"{\\"overall_"}',
              '{"d":"match_score\\": 71}"}',
              '{"final":{"analysis":{"overall_match_score":71},"remaining":3}}',
              "[DONE]",
            ),
          ),
        ),
      );

      const deltas: string[] = [];
      const res = await apiStream<{ analysis: unknown; remaining: number }>(
        "/api/analyze",
        { stream: true },
        (d) => deltas.push(d),
      );

      expect(deltas).toEqual(['{"overall_', 'match_score": 71}']);
      expect(res).toEqual({
        ok: true,
        data: { analysis: { overall_match_score: 71 }, remaining: 3 },
      });
    });

    // The transport splits wherever it likes; a frame is only a frame once its
    // blank line has arrived. Reassembling across reads is the one piece of
    // this parser that a naive per-chunk implementation gets wrong, and the
    // symptom would be silently dropped deltas rather than a failure.
    it("reassembles a frame split across two reads", async () => {
      await setToken("t1");
      vi.stubGlobal(
        "fetch",
        vi.fn<typeof fetch>(async () =>
          sse([
            'data: {"d":"half ',
            'a frame"}\n\ndata: {"final":{"ok":1}}\n',
            "\ndata: [DONE]\n\n",
          ]),
        ),
      );

      const deltas: string[] = [];
      const res = await apiStream<{ ok: number }>("/api/analyze", {}, (d) => deltas.push(d));

      expect(deltas).toEqual(["half a frame"]);
      expect(res).toEqual({ ok: true, data: { ok: 1 } });
    });

    // The server's error frame carries the bare message; callers decide how to
    // dress it. No retry here — that judgement belongs to the run.
    it("maps an error frame to a server failure carrying its message", async () => {
      await setToken("t1");
      vi.stubGlobal(
        "fetch",
        vi.fn<typeof fetch>(async () =>
          sse(frames('{"d":"partial"}', '{"error":"model timed out"}')),
        ),
      );

      const res = await apiStream("/api/analyze", {}, () => {});

      expect(res).toEqual({ ok: false, kind: "server", message: "model timed out" });
    });

    // A stream that stops mid-JSON is the case the run's buffered fallback
    // exists for: it must come back as a failure, never as a half-result.
    it("fails when the stream ends without a final frame", async () => {
      await setToken("t1");
      vi.stubGlobal(
        "fetch",
        vi.fn<typeof fetch>(async () => sse(frames('{"d":"half an ana"}'))),
      );

      const res = await apiStream("/api/analyze", {}, () => {});

      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.kind).toBe("server");
    });

    it("fails when the connection drops mid-stream", async () => {
      await setToken("t1");
      const encoder = new TextEncoder();
      vi.stubGlobal(
        "fetch",
        vi.fn<typeof fetch>(
          async () =>
            new Response(
              new ReadableStream<Uint8Array>({
                start(controller) {
                  controller.enqueue(encoder.encode('data: {"d":"x"}\n\n'));
                  controller.error(new Error("connection reset"));
                },
              }),
              { status: 200 },
            ),
        ),
      );

      const res = await apiStream("/api/analyze", {}, () => {});

      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.kind).toBe("network");
    });

    // Status codes are still status codes: the gates all run before the first
    // frame, so a refusal arrives as JSON and must classify exactly as it does
    // for apiPost — the panel's quota copy depends on the kind.
    it("classifies a pre-stream refusal the same way apiPost does", async () => {
      await setToken("t1");
      vi.stubGlobal("fetch", vi.fn(async () => json({ error: "out of runs" }, 402)));

      const onDelta = vi.fn();
      const res = await apiStream("/api/analyze", {}, onDelta);

      expect(res).toMatchObject({ ok: false, kind: "quota", message: "out of runs" });
      expect(onDelta).not.toHaveBeenCalled();
    });

    it("classifies a thrown fetch as a network error", async () => {
      await setToken("t1");
      vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));

      const res = await apiStream("/api/analyze", {}, () => {});

      expect(res).toMatchObject({ ok: false, kind: "network" });
    });

    // The whole identity fork lives in `send`, and a streaming leg spends the
    // same quota as a buffered one — so it has to travel under the same
    // identity. A stream that bypassed it would bill the run to the device
    // bucket while the panel showed the user their daily allowance.
    it("carries the run token as the bearer identity", async () => {
      await setToken("device-token");
      const fetchMock = vi.fn<typeof fetch>(async () =>
        sse(frames('{"final":{"ok":1}}', "[DONE]")),
      );
      vi.stubGlobal("fetch", fetchMock);

      await apiStream("/api/analyze", { a: 1 }, () => {}, "run-token-xyz");

      const init = fetchMock.mock.calls[0][1] as RequestInit;
      expect((init.headers as Record<string, string>).Authorization).toBe(
        "Bearer run-token-xyz",
      );
      expect((init.headers as Record<string, string>)["Content-Type"]).toBe(
        "application/json",
      );
      expect(init.body).toBe(JSON.stringify({ a: 1 }));
    });

    it("never refreshes to a device token when the run token is rejected", async () => {
      await setToken("device-token");
      const fetchMock = vi.fn<typeof fetch>(async () => json({ error: "expired" }, 401));
      vi.stubGlobal("fetch", fetchMock);

      const res = await apiStream("/api/analyze", {}, () => {}, "run-token-xyz");

      expect(res).toMatchObject({ ok: false, kind: "session_expired" });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    // A frame this client cannot read is dropped, not fatal: the stream is a
    // presentation channel, and one unreadable delta must not cost the run the
    // final frame that follows it.
    it("skips malformed frames rather than abandoning the stream", async () => {
      await setToken("t1");
      vi.stubGlobal(
        "fetch",
        vi.fn<typeof fetch>(async () =>
          sse([
            "event: ping\n\n",
            "data: {not json}\n\n",
            ...frames('{"d":"ok"}', '{"final":{"ok":1}}', "[DONE]"),
          ]),
        ),
      );

      const deltas: string[] = [];
      const res = await apiStream<{ ok: number }>("/api/analyze", {}, (d) => deltas.push(d));

      expect(deltas).toEqual(["ok"]);
      expect(res).toEqual({ ok: true, data: { ok: 1 } });
    });
  });
});
