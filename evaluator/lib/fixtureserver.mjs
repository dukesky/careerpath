import http from "node:http";
import { readFile } from "node:fs/promises";

/**
 * Serves the JD fixture.
 *
 * The host it is served UNDER matters more than the content. The panel reads
 * the active tab by injecting a content script, and that injection needs a
 * host permission. The manifest grants five job sites at install
 * (*://*.greenhouse.io/* among them) and everything else only through
 * chrome.permissions.request — which raises a NATIVE Chrome dialog that no
 * automation can dismiss. So the fixture is served on a greenhouse.io
 * hostname, pointed at this local server with Chromium's
 * --host-resolver-rules, and the panel reads it with no dialog and no click.
 */
export const FIXTURE_HOST = "boards.greenhouse.io";
export const FIXTURE_PATH = "/northwind/jobs/evaluator-fixture";

export class FixtureServer {
  constructor({ port, htmlPath }) {
    this.port = port;
    this.htmlPath = htmlPath;
    this.server = null;
    this.hits = [];
  }

  get url() {
    return `http://${FIXTURE_HOST}${FIXTURE_PATH}`;
  }

  async start() {
    const html = await readFile(this.htmlPath, "utf8");
    this.server = http.createServer((req, res) => {
      this.hits.push({ at: Date.now(), url: req.url });
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
      });
      res.end(html);
    });
    await new Promise((resolve, reject) => {
      this.server.on("error", reject);
      this.server.listen(this.port, "127.0.0.1", resolve);
    });
  }

  async stop() {
    if (!this.server) return;
    await new Promise((resolve) => this.server.close(resolve));
    this.server = null;
  }
}
