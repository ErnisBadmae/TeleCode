import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";

import * as pty from "node-pty";

import { stripOutputFilesInstruction } from "../attachments.js";

const ANSI_PATTERN = /\x1b\[[0-9;?]*[a-zA-Z]|\x1b\][^\x07]*\x07|\x1b[=>]|\r/g;
const BUFFER_LIMIT = 256 * 1024;
// Prompts longer than this are sent via bracketed paste even without newlines.
const LONG_PROMPT_PASTE_THRESHOLD = 200;
// Per-poll output growth below this counts as "quiet" while waiting for input to settle;
// cursor-blink repaints are tiny, paste echo bursts are not.
const INPUT_SETTLE_QUIET_BYTES = 256;

export interface ClaudePtySpawnOptions {
  bin: string;
  args: string[];
  cwd: string;
  /** Isolated CLAUDE_CONFIG_DIR so the child does not load the user-scoped telegram plugin. */
  configDir?: string;
  /** Effective window Claude Code uses when deciding when to auto-compact. */
  autoCompactWindow?: number;
  /** Applied after the CLAUDE_CODE_* scrub, so vendor auth survives it. */
  extraEnv?: Record<string, string>;
  cols?: number;
  rows?: number;
}

/** Prompt text was written but never appeared in the CLI's input box, so Enter was not pressed. */
export class PromptEchoMissingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PromptEchoMissingError";
  }
}

export class ClaudePty extends EventEmitter {
  private proc: pty.IPty | null = null;
  private rawBuffer = "";
  // Monotonic byte counter; rawBuffer is capped at BUFFER_LIMIT so its length
  // cannot be used to detect whether output is still flowing.
  private receivedBytes = 0;
  private exited = false;

  spawn(options: ClaudePtySpawnOptions): void {
    if (this.proc) {
      throw new Error("Claude PTY is already spawned");
    }

    const env = buildClaudePtyEnv(options);

    this.proc = pty.spawn(options.bin, options.args, {
      cwd: options.cwd,
      cols: options.cols ?? 120,
      rows: options.rows ?? 40,
      env,
      name: process.platform === "win32" ? "xterm-256color" : "xterm-color",
    });

    this.proc.onData((data) => {
      this.rawBuffer += data;
      this.receivedBytes += data.length;
      if (this.rawBuffer.length > BUFFER_LIMIT) {
        this.rawBuffer = this.rawBuffer.slice(-BUFFER_LIMIT);
      }
    });

    this.proc.onExit(({ exitCode }) => {
      this.exited = true;
      this.emit("exit", exitCode);
    });
  }

  get pid(): number | undefined {
    return this.proc?.pid;
  }

  get isAlive(): boolean {
    return Boolean(this.proc && !this.exited);
  }

  strippedText(): string {
    return stripAnsi(this.rawBuffer);
  }

  clearBuffer(): void {
    this.rawBuffer = "";
  }

  async waitForMarker(patterns: RegExp[], timeoutMs: number): Promise<string | null> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() <= deadline) {
      const compact = this.strippedText().replace(/\s+/g, "").toLowerCase();
      for (const pattern of patterns) {
        if (pattern.test(compact)) {
          return pattern.source;
        }
      }
      await sleep(250);
    }
    return null;
  }

  async waitForReadyPrompt(timeoutMs: number): Promise<string | null> {
    const deadline = Date.now() + timeoutMs;
    const busyQuietMs = 2500;
    const readyQuietMs = 500;
    let previousRawLength = this.rawBuffer.length;
    let previousReceivedBytes = this.receivedBytes;
    let lastRenderAt = Date.now();
    let lastBusyAt = 0;
    let readyAfterBusy: { source: string; at: number } | null = null;

    while (Date.now() <= deadline) {
      const now = Date.now();
      const raw = this.rawBuffer;
      const rawDelta = raw.length >= previousRawLength
        ? raw.slice(previousRawLength)
        : raw;
      previousRawLength = raw.length;
      // The first footer can paint before the renderer accepts input. Wait for
      // its startup redraws to settle; tiny cursor repaints must not delay forever.
      if (this.receivedBytes - previousReceivedBytes > INPUT_SETTLE_QUIET_BYTES) {
        lastRenderAt = now;
      }
      previousReceivedBytes = this.receivedBytes;

      const compactDelta = stripAnsi(rawDelta).replace(/\s+/g, "").toLowerCase();
      const newBusy = lastMatchingMarker(CLAUDE_BUSY_MARKERS, compactDelta);
      const newReady = lastMatchingMarker(CLAUDE_READY_MARKERS, compactDelta);
      if (newBusy) {
        lastBusyAt = now;
        readyAfterBusy = null;
      } else if (newReady) {
        readyAfterBusy = { source: newReady.source, at: now };
      }

      const compactTail = this.strippedText().slice(-4000).replace(/\s+/g, "").toLowerCase();
      const tailBusy = lastMatchingMarker(CLAUDE_BUSY_MARKERS, compactTail);
      const tailReady = lastMatchingMarker(CLAUDE_READY_MARKERS, compactTail);
      if (!lastBusyAt && tailReady && !tailBusy && now - lastRenderAt >= readyQuietMs) {
        return tailReady.source;
      }
      if (lastBusyAt && readyAfterBusy && now - lastBusyAt >= busyQuietMs && now - lastRenderAt >= readyQuietMs) {
        return readyAfterBusy.source;
      }
      await sleep(250);
    }
    return null;
  }

  typeText(text: string): void {
    this.requireProc().write(text);
  }

  pressEnter(): void {
    this.requireProc().write("\r");
  }

  pressEscape(): void {
    this.requireProc().write("\x1b");
  }

  clearInput(): void {
    this.requireProc().write("\x15");
  }

  async sendPrompt(text: string): Promise<void> {
    // Echo validation must only inspect terminal output produced by this send. Keeping
    // an earlier prompt in the capture buffer could otherwise make a failed repeat look
    // successful and cause us to press Enter on corrupted input.
    this.clearBuffer();
    // Bracketed paste for anything multi-line or long: character-at-a-time input of a
    // long text is slow and can trip TUI shortcuts, and paste is what interactive use does.
    const paste = /\r|\n/.test(text) || text.length > LONG_PROMPT_PASTE_THRESHOLD;
    if (paste) {
      this.requireProc().write(`\x1b[200~${text}\x1b[201~`);
      await this.waitForInputSettled(text.length, 400);
    } else {
      this.requireProc().write(text);
      await this.waitForInputSettled(text.length, 150);
    }
    // Never press Enter blind. A CLI update can change input handling under the bridge
    // (2.1.215 did); blind Enter then submits screen junk as a real API turn. Only submit
    // once the typed text (or the CLI's collapsed-paste placeholder) is visibly echoed.
    if (!(await this.waitForPromptEcho(text, 4000))) {
      throw new PromptEchoMissingError(
        "Claude's input box never echoed the prompt text; refusing to press Enter.",
      );
    }
    this.pressEnter();
  }

  /**
   * True once the input echo for the actual user text is on screen, or the CLI shows its
   * "[Pasted text #N +M lines]" collapse marker. TeleCode's output-folder instruction is
   * deliberately excluded: Claude 2.1.215 once echoed only that line while replacing the
   * user's message with TUI chrome. Compares whitespace-stripped so input-box wrapping
   * and redraw splits cannot cause misses.
   */
  private async waitForPromptEcho(text: string, timeoutMs: number): Promise<boolean> {
    const userText = stripOutputFilesInstruction(text).trim() || text.trim();
    const compactText = userText.replace(/\s+/g, "");
    // The input box shows the head of short input but may scroll to the cursor for long
    // input, so accept either end of the user-controlled portion as proof of the echo.
    const probes = [...new Set([compactText.slice(0, 24), compactText.slice(-24)].filter(Boolean))];
    if (probes.length === 0) {
      return true;
    }
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      // sendPrompt clears rawBuffer immediately before writing, so the whole bounded
      // buffer belongs to this delivery attempt. Keep the first echo even if later TUI
      // repaint traffic would push it outside a small tail window.
      const compactTail = this.strippedText().replace(/\s+/g, "");
      if (
        probes.some((probe) => compactTail.includes(probe)) ||
        /\[Pastedtext#\d+(?:\+\d+lines?)?\]/i.test(compactTail)
      ) {
        return true;
      }
      if (Date.now() > deadline) {
        return false;
      }
      await sleep(250);
    }
  }

  /**
   * Wait until the terminal has finished ingesting typed/pasted input before Enter is
   * pressed. A fixed delay submits long prompts mid-paste: Claude then runs a truncated
   * message, the transcript echo never matches, and the turn is burned. After the
   * historical minimum delay, require the output stream to go quiet (echo/redraw burst
   * finished), bounded by a length-scaled deadline so a busy repaint loop cannot stall us.
   */
  private async waitForInputSettled(promptLength: number, minWaitMs: number): Promise<void> {
    await sleep(minWaitMs);
    const deadline = Date.now() + Math.min(20000, Math.max(minWaitMs, promptLength * 3));
    let lastReceived = this.receivedBytes;
    let quietPolls = 0;
    while (Date.now() <= deadline) {
      await sleep(150);
      const growth = this.receivedBytes - lastReceived;
      lastReceived = this.receivedBytes;
      if (growth < INPUT_SETTLE_QUIET_BYTES) {
        quietPolls += 1;
        if (quietPolls >= 2) {
          return;
        }
      } else {
        quietPolls = 0;
      }
    }
  }

  async sendCommand(command: string): Promise<void> {
    this.requireProc().write(command);
    await sleep(150);
    this.pressEnter();
  }

  async dispose(graceful: boolean): Promise<void> {
    const proc = this.proc;
    if (!proc) {
      return;
    }

    if (graceful && !this.exited) {
      try {
        proc.write("/exit");
        await sleep(150);
        proc.write("\r");
        if (await this.waitForExit(10000)) {
          this.proc = null;
          return;
        }
      } catch {
        // Fall through to kill.
      }
    }

    if (proc.pid && process.platform === "win32") {
      await taskkill(proc.pid);
    } else {
      try {
        proc.kill();
      } catch {
        // Fall through to state cleanup.
      }
    }
    await this.waitForExit(1500);
    this.proc = null;
  }

  private async waitForExit(timeoutMs: number): Promise<boolean> {
    if (this.exited) {
      return true;
    }
    return await new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.off("exit", onExit);
        resolve(false);
      }, timeoutMs);
      const onExit = (): void => {
        clearTimeout(timer);
        resolve(true);
      };
      this.once("exit", onExit);
    });
  }

  private requireProc(): pty.IPty {
    if (!this.proc || this.exited) {
      throw new Error("Claude PTY is not running");
    }
    return this.proc;
  }
}

export function buildClaudePtyEnv(
  options: ClaudePtySpawnOptions,
  sourceEnv: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(sourceEnv)) {
    if (value !== undefined) {
      env[key] = value;
    }
  }
  for (const key of Object.keys(env)) {
    if (key === "CLAUDECODE" || key.startsWith("CLAUDE_CODE_")) {
      delete env[key];
    }
  }
  if (
    options.autoCompactWindow !== undefined &&
    Number.isSafeInteger(options.autoCompactWindow) &&
    options.autoCompactWindow > 0
  ) {
    env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = String(options.autoCompactWindow);
  }
  if (options.configDir) {
    env.CLAUDE_CONFIG_DIR = options.configDir;
  } else {
    delete env.CLAUDE_CONFIG_DIR;
  }
  for (const [key, value] of Object.entries(options.extraEnv ?? {})) {
    env[key] = value;
  }
  return env;
}

export const CLAUDE_TRUST_MARKERS = [/trustthisfolder/];
export const CLAUDE_FULLSCREEN_PROMPT_MARKERS = [/trythenewfullscreenrenderer/];
export const CLAUDE_RESUME_WARNING_MARKERS = [/resumefromsummary/, /resumefullsessionasis/];
export const CLAUDE_READY_MARKERS = [
  /shift\+tab/,
  /\?forshortcuts/,
  /bypasspermissionson/,
  /accepteditson/,
  /←foragents/,
  /foragents/,
];
export const CLAUDE_BUSY_MARKERS = [/compactingconversation/, /esc(?:to)?interrupt/];

function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, "");
}

function lastMatchingMarker(patterns: RegExp[], text: string): { source: string; index: number } | null {
  let latest: { source: string; index: number } | null = null;
  for (const pattern of patterns) {
    const index = lastPatternIndex(pattern, text);
    if (index >= 0 && (!latest || index > latest.index)) {
      latest = { source: pattern.source, index };
    }
  }
  return latest;
}

function lastPatternIndex(pattern: RegExp, text: string): number {
  const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
  const globalPattern = new RegExp(pattern.source, flags);
  let latest = -1;
  for (const match of text.matchAll(globalPattern)) {
    if (typeof match.index === "number") {
      latest = match.index;
    }
  }
  return latest;
}

function taskkill(pid: number): Promise<void> {
  return new Promise((resolve) => {
    const child = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], {
      windowsHide: true,
      stdio: "ignore",
    });
    child.on("exit", () => resolve());
    child.on("error", () => resolve());
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
