import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { enforceCompatibility } from "../src/compatibility.js";
import { PluginError } from "../src/errors.js";

async function createMatrix(range: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "qwen-compat-"));
  const path = join(dir, "matrix.json");
  const nodeMajor = process.versions.node.split(".")[0];
  await writeFile(path, JSON.stringify({
    openCode: { range },
    node: [`${nodeMajor}.x`],
    bun: ["latest"],
    os: [process.platform === "win32" ? "windows" : process.platform === "darwin" ? "macos" : "linux"]
  }), "utf8");
  return path;
}

describe("compatibility", () => {
  it("passes for in-range versions", async () => {
    const path = await createMatrix(">=0.14.0 <1.0.0");
    await expect(enforceCompatibility(path, "0.14.5")).resolves.toMatchObject({
      severity: "info"
    });
  });

  it("fails for out-of-range versions", async () => {
    const path = await createMatrix(">=0.14.0 <1.0.0");
    try {
      await enforceCompatibility(path, "1.2.0");
      throw new Error("expected failure");
    } catch (error) {
      expect(error).toBeInstanceOf(PluginError);
      expect((error as PluginError).code).toBe("E_COMPAT_VERSION_UNSUPPORTED");
      expect((error as PluginError).message).toContain("COMPAT:ERROR:E_COMPAT_VERSION_UNSUPPORTED");
    }
  });

  it("returns warning severity for configured warn ranges", async () => {
    const dir = await mkdtemp(join(tmpdir(), "qwen-compat-warn-"));
    const path = join(dir, "matrix.json");
    await writeFile(path, JSON.stringify({
      openCode: {
        range: ">=0.14.0 <1.0.0",
        warnRanges: [">=0.14.0 <0.14.3"]
      },
      node: [`${process.versions.node.split(".")[0]}.x`],
      bun: ["latest"],
      os: ["windows", "macos", "linux"]
    }), "utf8");

    await expect(enforceCompatibility(path, "0.14.1")).resolves.toMatchObject({
      severity: "warn"
    });
  });

  it("validates bundled compatibility matrix source-of-truth", async () => {
    const { BUNDLED_COMPATIBILITY_MATRIX } = await import("../src/config.js");
    const matrix = BUNDLED_COMPATIBILITY_MATRIX;
    const nodeMajor = Number(process.versions.node.split(".")[0]);
    const supported = matrix.node.some((entry) => entry.startsWith(`${nodeMajor}.`));

    if (supported) {
      await expect(enforceCompatibility(matrix, "0.14.3")).resolves.toMatchObject({
        severity: "info"
      });
      return;
    }

    await expect(enforceCompatibility(matrix, "0.14.3")).rejects.toMatchObject({
      code: "E_COMPAT_VERSION_UNSUPPORTED"
    });
  });
});
