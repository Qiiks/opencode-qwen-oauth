import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { execSync } from "node:child_process";

const checklistPath = resolve(process.cwd(), "..", ".omc", "checklists", "observability-release-gate.md");
const sloPolicyPath = resolve(process.cwd(), "..", ".omc", "policies", "security-slo.json");
const raw = await readFile(checklistPath, "utf8");
const policyRaw = await readFile(sloPolicyPath, "utf8");
const policy = JSON.parse(policyRaw);

const requiredSnippets = [
  "Status: Completed",
  "Signed by:",
  "Date:",
  "Required counters emitted"
];

for (const snippet of requiredSnippets) {
  if (!raw.includes(snippet)) {
    throw new Error(`Governance SLO/release gate missing required checklist evidence: ${snippet}`);
  }
}

if (raw.includes("(pending)")) {
  throw new Error("Governance/release checklist contains pending entries");
}

const slo = policy.temporaryDefault;
if (!slo || slo.criticalHours !== 72 || slo.highDays !== 7 || slo.backportDays !== 14) {
  throw new Error("Temporary governance SLO policy does not match required 72h/7d/14d thresholds");
}

execSync("npm test -- --run test/observability.test.ts", {
  cwd: process.cwd(),
  stdio: "ignore"
});

console.log("governance-slo-gate-ok");
