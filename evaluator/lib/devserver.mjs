import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

/**
 * The Next dev server, owned by this harness as a child process.
 *
 * It listens on `port` (not 3000). The RecordingProxy takes 3000, which is
 * the origin Vite compiled into the extension. Started detached so the whole
 * process GROUP can be killed — `next dev` forks a compiler child that
 * survives a plain kill of the npm wrapper and then holds the port.
 */
export class DevServer {
  constructor({ repoRoot, port, log }) {
    this.repoRoot = repoRoot;
    this.port = port;
    this.log = log;
    this.child = null;
    this.output = [];
  }

  async start() {
    this.child = spawn("npm", ["run", "dev", "--", "--port", String(this.port)], {
      cwd: this.repoRoot,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, BROWSER: "none" },
    });
    const collect = (buf) => {
      const text = buf.toString();
      this.output.push(text);
      if (this.output.length > 400) this.output.shift();
    };
    this.child.stdout.on("data", collect);
    this.child.stderr.on("data", collect);
    this.child.on("exit", (code) => this.log(`dev server exited with code ${code}`));
  }

  tail(lines = 20) {
    return this.output.join("").split("\n").slice(-lines).join("\n");
  }

  async stop() {
    if (!this.child) return;
    try {
      process.kill(-this.child.pid, "SIGTERM");
    } catch {
      try {
        this.child.kill("SIGTERM");
      } catch {
        /* already dead */
      }
    }
    await sleep(700);
    try {
      process.kill(-this.child.pid, "SIGKILL");
    } catch {
      /* already dead */
    }
    this.child = null;
  }
}

/**
 * Readiness probe. Deliberately GET /api/quota THROUGH the proxy on the
 * origin the extension uses: that exercises the whole path the extension will
 * take, and it also forces Next to compile the route before the first click,
 * so the 180s generate budget in A5 is not spent on a cold compile.
 */
export async function waitForApi(baseUrl, timeoutMs, log) {
  const deadline = Date.now() + timeoutMs;
  let lastError = "never attempted";
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${baseUrl}/api/quota`, { method: "GET" });
      if (res.ok) {
        const body = await res.text();
        log(`api ready: GET ${baseUrl}/api/quota -> ${res.status} ${body.slice(0, 120)}`);
        return { ok: true, status: res.status, body: body.slice(0, 200) };
      }
      lastError = `status ${res.status}`;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
    await sleep(1000);
  }
  return { ok: false, error: lastError };
}
