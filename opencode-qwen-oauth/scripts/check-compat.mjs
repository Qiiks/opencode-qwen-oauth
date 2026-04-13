import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { readdir } from "node:fs/promises";
import { join } from "node:path";

const rootMatrixPath = resolve(process.cwd(), "..", ".omc", "contracts", "compatibility-matrix.json");
const matrixPath = rootMatrixPath;
const raw = await readFile(matrixPath, "utf8");
const data = JSON.parse(raw);

if (!data.openCode?.range || typeof data.openCode.range !== "string") {
  throw new Error(`Invalid compatibility matrix at ${matrixPath}`);
}

if (!Array.isArray(data.node) || data.node.length === 0) {
  throw new Error("Compatibility matrix missing node support entries");
}

if (!Array.isArray(data.bun) || data.bun.length === 0) {
  throw new Error("Compatibility matrix missing bun support entries");
}

if (!Array.isArray(data.os) || data.os.length === 0) {
  throw new Error("Compatibility matrix missing os support entries");
}

const srcDir = resolve(process.cwd(), "src");
const sourceFiles = await readdir(srcDir);
const rangePattern = />=\d+\.\d+\.\d+\s+<\d+\.\d+\.\d+/;

for (const file of sourceFiles) {
  if (!file.endsWith(".ts")) {
    continue;
  }

  const filePath = join(srcDir, file);
  const source = await readFile(filePath, "utf8");
  if (rangePattern.test(source)) {
    throw new Error(`Hardcoded semver range found in runtime source: ${filePath}. Use compatibility matrix instead.`);
  }
}

console.log(`compat-matrix-ok ${data.openCode.range}`);
