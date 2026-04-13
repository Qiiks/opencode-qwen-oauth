import { readFile } from "node:fs/promises";
import { ERROR_CODES, PluginError } from "./errors.js";

interface Matrix {
  openCode: {
    range: string;
    warnRanges?: string[];
  };
  node?: string[];
  bun?: string[];
  os?: string[];
}

function parseRange(range: string): { min: string; max: string } {
  const match = range.match(/^>=([^\s]+)\s+<([^\s]+)$/);
  if (!match) {
    throw new Error(`Unsupported semver range format: ${range}`);
  }

  return { min: match[1], max: match[2] };
}

function toParts(version: string): number[] {
  return version.split(".").map((part) => Number(part));
}

function compareVersions(a: string, b: string): number {
  const ap = toParts(a);
  const bp = toParts(b);
  const max = Math.max(ap.length, bp.length);
  for (let i = 0; i < max; i += 1) {
    const av = ap[i] ?? 0;
    const bv = bp[i] ?? 0;
    if (av > bv) {
      return 1;
    }
    if (av < bv) {
      return -1;
    }
  }
  return 0;
}

export async function enforceCompatibility(
  matrixOrPath: string | Matrix,
  opencodeVersion: string
): Promise<{ severity: "info" | "warn"; message: string }> {
  let matrix: Matrix;
  if (typeof matrixOrPath === "string") {
    const raw = await readFile(matrixOrPath, "utf8");
    matrix = JSON.parse(raw) as Matrix;
  } else {
    matrix = matrixOrPath;
  }
  const { min, max } = parseRange(matrix.openCode.range);

  if (compareVersions(opencodeVersion, min) < 0 || compareVersions(opencodeVersion, max) >= 0) {
    throw new PluginError(
      ERROR_CODES.COMPAT_VERSION_UNSUPPORTED,
      `COMPAT:ERROR:E_COMPAT_VERSION_UNSUPPORTED:opencode: supported=${matrix.openCode.range} actual=${opencodeVersion} action=upgrade-or-pin-supported-range`,
      { exitCode: 78, opencodeVersion, supportedRange: matrix.openCode.range }
    );
  }

  const osName = process.platform === "win32" ? "windows" : process.platform === "darwin" ? "macos" : "linux";
  if (matrix.os && !matrix.os.includes(osName)) {
    throw new PluginError(
      ERROR_CODES.COMPAT_VERSION_UNSUPPORTED,
      `COMPAT:ERROR:E_COMPAT_VERSION_UNSUPPORTED:os: supported=${matrix.os.join(",")} actual=${osName} action=use-supported-os`,
      { exitCode: 78, osName, supportedOs: matrix.os }
    );
  }

  const nodeMajor = Number(process.versions.node.split(".")[0]);
  if (matrix.node && !matrix.node.some((entry) => entry.startsWith(`${nodeMajor}.`))) {
    throw new PluginError(
      ERROR_CODES.COMPAT_VERSION_UNSUPPORTED,
      `COMPAT:ERROR:E_COMPAT_VERSION_UNSUPPORTED:node: supported=${matrix.node.join(",")} actual=${process.versions.node} action=use-supported-node`,
      { exitCode: 78, nodeVersion: process.versions.node, supportedNode: matrix.node }
    );
  }

  if (!Array.isArray(matrix.bun) || matrix.bun.length === 0) {
    throw new PluginError(
      ERROR_CODES.COMPAT_VERSION_UNSUPPORTED,
      "COMPAT:ERROR:E_COMPAT_VERSION_UNSUPPORTED:bun: supported=unspecified actual=unknown action=define-bun-support-matrix",
      { exitCode: 78 }
    );
  }

  const bunVersion = (globalThis as { Bun?: { version?: string } }).Bun?.version ?? process.env.BUN_VERSION;
  if (bunVersion) {
    const bunSupported = matrix.bun.some((entry) => {
      if (entry === "latest" || entry === "latest-1") {
        return true;
      }

      if (entry.endsWith(".x")) {
        return bunVersion.startsWith(entry.slice(0, -1));
      }

      return bunVersion.startsWith(entry);
    });

    if (!bunSupported) {
      throw new PluginError(
        ERROR_CODES.COMPAT_VERSION_UNSUPPORTED,
        `COMPAT:ERROR:E_COMPAT_VERSION_UNSUPPORTED:bun: supported=${matrix.bun.join(",")} actual=${bunVersion} action=use-supported-bun`,
        { exitCode: 78, bunVersion, supportedBun: matrix.bun }
      );
    }
  }

  for (const warnRange of matrix.openCode.warnRanges ?? []) {
    const parsedRange = parseRange(warnRange);
    if (
      compareVersions(opencodeVersion, parsedRange.min) >= 0 &&
      compareVersions(opencodeVersion, parsedRange.max) < 0
    ) {
      return {
        severity: "warn",
        message: `COMPAT:WARN:E_COMPAT_DEPRECATED_RANGE:opencode: supported=${matrix.openCode.range} actual=${opencodeVersion} action=upgrade-before-next-release`
      };
    }
  }

  return {
    severity: "info",
    message: `COMPAT:INFO:E_COMPAT_OK:opencode: supported=${matrix.openCode.range} actual=${opencodeVersion} action=none`
  };
}
