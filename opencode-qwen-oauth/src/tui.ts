import { stdin, stdout } from "node:process";

export interface MenuItem<T> {
  label: string;
  value: T;
  hint?: string;
  disabled?: boolean;
  separator?: boolean;
  kind?: "heading";
  color?: "red" | "green" | "yellow" | "cyan";
}

export interface SelectOptions {
  title: string;
  subtitle?: string;
  help?: string;
  clearScreen?: boolean;
}

const ANSI = {
  hide: "\x1b[?25l",
  show: "\x1b[?25h",
  up: (n = 1) => `\x1b[${n}A`,
  clearLine: "\x1b[2K",
  clearScreen: "\x1b[2J\x1b[H",
  dim: "\x1b[2m",
  bold: "\x1b[1m",
  cyan: "\x1b[36m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  reset: "\x1b[0m"
} as const;

const ESCAPE_TIMEOUT_MS = 50;

const ANSI_REGEX = /\x1b\[[0-9;]*m/g;

function stripAnsi(inputText: string): string {
  return inputText.replace(ANSI_REGEX, "");
}

function truncateWithAnsi(inputText: string, maxVisibleChars: number): string {
  if (maxVisibleChars <= 0) {
    return "";
  }

  let visibleChars = 0;
  let outputText = "";
  const chars = Array.from(inputText);

  for (let i = 0; i < chars.length; i += 1) {
    const char = chars[i] ?? "";
    if (char === "\x1b") {
      let seq = char;
      i += 1;
      while (i < chars.length) {
        const c = chars[i] ?? "";
        seq += c;
        if (c === "m") {
          break;
        }
        i += 1;
      }
      outputText += seq;
      continue;
    }

    if (visibleChars >= maxVisibleChars) {
      break;
    }

    outputText += char;
    visibleChars += 1;
  }

  return outputText;
}

function isSelectable<T>(item: MenuItem<T>): boolean {
  return !item.disabled && !item.separator && item.kind !== "heading";
}

function colorPrefix(color?: MenuItem<unknown>["color"]): string {
  if (color === "red") return ANSI.red;
  if (color === "green") return ANSI.green;
  if (color === "yellow") return ANSI.yellow;
  if (color === "cyan") return ANSI.cyan;
  return "";
}

function parseKey(buffer: Buffer): "up" | "down" | "enter" | "escape" | "escape-start" | "unknown" {
  const key = buffer.toString("utf8");

  if (key === "\u0003") {
    return "escape";
  }
  if (key === "\r" || key === "\n") {
    return "enter";
  }
  if (key === "\u001b") {
    return "escape-start";
  }
  if (key === "\u001b[A") {
    return "up";
  }
  if (key === "\u001b[B") {
    return "down";
  }

  return "unknown";
}

function findNextSelectable<T>(items: MenuItem<T>[], from: number, direction: 1 | -1): number {
  let idx = from;
  for (let i = 0; i < items.length; i += 1) {
    idx = (idx + direction + items.length) % items.length;
    const item = items[idx];
    if (item && isSelectable(item)) {
      return idx;
    }
  }
  return from;
}

export function isInteractiveTTY(): boolean {
  return Boolean(stdin.isTTY && stdout.isTTY);
}

export async function selectMenu<T>(items: MenuItem<T>[], options: SelectOptions): Promise<T | null> {
  if (!isInteractiveTTY()) {
    return null;
  }

  const enabledCount = items.filter(isSelectable).length;
  if (enabledCount === 0) {
    return null;
  }

  let cursor = items.findIndex(isSelectable);
  if (cursor < 0) {
    cursor = 0;
  }

  let renderedLines = 0;

  const render = () => {
    const columns = stdout.columns ?? 100;
    const width = Math.max(20, columns - 4);

    if (options.clearScreen) {
      stdout.write(ANSI.clearScreen);
    } else if (renderedLines > 0) {
      stdout.write(ANSI.up(renderedLines));
    }

    let lineCount = 0;
    const writeLine = (line: string) => {
      stdout.write(`${ANSI.clearLine}${line}\n`);
      lineCount += 1;
    };

    writeLine(`${ANSI.cyan}${ANSI.bold}${truncateWithAnsi(options.title, width)}${ANSI.reset}`);
    if (options.subtitle) {
      writeLine(`${ANSI.dim}${truncateWithAnsi(options.subtitle, width)}${ANSI.reset}`);
    }
    writeLine(`${ANSI.dim}${"-".repeat(Math.min(width, 60))}${ANSI.reset}`);

    for (let i = 0; i < items.length; i += 1) {
      const item = items[i];
      if (!item) continue;

      if (item.separator) {
        writeLine(`${ANSI.dim}${"-".repeat(Math.min(40, width))}${ANSI.reset}`);
        continue;
      }

      if (item.kind === "heading") {
        writeLine(`${ANSI.bold}${ANSI.dim}${truncateWithAnsi(item.label, width)}${ANSI.reset}`);
        continue;
      }

      const selected = i === cursor;
      const dot = selected ? `${ANSI.green}●${ANSI.reset}` : `${ANSI.dim}○${ANSI.reset}`;
      const prefix = colorPrefix(item.color);
      const base = item.disabled
        ? `${ANSI.dim}${item.label} (unavailable)${ANSI.reset}`
        : prefix
          ? `${prefix}${item.label}${ANSI.reset}`
          : item.label;

      const hint = item.hint ? ` ${ANSI.dim}${item.hint}${ANSI.reset}` : "";
      const line = `${dot} ${truncateWithAnsi(base + hint, width - 2)}`;
      writeLine(line);
    }

    writeLine(`${ANSI.dim}${"-".repeat(Math.min(width, 60))}${ANSI.reset}`);
    writeLine(`${ANSI.dim}${options.help ?? "Up/Down: move  Enter: select  Esc: back"}${ANSI.reset}`);

    if (!options.clearScreen && renderedLines > lineCount) {
      const extra = renderedLines - lineCount;
      for (let i = 0; i < extra; i += 1) {
        writeLine("");
      }
    }

    renderedLines = lineCount;
  };

  return await new Promise<T | null>((resolve) => {
    const previousRawMode = stdin.isRaw ?? false;
    let finished = false;
    let escapeTimeout: ReturnType<typeof setTimeout> | null = null;

    const cleanup = () => {
      if (finished) {
        return;
      }
      finished = true;
      if (escapeTimeout) {
        clearTimeout(escapeTimeout);
        escapeTimeout = null;
      }
      try {
        stdin.removeListener("data", onData);
        stdin.setRawMode(previousRawMode);
        stdin.pause();
      } catch {
        // best effort cleanup
      }
      stdout.write(ANSI.show);
    };

    const done = (value: T | null) => {
      cleanup();
      resolve(value);
    };

    const onData = (buffer: Buffer) => {
      if (escapeTimeout) {
        clearTimeout(escapeTimeout);
        escapeTimeout = null;
      }

      const action = parseKey(buffer);
      if (action === "up") {
        cursor = findNextSelectable(items, cursor, -1);
        render();
        return;
      }
      if (action === "down") {
        cursor = findNextSelectable(items, cursor, 1);
        render();
        return;
      }
      if (action === "enter") {
        const selected = items[cursor];
        done(selected && isSelectable(selected) ? selected.value : null);
        return;
      }
      if (action === "escape") {
        done(null);
        return;
      }
      if (action === "escape-start") {
        // Wait briefly in case this is an arrow-key escape sequence split across reads.
        escapeTimeout = setTimeout(() => {
          done(null);
        }, ESCAPE_TIMEOUT_MS);
      }
    };

    try {
      stdin.setRawMode(true);
      stdin.resume();
      stdout.write(ANSI.hide);
      render();
      stdin.on("data", onData);
    } catch {
      done(null);
    }
  });
}

export async function confirmMenu(message: string, defaultYes = false): Promise<boolean> {
  const yesOption: MenuItem<boolean> = { label: "Yes", value: true, color: "green" };
  const noOption: MenuItem<boolean> = { label: "No", value: false, color: "red" };
  const selection = await selectMenu(defaultYes ? [yesOption, noOption] : [noOption, yesOption], {
    title: message,
    subtitle: "Confirm action",
    clearScreen: false
  });

  return selection === true;
}

export function plainText(inputText: string): string {
  return stripAnsi(inputText);
}
