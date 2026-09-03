import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, rm, symlink } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

/**
 * The stale-build mutation (M1).
 *
 * Builds the extension from commit `ref` — chosen as the last commit BEFORE
 * the extension side learned about run tokens — and loads that dist instead
 * of the current one. This reproduces, exactly, the scenario "the user's
 * browser still has the old package": the panel never mints a run token, the
 * worker runs on the device identity, and the signed-in user's daily bucket
 * is never touched.
 *
 * If the evaluator reports PASS under this mutation, the evaluator is broken.
 */
export async function buildStaleExtension({ repoRoot, ref, workDir, log }) {
  const worktree = path.join(workDir, `stale-${ref}`);
  await removeWorktree(repoRoot, worktree, log);
  await mkdir(workDir, { recursive: true });

  log(`git worktree add ${worktree} ${ref}`);
  await run("git", ["worktree", "add", "--detach", worktree, ref], { cwd: repoRoot });

  // node_modules is symlinked rather than installed: a fresh install of both
  // trees costs minutes, and the dependency set at this ref is the one
  // already on disk (package-lock is unchanged between the two commits for
  // the extension). If that ever stops being true the build below fails
  // loudly rather than producing a subtly wrong bundle.
  const links = [
    [path.join(repoRoot, "node_modules"), path.join(worktree, "node_modules")],
    [path.join(repoRoot, "extension", "node_modules"), path.join(worktree, "extension", "node_modules")],
  ];
  for (const [target, link] of links) {
    if (existsSync(target) && !existsSync(link)) await symlink(target, link, "dir");
  }

  log("building stale extension (npm run build:dev)");
  const { stdout, stderr } = await run("npm", ["run", "build:dev"], {
    cwd: path.join(worktree, "extension"),
    maxBuffer: 32 * 1024 * 1024,
  });
  const dist = path.join(worktree, "extension", "dist");
  if (!existsSync(path.join(dist, "manifest.json"))) {
    throw new Error(`stale build produced no manifest at ${dist}\n${stderr || stdout}`);
  }
  return { dist, worktree };
}

export async function cleanupStaleBuild(repoRoot, worktree, log) {
  await removeWorktree(repoRoot, worktree, log);
}

async function removeWorktree(repoRoot, worktree, log) {
  if (!existsSync(worktree)) {
    await run("git", ["worktree", "prune"], { cwd: repoRoot }).catch(() => {});
    return;
  }
  log?.(`removing worktree ${worktree}`);
  await run("git", ["worktree", "remove", "--force", worktree], { cwd: repoRoot }).catch(
    async () => {
      await rm(worktree, { recursive: true, force: true });
      await run("git", ["worktree", "prune"], { cwd: repoRoot }).catch(() => {});
    },
  );
}
