import { readdir } from "node:fs/promises";

const report = await Bun.file("coverage/lcov.info").text();
const records = report.split("end_of_record");
const files = [
  ...(await readdir("src"))
    .filter((file) => file.endsWith(".ts"))
    .map((file) => `src/${file}`),
  "scripts/release.ts",
  "scripts/publish.ts",
];
for (const file of files) {
  const record = records.find((entry) => entry.includes(`SF:${file}\n`));
  if (!record) throw new Error(`Missing coverage for ${file}`);
  for (const [found, hit] of [
    ["LF", "LH"],
    ["FNF", "FNH"],
  ]) {
    const total = Number(
      record.match(new RegExp(`^${found}:(\\d+)$`, "m"))?.[1],
    );
    const covered = Number(
      record.match(new RegExp(`^${hit}:(\\d+)$`, "m"))?.[1],
    );
    if (
      !Number.isFinite(total) ||
      !Number.isFinite(covered) ||
      (total > 0 && covered / total < 0.9)
    ) {
      throw new Error(
        `${file}: ${hit}/${found} = ${covered}/${total}, requires 90%`,
      );
    }
  }
}
console.log(
  "Coverage: every runtime and release file passes 90% of lines and functions",
);
