// Validates an exported pack with the Jarvis CLI (../jarvis/packages/cli).
// Usage: npm run validate:export -- exports/<work_session_id>
import { execFileSync } from "node:child_process";
import { readdirSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";

export function jarvisCliPath(): string {
  const candidates = [
    resolve(import.meta.dirname, "../../jarvis/packages/cli/src/index.js"),
    resolve(process.cwd(), "../jarvis/packages/cli/src/index.js"),
  ];
  const found = candidates.find((path) => existsSync(path));
  if (!found) throw new Error("Jarvis CLI not found. Clone https://github.com/Flow-Research/jarvis.git as a sibling: ../jarvis");
  return found;
}

export interface CheckResult { command: string; file: string; ok: boolean; output: string }

function run(cli: string, args: string[]): { ok: boolean; output: string } {
  try {
    return { ok: true, output: execFileSync("node", [cli, ...args], { encoding: "utf8" }) };
  } catch (error) {
    const e = error as { stdout?: string; stderr?: string; message: string };
    return { ok: false, output: `${e.stdout ?? ""}${e.stderr ?? ""}` || e.message };
  }
}

export function validatePack(packDir: string): CheckResult[] {
  const cli = jarvisCliPath();
  const results: CheckResult[] = [];
  const check = (command: string, file: string) => {
    const result = run(cli, [...command.split(" "), file]);
    results.push({ command, file, ...result });
  };
  for (const file of readdirSync(join(packDir, "records")).sort()) check("validate record", join(packDir, "records", file));
  check("validate evidence-manifest", join(packDir, "evidence", "evidence-manifest.json"));
  check("check hash-chain", join(packDir, "events", "event-chain.json"));
  for (const file of readdirSync(join(packDir, "headers")).sort()) check("check headers", join(packDir, "headers", file));
  return results;
}

if (import.meta.main) {
  const packDir = process.argv[2];
  if (!packDir) {
    console.error("Usage: npm run validate:export -- exports/<work_session_id>");
    process.exit(2);
  }
  const results = validatePack(packDir);
  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.command}  ${r.file}${r.ok ? "" : `\n${r.output}`}`);
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} Jarvis CLI checks passed.`);
  process.exit(failed ? 1 : 0);
}
