import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { readVersions } from "./release.ts";

type Result = { exitCode: number; stdout: string; stderr: string };
type Npm = (args: string[]) => Result;

export function runNpm(args: string[]): Result {
  const result = spawnSync("npm", args, {
    encoding: "utf8",
    // Public metadata reads must keep working after the bootstrap token expires.
    env: {
      ...process.env,
      NODE_AUTH_TOKEN: args[0] === "view" ? "" : process.env.NODE_AUTH_TOKEN,
    },
  });
  return {
    exitCode: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.error?.message ?? result.stderr ?? "",
  };
}

export function publish(root: string, npm: Npm = runNpm): string {
  const { version, packageName } = readVersions(root);
  const records = JSON.parse(
    readFileSync(resolve(root, ".runtime/release/pack.json"), "utf8"),
  );
  if (records.length !== 1)
    throw new Error("Expected exactly one packed npm artifact");
  const [record] = records;
  if (
    record.name !== packageName ||
    record.version !== version ||
    basename(record.filename) !== record.filename
  )
    throw new Error("Packed npm artifact does not match this release");
  const archive = resolve(root, ".runtime/release", record.filename);
  const integrity = `sha512-${createHash("sha512").update(readFileSync(archive)).digest("base64")}`;
  if (integrity !== record.integrity)
    throw new Error("Packed npm artifact integrity mismatch");
  const existing = npm([
    "view",
    `${packageName}@${version}`,
    "dist.integrity",
    "--json",
  ]);
  if (existing.exitCode === 0) {
    if (JSON.parse(existing.stdout) !== integrity)
      throw new Error(
        "npm already carries different bytes for this version; refusing to overwrite it",
      );
    return `${packageName}@${version} is already published with the verified integrity`;
  }
  let code: string | undefined;
  try {
    code = JSON.parse(existing.stdout).error?.code;
  } catch {
    /* npm may report a transport error without JSON. */
  }
  if (code !== "E404") throw new Error(existing.stderr || existing.stdout);
  const result = npm([
    "publish",
    archive,
    "--provenance",
    "--access",
    "public",
  ]);
  if (result.exitCode !== 0) throw new Error(result.stderr || result.stdout);
  return `Published ${packageName}@${version}\n${result.stdout}`;
}

if (import.meta.main) console.log(publish(resolve(import.meta.dirname, "..")));
