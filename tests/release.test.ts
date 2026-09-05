import { createHash } from "node:crypto";
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
import { expect, test } from "vitest";
import { publish, runNpm } from "../scripts/publish.ts";
import {
  bumpVersion,
  nextVersion,
  readVersions,
  releaseLevel,
  run,
  versionPaths,
} from "../scripts/release.ts";

type FixtureDocument = {
  version: string;
  packages: Record<string, { version: string }>;
  extra?: unknown;
  description: string;
  mcpServers: Record<string, { command: string; args: string[] }>;
  plugins: { version: string; name: string }[];
};
const project = resolve(import.meta.dirname, "..");
function fixture(action: (root: string) => void) {
  const root = mkdtempSync(resolve(tmpdir(), "bridge-release-"));
  try {
    for (const path of versionPaths) {
      const target = resolve(root, path);
      mkdirSync(dirname(target), { recursive: true });
      cpSync(resolve(project, path), target);
    }
    action(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
function modify(
  root: string,
  path: string,
  action: (document: FixtureDocument) => void,
) {
  const file = resolve(root, path);
  const document = JSON.parse(readFileSync(file, "utf8"));
  action(document);
  writeFileSync(file, JSON.stringify(document, null, 2));
}
function snapshot(root: string) {
  return versionPaths.map((path) => readFileSync(resolve(root, path), "utf8"));
}

test("release labels are an explicit single choice, with no automatic default", () => {
  expect(releaseLevel([])).toBeUndefined();
  expect(run(["level"], project)).toBe("");
  expect(run(["level", '["bug"]'], project)).toBe("");
  for (const level of ["patch", "minor", "major"])
    expect(
      run(["level", JSON.stringify(["bug", `release:${level}`])], project),
    ).toBe(level);
  for (const labels of [
    null,
    {},
    [1],
    ["release:patch", "release:minor"],
    ["release:unknown"],
    ["release:patch", "release:patch"],
  ])
    expect(() => releaseLevel(labels)).toThrow();
});

test("semver bumps reset lower components and reject malformed or overflowing versions", () => {
  expect(nextVersion("1.2.3", "patch")).toBe("1.2.4");
  expect(nextVersion("1.2.3", "minor")).toBe("1.3.0");
  expect(nextVersion("1.2.3", "major")).toBe("2.0.0");
  for (const version of ["1.2", "01.2.3", "1.2.3-rc.1", "v1.2.3"])
    expect(() => nextVersion(version, "patch")).toThrow();
  expect(() => nextVersion("1.2.9007199254740991", "patch")).toThrow();
  expect(() => nextVersion("1.2.3", "invalid")).toThrow();
  expect(() => run(["invalid"], project)).toThrow("Usage");
});

test("a bump updates every real project version and the exact npm command pin", () => {
  fixture((root) => {
    const before = readVersions(root);
    const next = run(["bump", "patch"], root);
    expect(next).toBe(nextVersion(before.version, "patch"));
    expect(run(["verify", next], root)).toBe(next);
    expect(run(["verify"], root)).toBe(next);
    expect(() => run(["verify", before.version], root)).toThrow(
      "does not match",
    );
    const contents = snapshot(root);
    expect(
      contents.every((content) => content.includes(`"version": "${next}"`)),
    ).toBe(true);
    expect(contents[1]).toContain(`${before.packageName}@${next}`);
    expect(
      contents
        .slice(0, 3)
        .every((content) => !content.includes(before.version)),
    ).toBe(true);
    const oldLock = JSON.parse(before.contents[3]);
    const newLock = JSON.parse(contents[3]);
    expect(newLock.version).toBe(next);
    expect(newLock.packages[""].version).toBe(next);
    oldLock.version = next;
    oldLock.packages[""].version = next;
    expect(newLock).toEqual(oldLock);
  });
});

for (const mutation of [
  [
    3,
    (doc: FixtureDocument) => {
      doc.version = "999.0.0";
    },
  ],
  [
    3,
    (doc: FixtureDocument) => {
      doc.packages[""].version = "999.0.0";
    },
  ],
  [
    0,
    (doc: FixtureDocument) => {
      doc.version = "bad";
    },
  ],
  [
    0,
    (doc: FixtureDocument) => {
      doc.extra = { version: doc.version };
    },
  ],
  [
    1,
    (doc: FixtureDocument) => {
      doc.version = "999.0.0";
    },
  ],
  [
    1,
    (doc: FixtureDocument) => {
      doc.mcpServers["codex-bridge"].command = "npm";
    },
  ],
  [
    1,
    (doc: FixtureDocument) => {
      doc.description = doc.mcpServers["codex-bridge"].args[1];
    },
  ],
  [
    2,
    (doc: FixtureDocument) => {
      doc.plugins = [];
    },
  ],
  [
    2,
    (doc: FixtureDocument) => {
      doc.plugins.push(doc.plugins[0]);
    },
  ],
  [
    2,
    (doc: FixtureDocument) => {
      doc.plugins[0].version = "999.0.0";
    },
  ],
] as const) {
  test(`release drift is refused before any file is written: ${mutation[0]} ${mutation[1].toString().match(/doc\.[^=;]+/)?.[0]}`, () => {
    fixture((root) => {
      modify(root, versionPaths[mutation[0]], mutation[1]);
      const before = snapshot(root);
      expect(() => bumpVersion(root, "patch")).toThrow();
      expect(snapshot(root)).toEqual(before);
    });
  });
}

function packed(root: string) {
  const state = readVersions(root);
  const bytes = Buffer.from("verified archive bytes");
  const record = {
    name: state.packageName,
    version: state.version,
    filename: "package.tgz",
    integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
  };
  mkdirSync(resolve(root, ".runtime/release"), { recursive: true });
  writeFileSync(resolve(root, ".runtime/release/package.tgz"), bytes);
  writeFileSync(
    resolve(root, ".runtime/release/pack.json"),
    JSON.stringify([record]),
  );
  return record;
}
const missing = {
  exitCode: 1,
  stdout: '{"error":{"code":"E404"}}',
  stderr: "",
};

test("publication sends the verified archive to npm with provenance and supports an identical retry", () => {
  fixture((root) => {
    const record = packed(root);
    const calls: string[][] = [];
    expect(
      publish(root, (args) => {
        calls.push(args);
        return args[0] === "view"
          ? missing
          : { exitCode: 0, stdout: "ok", stderr: "" };
      }),
    ).toContain("Published");
    expect(calls).toEqual([
      ["view", `${record.name}@${record.version}`, "dist.integrity", "--json"],
      [
        "publish",
        resolve(root, ".runtime/release/package.tgz"),
        "--provenance",
        "--access",
        "public",
      ],
    ]);
    expect(
      publish(root, () => ({
        exitCode: 0,
        stdout: JSON.stringify(record.integrity),
        stderr: "",
      })),
    ).toContain("already published");
    expect(() =>
      publish(root, () => ({ exitCode: 0, stdout: '"different"', stderr: "" })),
    ).toThrow("different bytes");
  });
});

test("publication refuses broken packages and registry failures", () => {
  fixture((root) => {
    const record = packed(root);
    const file = resolve(root, ".runtime/release/pack.json");
    for (const data of [
      [],
      [record, record],
      [{ ...record, name: "wrong" }],
      [{ ...record, version: "999.0.0" }],
      [{ ...record, filename: "../escape.tgz" }],
      [{ ...record, integrity: "wrong" }],
    ]) {
      writeFileSync(file, JSON.stringify(data));
      expect(() =>
        publish(root, () => {
          throw new Error("must not reach npm");
        }),
      ).toThrow();
    }
    writeFileSync(file, JSON.stringify([record]));
    for (const response of [
      {
        exitCode: 1,
        stdout: '{"error":{"code":"E401"}}',
        stderr: "unauthorized",
      },
      { exitCode: 1, stdout: "network error", stderr: "" },
      { exitCode: 1, stdout: "{}", stderr: "bad response" },
    ])
      expect(() => publish(root, () => response)).toThrow();
    expect(() =>
      publish(root, (args) =>
        args[0] === "view"
          ? missing
          : { exitCode: 1, stdout: "", stderr: "publish denied" },
      ),
    ).toThrow("publish denied");
    expect(() =>
      publish(root, (args) =>
        args[0] === "view"
          ? missing
          : { exitCode: 1, stdout: "publish failed", stderr: "" },
      ),
    ).toThrow("publish failed");
  });
});

test("npm sees the same package identity and files used for publication", () => {
  const result = runNpm([
    "pack",
    project,
    "--dry-run",
    "--json",
    "--ignore-scripts",
  ]);
  expect(result.exitCode).toBe(0);
  const [record] = JSON.parse(result.stdout);
  expect(record.name).toBe(readVersions(project).packageName);
  expect(record.version).toBe(readVersions(project).version);
  expect(
    record.files.map((file: { path: string }) => file.path).sort(),
  ).toEqual(["README.md", "dist/server.js", "package.json"]);
});

test("public npm metadata ignores a bootstrap token while publication receives it", () => {
  const directory = mkdtempSync(resolve(tmpdir(), "bridge-npm-auth-"));
  const previousPath = process.env.PATH;
  const previousToken = process.env.NODE_AUTH_TOKEN;
  try {
    writeFileSync(
      resolve(directory, "npm"),
      '#!/usr/bin/env node\nprocess.stdout.write(process.env.NODE_AUTH_TOKEN ?? "");\n',
      { mode: 0o755 },
    );
    process.env.PATH = `${directory}:${previousPath}`;
    process.env.NODE_AUTH_TOKEN = "fixture-only";
    expect(runNpm(["view"]).stdout).toBe("");
    expect(runNpm(["publish"]).stdout).toBe("fixture-only");
  } finally {
    process.env.PATH = previousPath;
    if (previousToken === undefined) delete process.env.NODE_AUTH_TOKEN;
    else process.env.NODE_AUTH_TOKEN = previousToken;
    rmSync(directory, { recursive: true, force: true });
  }
});
