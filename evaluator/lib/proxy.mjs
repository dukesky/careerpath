import http from "node:http";
import { decodeJwtPayload } from "./jwt.mjs";

/**
 * A recording reverse proxy that sits on the origin the extension was BUILT
 * to talk to (http://localhost:3000, inlined by Vite into lib/config.ts), and
 * forwards to the Next dev server on another port.
 *
 * Why this exists rather than Playwright network interception: the three
 * calls that decide which quota bucket is charged (parse-jd, analyze, tailor)
 * are made by the extension's SERVICE WORKER, and Playwright's page-level
 * network events never see them. Chromium's own service-worker network events
 * are experimental and were not reliable here. A proxy on the wire sees every
 * request from every realm, with its Authorization header intact — which is
 * the single most decisive piece of evidence this evaluator needs (A2).
 *
 * It changes nothing about the request: headers are forwarded verbatim, and
 * NO x-forwarded-for is added. That last part is deliberate — the server's
 * getIdentity() reads x-forwarded-for, and adding one would switch on the
 * per-IP quota ceiling that a direct localhost request does not trigger,
 * quietly changing the behaviour under measurement.
 */

const CAPTURE_BODY_PATHS = new Set([
  "/api/quota",
  "/api/run-token",
  "/api/device-token",
  "/api/analyze",
  "/api/tailor",
  "/api/parse-jd",
  // A7 reads the score out of this body and compares it with the number the
  // panel finally renders. Without the body captured there is no way to tell
  // "the panel showed the rescore" from "the panel showed the tailor model's
  // projection, which happened to be the same".
  "/api/rescore",
]);

const MAX_BODY_CHARS = 1200;

/** Which realm a path is reached from. Used to attribute captured requests. */
export function realmForPath(pathname) {
  if (
    pathname === "/api/parse-jd" ||
    pathname === "/api/analyze" ||
    pathname === "/api/tailor" ||
    // The worker's fourth leg, fired after the run's `done` patch. The web app
    // calls the same path from a page, but no web app runs in this harness.
    pathname === "/api/rescore"
  ) {
    return "worker";
  }
  if (pathname === "/api/run-token" || pathname === "/api/quota") return "panel";
  return "either";
}

export class RecordingProxy {
  /**
   * @param {object} opts
   * @param {number} opts.listenPort  port the extension believes the API is on
   * @param {number} opts.targetPort  port the Next dev server actually listens on
   */
  constructor({ listenPort, targetPort }) {
    this.listenPort = listenPort;
    this.targetPort = targetPort;
    /** @type {Array<object>} every API request seen, in order */
    this.records = [];
    /** @type {Set<string>} pathnames whose requests are accepted and never answered */
    this.hangPaths = new Set();
    /** @type {null | ((path: string) => object | null)} canned responses, for --stub-llm */
    this.stub = null;
    this.server = null;
    this.heldSockets = new Set();
  }

  /** Requests matching these paths are swallowed: never forwarded, never answered. */
  hang(paths) {
    for (const p of paths) this.hangPaths.add(p);
  }

  records_for(pathname) {
    return this.records.filter((r) => r.path === pathname);
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => this.#handle(req, res));
      this.server.on("error", reject);
      // No host argument: Node binds dual-stack, so both 127.0.0.1 and ::1
      // reach it. Chromium resolves "localhost" to either.
      this.server.listen(this.listenPort, () => resolve());
    });
  }

  async stop() {
    for (const socket of this.heldSockets) {
      try {
        socket.destroy();
      } catch {
        /* already gone */
      }
    }
    this.heldSockets.clear();
    if (!this.server) return;
    await new Promise((resolve) => this.server.close(resolve));
    this.server = null;
  }

  #handle(req, res) {
    const url = new URL(req.url, `http://localhost:${this.listenPort}`);
    const pathname = url.pathname;
    const isApi = pathname.startsWith("/api/");

    const record = isApi
      ? {
          seq: this.records.length,
          at: Date.now(),
          method: req.method,
          path: pathname,
          realm: realmForPath(pathname),
          origin: req.headers.origin ?? null,
          authorization: describeAuthorization(req.headers.authorization),
          accessCode: req.headers["x-access-code"] ?? null,
          status: null,
          responseBody: null,
          durationMs: null,
          outcome: "pending",
        }
      : null;
    if (record) this.records.push(record);

    if (record && this.hangPaths.has(pathname)) {
      // The mutation: accept the request, never forward it, never answer.
      // The socket is kept open so the client sees a hang rather than a
      // connection error, which is what a wedged upstream really looks like.
      record.outcome = "held-open (mutation)";
      this.heldSockets.add(req.socket);
      req.socket.on("close", () => this.heldSockets.delete(req.socket));
      req.resume();
      return;
    }

    if (record && this.stub) {
      const canned = this.stub(pathname);
      if (canned) {
        record.outcome = "stubbed";
        record.status = 200;
        // Answered from memory, so the honest duration is zero — and stating
        // it keeps `durationMs: null` meaning "never settled" everywhere else,
        // which assertions are entitled to rely on.
        record.durationMs = 0;
        // Facts, not just the body: --stub-llm exists to debug the harness
        // itself, and an assertion that reads `facts.score` would silently see
        // null for every stubbed run and be impossible to exercise offline.
        record.facts = factsFrom(JSON.stringify(canned));
        record.responseBody = JSON.stringify(canned).slice(0, MAX_BODY_CHARS);
        req.resume();
        const body = JSON.stringify(canned);
        res.writeHead(200, {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
        });
        res.end(body);
        return;
      }
    }

    const started = Date.now();
    const upstream = http.request(
      {
        host: "127.0.0.1",
        port: this.targetPort,
        method: req.method,
        path: req.url,
        headers: req.headers,
      },
      (upRes) => {
        if (record) {
          record.status = upRes.statusCode ?? null;
          record.durationMs = Date.now() - started;
          record.outcome = "forwarded";
        }
        res.writeHead(upRes.statusCode ?? 502, upRes.headers);
        const capture = record && CAPTURE_BODY_PATHS.has(pathname);
        const chunks = [];
        upRes.on("data", (chunk) => {
          if (capture && chunks.length < 64) chunks.push(chunk);
          res.write(chunk);
        });
        upRes.on("end", () => {
          if (capture) {
            const full = Buffer.concat(chunks).toString("utf8");
            // The interesting numbers live at the END of an analyze/tailor
            // body, past the truncation point. Read them from the whole body
            // before shortening it, or the evidence reads "remaining: null"
            // for a response that plainly carried a number.
            record.facts = factsFrom(full);
            record.responseBody = full.slice(0, MAX_BODY_CHARS);
          }
          res.end();
        });
      },
    );

    upstream.on("error", (err) => {
      if (record) {
        record.outcome = `upstream-error: ${err.message}`;
        record.status = 502;
      }
      if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain" });
      res.end("evaluator proxy: upstream error");
    });

    req.pipe(upstream);
  }
}

/** The handful of response fields the assertions read, taken from the FULL body. */
function factsFrom(body) {
  const facts = {};
  const remaining = /"remaining"\s*:\s*(null|-?\d+)/.exec(body);
  if (remaining) facts.remaining = remaining[1] === "null" ? null : Number(remaining[1]);
  const limit = /"limit"\s*:\s*(-?\d+)/.exec(body);
  if (limit) facts.limit = Number(limit[1]);
  const used = /"used"\s*:\s*(-?\d+)/.exec(body);
  if (used) facts.used = Number(used[1]);
  if (/"token"\s*:\s*"[^"]/.test(body)) facts.hasToken = true;
  // /api/rescore's whole response. Kept as its own fact because A7 compares it
  // against a number read out of the DOM, and a regex over a truncated body
  // would silently answer null for a response that carried one.
  const score = /"score"\s*:\s*(-?\d+(?:\.\d+)?)/.exec(body);
  if (score) facts.score = Number(score[1]);
  const error = /"error"\s*:\s*"([^"]{0,120})/.exec(body);
  if (error) facts.error = error[1];
  return facts;
}

/**
 * What an Authorization header actually carries. The claim IS the answer to
 * assertion A2: `uid` means the request billed the signed-in user, `did` means
 * it billed an anonymous device.
 */
export function describeAuthorization(header) {
  if (!header) return null;
  const trimmed = String(header).trim();
  if (!trimmed.toLowerCase().startsWith("bearer ")) {
    return { scheme: "non-bearer", raw: trimmed.slice(0, 24) };
  }
  const token = trimmed.slice(7).trim();
  if (!token) return { scheme: "bearer", token: "", claims: null, kind: "empty" };
  const payload = decodeJwtPayload(token);
  if (!payload) {
    return { scheme: "bearer", tokenPrefix: token.slice(0, 12), claims: null, kind: "opaque" };
  }
  const kind = typeof payload.uid === "string" && payload.uid
    ? "run-token(uid)"
    : typeof payload.did === "string" && payload.did
      ? "device-token(did)"
      : hasClerkShape(payload)
        ? "clerk-session"
        : "unknown-jwt";
  return {
    scheme: "bearer",
    kind,
    tokenPrefix: token.slice(0, 12),
    claims: redactClaims(payload),
  };
}

function hasClerkShape(payload) {
  return typeof payload.sid === "string" || typeof payload.azp === "string" || typeof payload.iss === "string";
}

/**
 * Claim names, not values, are what the assertions read. Subject ids are kept
 * (they are the thing being compared) but nothing else is copied wholesale.
 */
function redactClaims(payload) {
  const out = { claimNames: Object.keys(payload).sort() };
  for (const key of ["uid", "did", "sub", "sid", "azp", "iss", "exp", "iat"]) {
    if (payload[key] !== undefined) out[key] = payload[key];
  }
  return out;
}
