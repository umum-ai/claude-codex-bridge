import { expect, test } from "bun:test";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { nextVersion, readVersions, versionPaths } from "../scripts/release";

type Step = { name?: string; uses?: string; run?: string; if?: string };
const project = resolve(import.meta.dir, "..");
const workflow = Bun.YAML.parse(
  readFileSync(resolve(project, ".github/workflows/release.yml"), "utf8"),
) as {
  on: {
    pull_request: { types: string[] };
    workflow_dispatch: { inputs: { ref: object } };
  };
  permissions: Record<string, string>;
  jobs: { release: { environment: string; steps: Step[] } };
};
const steps = workflow.jobs.release.steps;
const candidate = steps.find(
  (step) => step.name === "Prepare a release requested by its label",
)?.run;
const promote = steps.find(
  (step) => step.name === "Promote exactly the commit that passed the checks",
)?.run;
if (!candidate || !promote)
  throw new Error("Release candidate or promotion step is missing");
const releaseScripts = { candidate, promote };
const environment = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "Release Test",
  GIT_AUTHOR_EMAIL: "release@example.invalid",
  GIT_COMMITTER_NAME: "Release Test",
  GIT_COMMITTER_EMAIL: "release@example.invalid",
};
function command(
  cwd: string,
  args: string[],
  env: Record<string, string> = {},
) {
  return Bun.spawnSync(args, { cwd, env: { ...environment, ...env } });
}
function git(cwd: string, ...args: string[]) {
  const result = command(cwd, ["git", ...args]);
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return result.stdout.toString().trim();
}
function fixture(action: (root: string, remote: string) => void) {
  const directory = mkdtempSync(resolve(tmpdir(), "bridge-workflow-"));
  const root = resolve(directory, "checkout");
  const remote = resolve(directory, "remote.git");
  try {
    git(directory, "init", "--bare", "--initial-branch=main", remote);
    git(directory, "init", "--initial-branch=main", root);
    for (const path of [...versionPaths, "scripts/release.ts"]) {
      mkdirSync(dirname(resolve(root, path)), { recursive: true });
      cpSync(resolve(project, path), resolve(root, path));
    }
    git(root, "add", ".");
    git(root, "commit", "-m", "Initial fixture");
    git(root, "remote", "add", "origin", remote);
    git(root, "push", "-u", "origin", "main");
    action(root, remote);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
function prepare(root: string, labels = '["release:patch"]', retry = "") {
  const output = resolve(root, ".release-output");
  writeFileSync(output, "");
  const result = command(root, ["bash", "-c", releaseScripts.candidate], {
    GITHUB_OUTPUT: output,
    LABELS: labels,
    RETRY_TAG: retry,
    PR_URL: "https://example.invalid/pull/42",
  });
  const outputs = Object.fromEntries(
    readFileSync(output, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => line.split("=")),
  );
  return { result, outputs };
}

test("release triggers are manual labels or an existing tag, and verification precedes promotion and publishing", () => {
  expect(workflow.on.pull_request.types).toEqual(["closed", "labeled"]);
  expect(workflow.on.workflow_dispatch.inputs.ref).toBeDefined();
  expect(workflow.permissions["id-token"]).toBe("write");
  expect(workflow.jobs.release.environment).toBe("npm");
  const check = steps.findIndex((step) => step.run === "mise run check");
  const promotion = steps.findIndex((step) => step.run === promote);
  const publication = steps.findIndex(
    (step) => step.run === "bun scripts/publish.ts",
  );
  expect(check).toBeGreaterThan(-1);
  expect(promotion).toBeGreaterThan(check);
  expect(publication).toBeGreaterThan(promotion);
  expect(steps.some((step) => step.uses?.includes("siam-platform"))).toBe(
    false,
  );
});

test("workflow shell publishes the checked candidate atomically, ignores repeated labels, and retries the same tag", () => {
  fixture((root, remote) => {
    const before = readVersions(root).version;
    const prepared = prepare(root);
    expect(prepared.result.exitCode).toBe(0);
    const version = nextVersion(before, "patch");
    expect(prepared.outputs.version).toBe(version);
    const sha = git(root, "rev-parse", "HEAD");
    expect(git(root, "rev-parse", "origin/main")).toBe(prepared.outputs.base);
    const result = command(root, ["bash", "-c", releaseScripts.promote], {
      RELEASE_VERSION: version,
      RELEASE_BASE: prepared.outputs.base,
    });
    expect(result.exitCode).toBe(0);
    expect(git(root, "--git-dir", remote, "rev-parse", "refs/heads/main")).toBe(
      sha,
    );
    expect(
      git(
        root,
        "--git-dir",
        remote,
        "rev-parse",
        `refs/tags/${version}^{commit}`,
      ),
    ).toBe(sha);
    expect(prepare(root).outputs).toEqual({});
    const retried = prepare(root, "[]", version);
    expect(retried.result.exitCode).toBe(0);
    expect(retried.outputs.version).toBe(version);
    expect(git(root, "rev-parse", "HEAD")).toBe(sha);
    expect(prepare(root, "[]", "not-a-version").result.exitCode).not.toBe(0);
  });
});

test("workflow shell tags nothing when main moves during verification", () => {
  fixture((root, remote) => {
    const prepared = prepare(root);
    expect(prepared.result.exitCode).toBe(0);
    const other = resolve(root, "../other");
    git(root, "clone", remote, other);
    git(other, "commit", "--allow-empty", "-m", "Concurrent change");
    git(other, "push", "origin", "main");
    const upstream = git(other, "rev-parse", "HEAD");
    const result = command(root, ["bash", "-c", releaseScripts.promote], {
      RELEASE_VERSION: prepared.outputs.version,
      RELEASE_BASE: prepared.outputs.base,
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout.toString()).toContain("main moved");
    expect(git(root, "--git-dir", remote, "tag", "--list")).toBe("");
    expect(git(root, "--git-dir", remote, "rev-parse", "refs/heads/main")).toBe(
      upstream,
    );
  });
});

test("workflow shell leaves unlabeled changes alone and refuses conflicting labels", () => {
  fixture((root) => {
    const sha = git(root, "rev-parse", "HEAD");
    expect(prepare(root, "[]").outputs).toEqual({});
    expect(
      prepare(root, '["release:patch","release:major"]').result.exitCode,
    ).not.toBe(0);
    expect(git(root, "rev-parse", "HEAD")).toBe(sha);
  });
});
