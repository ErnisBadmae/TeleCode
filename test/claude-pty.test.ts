import { vi } from "vitest";

import {
  buildClaudePtyEnv,
  ClaudePty,
  PromptEchoMissingError,
} from "../src/providers/claude-pty.js";

function appendPtyText(pty: ClaudePty, text: string): void {
  (pty as unknown as { rawBuffer: string }).rawBuffer += text;
  (pty as unknown as { receivedBytes: number }).receivedBytes += text.length;
}

function fakeProc(pty: ClaudePty, echoInput = true): Array<{ data: string; at: number }> {
  const writes: Array<{ data: string; at: number }> = [];
  (pty as unknown as { proc: { write: (data: string) => void } }).proc = {
    write: (data: string) => {
      writes.push({ data, at: Date.now() });
      if (echoInput && data !== "\r" && data !== "\x15") {
        appendPtyText(pty, data.replace(/^\x1b\[200~/u, "").replace(/\x1b\[201~$/u, ""));
      }
    },
  };
  return writes;
}

describe("ClaudePty readiness detection", () => {
  it("waits for startup redraws to settle after the first ready footer", async () => {
    const pty = new ClaudePty();
    const startedAt = Date.now();
    appendPtyText(pty, "Ready. ? for shortcuts");
    const ready = pty.waitForReadyPrompt(3000);
    setTimeout(() => appendPtyText(pty, `${"x".repeat(300)} ? for shortcuts`), 150);
    await expect(ready).resolves.toBe("\\?forshortcuts");
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(650);
  });

  it("does not treat the Claude footer as ready while compaction is still producing output", async () => {
    const pty = new ClaudePty();
    const startedAt = Date.now();
    const ready = pty.waitForReadyPrompt(5000);

    appendPtyText(pty, "Compacting conversation... esc to interrupt ? for shortcuts");
    setTimeout(() => {
      appendPtyText(pty, "Compacting conversation... (1s) shift+tab");
    }, 100);
    setTimeout(() => {
      appendPtyText(pty, "Compacting conversation... (2s) ? for shortcuts");
    }, 500);
    setTimeout(() => {
      appendPtyText(pty, "Ready. ? for shortcuts");
    }, 900);

    await expect(ready).resolves.toBe("\\?forshortcuts");
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(2500);
  });
});

describe("ClaudePty child environment", () => {
  it("scrubs inherited Claude Code controls and deliberately restores the configured compact window", () => {
    const env = buildClaudePtyEnv({
      bin: "claude.exe",
      args: [],
      cwd: "C:\\workspace",
      configDir: "C:\\isolated-claude",
      autoCompactWindow: 200000,
    }, {
      PATH: "C:\\bin",
      CLAUDECODE: "1",
      CLAUDE_CODE_AUTO_COMPACT_WINDOW: "999999",
      CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: "1",
    });

    expect(env.PATH).toBe("C:\\bin");
    expect(env.CLAUDECODE).toBeUndefined();
    expect(env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS).toBeUndefined();
    expect(env.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe("200000");
    expect(env.CLAUDE_CONFIG_DIR).toBe("C:\\isolated-claude");
  });
});

describe("ClaudePty prompt delivery", () => {
  it("sends long single-line prompts via bracketed paste and holds Enter until the echo settles", async () => {
    const pty = new ClaudePty();
    const writes = fakeProc(pty);
    const longText = "p".repeat(3000);

    // Simulate the terminal still echoing the paste for ~1.2s after the write.
    let echoStoppedAt = 0;
    const echoInterval = setInterval(() => {
      appendPtyText(pty, "x".repeat(600));
    }, 100);
    setTimeout(() => {
      clearInterval(echoInterval);
      echoStoppedAt = Date.now();
    }, 1200);

    await pty.sendPrompt(longText);

    expect(writes[0]?.data).toBe(`\x1b[200~${longText}\x1b[201~`);
    const enter = writes[writes.length - 1];
    expect(enter?.data).toBe("\r");
    expect(echoStoppedAt).toBeGreaterThan(0);
    expect(enter!.at).toBeGreaterThanOrEqual(echoStoppedAt);
  });

  it("sends short prompts as plain typed text followed by Enter", async () => {
    const pty = new ClaudePty();
    const writes = fakeProc(pty);

    await pty.sendPrompt("hello");

    expect(writes.map((entry) => entry.data)).toEqual(["hello", "\r"]);
  });

  it("still uses bracketed paste for multi-line prompts", async () => {
    const pty = new ClaudePty();
    const writes = fakeProc(pty);

    await pty.sendPrompt("line one\nline two");

    expect(writes[0]?.data).toBe("\x1b[200~line one\nline two\x1b[201~");
    expect(writes[writes.length - 1]?.data).toBe("\r");
  });

  it("does not accept the output-folder line as proof that the user text was pasted", async () => {
    vi.useFakeTimers();
    try {
      const pty = new ClaudePty();
      const writes = fakeProc(pty, false);
      const prompt = [
        "Please repair the session search and restart TeleCode.",
        "",
        "Output files: write any files the user should receive to C:\\workspace\\turns\\abc\\out",
      ].join("\n");

      // This is the 2.1.215 failure mode: terminal chrome plus the output-folder
      // instruction appeared, but the actual user message did not.
      const sending = expect(pty.sendPrompt(prompt)).rejects.toBeInstanceOf(PromptEchoMissingError);
      appendPtyText(
        pty,
        "TeleCode 690046857 bypass permissions on (shift+tab to cycle) " +
          "Output files: write any files the user should receive to C:\\workspace\\turns\\abc\\out",
      );
      await vi.runAllTimersAsync();
      await sending;

      expect(writes.map((entry) => entry.data)).toEqual([`\x1b[200~${prompt}\x1b[201~`]);
    } finally {
      vi.useRealTimers();
    }
  });
});
