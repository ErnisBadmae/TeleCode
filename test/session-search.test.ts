import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { zstdCompressSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  buildFtsQuery,
  createSessionSearchIndex,
  stripTeleCodePlumbing,
  type SessionSearchIndex,
} from "../src/session-search.js";

const OUTPUT_INSTRUCTION = "Output files: write any files the user should receive to C:\\ws\\.telecode\\turns\\abc\\out";

function claudeUserLine(text: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: "user",
    cwd: "C:\\ws",
    message: { role: "user", content: [{ type: "text", text }] },
    ...extra,
  });
}

function claudeAssistantLine(text: string): string {
  return JSON.stringify({
    type: "assistant",
    message: { role: "assistant", content: [{ type: "text", text }] },
  });
}

function codexMessageLine(role: "user" | "assistant", text: string): string {
  return JSON.stringify({
    timestamp: "2026-07-01T10:00:00.000Z",
    type: "response_item",
    payload: { type: "message", role, content: [{ type: "input_text", text }] },
  });
}

function codexMetaLine(id: string, cwd: string): string {
  return JSON.stringify({
    timestamp: "2026-07-01T10:00:00.000Z",
    type: "session_meta",
    payload: { id, cwd },
  });
}

describe("session search index", () => {
  let root: string;
  let index: SessionSearchIndex | null;

  const claudeDir = () => path.join(root, "claude-projects");
  const codexDir = () => path.join(root, "codex-sessions");
  const archivedDir = () => path.join(root, "codex-archived");

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "telecode-search-"));
    mkdirSync(path.join(claudeDir(), "C--ws"), { recursive: true });
    mkdirSync(path.join(codexDir(), "2026", "07"), { recursive: true });
    index = createSessionSearchIndex({
      indexPath: path.join(root, "state", "session-index.sqlite"),
      claudeProjectsDir: claudeDir(),
      codexSessionsDir: codexDir(),
      codexArchivedSessionsDir: archivedDir(),
    });
  });

  afterEach(() => {
    index?.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("finds words from the middle of a Claude conversation", async () => {
    expect(index).not.toBeNull();
    writeFileSync(
      path.join(claudeDir(), "C--ws", "11111111-2222-3333-4444-555555555555.jsonl"),
      [
        claudeUserLine(`hey can you check something for me\n\n${OUTPUT_INSTRUCTION}`),
        claudeAssistantLine("Sure, what do you need?"),
        claudeUserLine(`I want to look at the housing market around Mechelen and what a notary costs\n\n${OUTPUT_INSTRUCTION}`),
        claudeAssistantLine("The housing market in that area has cooled a bit since last year."),
      ].join("\n"),
    );

    await index!.refresh();
    const result = index!.search("housing mechelen");
    expect(result.totalMatches).toBe(1);
    expect(result.hits[0]).toMatchObject({
      provider: "claude",
      sessionId: "11111111-2222-3333-4444-555555555555",
      workspace: "C:\\ws",
    });
    expect(result.hits[0]!.snippet.toLowerCase()).toContain("housing");
  });

  it("requires every word to appear in the same session", async () => {
    writeFileSync(
      path.join(claudeDir(), "C--ws", "aaaa1111-2222-3333-4444-555555555555.jsonl"),
      [claudeUserLine("my monthly allowance and savings split"), claudeAssistantLine("Noted.")].join("\n"),
    );
    await index!.refresh();

    expect(index!.search("allowance savings").totalMatches).toBe(1);
    expect(index!.search("allowance mortgage").totalMatches).toBe(0);
  });

  it("matches word prefixes so inflections are found", async () => {
    writeFileSync(
      path.join(claudeDir(), "C--ws", "bbbb1111-2222-3333-4444-555555555555.jsonl"),
      [claudeUserLine("let us talk about my personal finances today")].join("\n"),
    );
    await index!.refresh();

    expect(index!.search("financ").totalMatches).toBe(1);
  });

  it("indexes Codex rollouts and derives a clean title from the real first message", async () => {
    writeFileSync(
      path.join(codexDir(), "2026", "07", "rollout-2026-07-01T10-00-00-99999999-8888-7777-6666-555555555555.jsonl"),
      [
        codexMetaLine("99999999-8888-7777-6666-555555555555", "C:\\ws"),
        codexMessageLine("user", "<user_instructions>ignore me</user_instructions>"),
        codexMessageLine("user", "<recommended_plugins>Here is a list of plugins available but not installed</recommended_plugins>"),
        codexMessageLine("user", `${OUTPUT_INSTRUCTION}\n\nCan you research buying a house in Belgium`),
        codexMessageLine("assistant", "Registration duty in Flanders is worth checking first."),
      ].join("\n"),
    );

    await index!.refresh();
    const result = index!.search("registration duty");
    expect(result.totalMatches).toBe(1);
    expect(result.hits[0]).toMatchObject({
      provider: "codex",
      sessionId: "99999999-8888-7777-6666-555555555555",
      workspace: "C:\\ws",
    });
    expect(result.hits[0]!.title.toLowerCase()).toContain("house");
    expect(result.hits[0]!.title).not.toContain("Output files");
    expect(index!.search("instructions ignore").totalMatches).toBe(0);
    expect(index!.search("plugins installed").totalMatches).toBe(0);
  });

  it("indexes zstd-compressed and archived Codex rollouts", async () => {
    const id = "aaaa9999-8888-7777-6666-555555555555";
    writeFileSync(
      path.join(codexDir(), "2026", "07", `rollout-2026-07-01T10-00-00-${id}.jsonl.zst`),
      zstdCompressSync(Buffer.from([
        codexMetaLine(id, "C:\\ws"),
        codexMessageLine("user", "Did Hermoso fix the blank Instagram messages"),
      ].join("\n"))),
    );
    mkdirSync(path.join(archivedDir(), "2026"), { recursive: true });
    writeFileSync(
      path.join(archivedDir(), "2026", "rollout-2026-06-01T10-00-00-bbbb9999-8888-7777-6666-555555555555.jsonl.zst"),
      zstdCompressSync(Buffer.from(codexMessageLine("user", "archived chat about saxophones"))),
    );

    await index!.refresh();
    expect(index!.search("hermoso blank").hits[0]).toMatchObject({ provider: "codex", sessionId: id });
    expect(index!.search("saxophones").hits[0]).toMatchObject({
      sessionId: "bbbb9999-8888-7777-6666-555555555555",
    });
  });

  it("indexes only the plain rollout while Codex is mid-compression", async () => {
    const base = path.join(codexDir(), "2026", "07", "rollout-2026-07-01T10-00-00-cccc9999-8888-7777-6666-555555555555.jsonl");
    writeFileSync(base, codexMessageLine("user", "duplicate check about marimbas"));
    writeFileSync(`${base}.zst`, zstdCompressSync(Buffer.from(codexMessageLine("user", "duplicate check about marimbas"))));

    await index!.refresh();
    expect(index!.search("marimbas").totalMatches).toBe(1);
  });

  it("keeps a provider's rows when its directory is missing", async () => {
    writeFileSync(
      path.join(codexDir(), "2026", "07", "rollout-2026-07-01T10-00-00-dddd9999-8888-7777-6666-555555555555.jsonl"),
      codexMessageLine("user", "session about theremins"),
    );
    await index!.refresh();
    expect(index!.search("theremins").totalMatches).toBe(1);

    rmSync(codexDir(), { recursive: true, force: true });
    await index!.refresh();
    expect(index!.search("theremins").totalMatches).toBe(1);
  });

  it("picks up changes to an already indexed transcript", async () => {
    const filePath = path.join(claudeDir(), "C--ws", "cccc1111-2222-3333-4444-555555555555.jsonl");
    writeFileSync(filePath, claudeUserLine("first topic about trains"));
    await index!.refresh();
    expect(index!.search("zeppelin").totalMatches).toBe(0);

    writeFileSync(filePath, [claudeUserLine("first topic about trains"), claudeUserLine("now about a zeppelin")].join("\n"));
    // File size changed, so the refresh must re-read it even if mtime granularity is coarse.
    const future = new Date(Date.now() + 5000);
    utimesSync(filePath, future, future);
    await index!.refresh();
    expect(index!.search("zeppelin").totalMatches).toBe(1);
  });

  it("removes deleted transcripts on refresh", async () => {
    const filePath = path.join(claudeDir(), "C--ws", "dddd1111-2222-3333-4444-555555555555.jsonl");
    writeFileSync(filePath, claudeUserLine("temporary session about kayaks"));
    await index!.refresh();
    expect(index!.search("kayaks").totalMatches).toBe(1);

    rmSync(filePath);
    await index!.refresh();
    expect(index!.search("kayaks").totalMatches).toBe(0);
  });

  it("skips Claude subagent transcript directories", async () => {
    mkdirSync(path.join(claudeDir(), "C--ws", "subagents"), { recursive: true });
    writeFileSync(
      path.join(claudeDir(), "C--ws", "subagents", "eeee1111-2222-3333-4444-555555555555.jsonl"),
      claudeUserLine("subagent chatter about quokkas"),
    );
    await index!.refresh();
    expect(index!.search("quokkas").totalMatches).toBe(0);
  });

  it("reports ready only after the first full refresh", async () => {
    expect(index!.status().ready).toBe(false);
    await index!.refresh();
    expect(index!.status().ready).toBe(true);
  });
});

describe("stripTeleCodePlumbing", () => {
  it("drops the output-files instruction wherever it appears", () => {
    expect(stripTeleCodePlumbing(`${OUTPUT_INSTRUCTION}\n\nreal words`)).toBe("real words");
    expect(stripTeleCodePlumbing(`real words\n\n${OUTPUT_INSTRUCTION}`)).toBe("real words");
    expect(stripTeleCodePlumbing(OUTPUT_INSTRUCTION)).toBe("");
  });
});

describe("buildFtsQuery", () => {
  it("quotes terms and adds prefix matching", () => {
    expect(buildFtsQuery("housing market")).toBe('"housing"* "market"*');
  });

  it("strips FTS syntax from hostile input", () => {
    expect(buildFtsQuery('col:"x" OR (1)')).toBe('"colx"* "OR"* "1"*');
    expect(buildFtsQuery("\"*() ")).toBe("");
  });
});
