import { existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { zstdDecompress } from "node:zlib";

import { OUTPUT_FILES_INSTRUCTION_PREFIX } from "./attachments.js";
import { bridgeLog } from "./bridge-log.js";
import { cleanSessionTitle, deriveSessionTitle } from "./bot-ui.js";

export interface SessionSearchHit {
  provider: "claude" | "codex";
  sessionId: string;
  filePath: string;
  workspace: string;
  title: string;
  updatedAt: number;
  snippet: string;
}

export interface SessionSearchResult {
  hits: SessionSearchHit[];
  totalMatches: number;
}

export interface SessionSearchStatus {
  available: boolean;
  /** True once at least one full refresh has completed since the index file was created. */
  ready: boolean;
  refreshing: boolean;
  indexedFiles: number;
  /** Files discovered but not yet indexed during the current refresh. */
  pendingFiles: number;
}

export interface SessionSearchOptions {
  indexPath: string;
  claudeProjectsDir: string;
  codexSessionsDir: string;
  codexArchivedSessionsDir?: string;
}

const zstdDecompressAsync = promisify(zstdDecompress);

/** Per-message and per-session caps keep pathological transcripts from bloating the index. */
const MAX_MESSAGE_CHARS = 4000;
const MAX_SESSION_CHARS = 600_000;

/**
 * Bump when extraction logic changes. Unchanged transcript files are never
 * re-read, so without this stamp a logic change would leave stale extractions
 * in the index forever.
 */
const EXTRACTION_VERSION = "2";

/** Codex rollouts wrap non-conversational context in user messages that start with these tags. */
const SKIPPED_MESSAGE_TAGS = /^<(?:user_instructions|environment_context|turn_context|permissions|recommended_plugins|user_shell|system)[\s>]/i;

/** Injected instruction payloads (AGENTS.md, global instructions) recorded as user messages. */
const SKIPPED_INSTRUCTION_PREFIXES = /^#{1,6}\s*(?:AGENTS\.md|Global codex)/i;

type JsonObject = Record<string, unknown>;

type SqliteStatement = {
  all(...args: unknown[]): unknown[];
  get(...args: unknown[]): unknown;
  run(...args: unknown[]): unknown;
};

type SqliteDatabase = {
  prepare(sql: string): SqliteStatement;
  exec(sql: string): void;
  pragma(text: string): unknown;
  close(): void;
};

type SqliteCtor = new (path: string, options?: { readonly?: boolean; fileMustExist?: boolean }) => SqliteDatabase;

const betterSqlite3Module = await import("better-sqlite3").catch(() => null);
const BetterSqlite3 = (
  (betterSqlite3Module as { default?: SqliteCtor } | null)?.default ??
  (betterSqlite3Module as SqliteCtor | null)
) as SqliteCtor | null;

export function createSessionSearchIndex(options: SessionSearchOptions): SessionSearchIndex | null {
  if (!BetterSqlite3) {
    return null;
  }
  return new SessionSearchIndex(options, BetterSqlite3);
}

/**
 * Full-text index over Claude transcript jsonl files and Codex rollout jsonl files.
 * Only conversational text (user prompts and assistant replies) is indexed; tool
 * output, reasoning, and TeleCode plumbing (the "Output files:" instruction and
 * command wrappers) are stripped. Refreshes are incremental by file mtime+size,
 * so only transcripts that changed since the last refresh are re-read.
 */
export class SessionSearchIndex {
  private db: SqliteDatabase | null = null;
  private refreshPromise: Promise<void> | null = null;
  private pendingFiles = 0;

  constructor(
    private readonly options: SessionSearchOptions,
    private readonly ctor: SqliteCtor,
  ) {}

  /**
   * The database file lives in the workspace's .telecode directory and is opened
   * on first use, so merely constructing a bot never touches disk or holds a file
   * handle (Windows cannot delete a directory containing an open SQLite file).
   */
  private ensureDb(): SqliteDatabase {
    if (this.db) {
      return this.db;
    }
    mkdirSync(path.dirname(this.options.indexPath), { recursive: true });
    const db = new this.ctor(this.options.indexPath);
    db.pragma("journal_mode = WAL");
    db.exec(`
      CREATE TABLE IF NOT EXISTS files (
        path TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        session_id TEXT NOT NULL,
        workspace TEXT NOT NULL DEFAULT '',
        title TEXT NOT NULL DEFAULT '',
        updated_at INTEGER NOT NULL DEFAULT 0,
        mtime_ms REAL NOT NULL,
        size INTEGER NOT NULL
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS docs USING fts5(content, path UNINDEXED);
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    `);
    const storedVersion = (db.prepare("SELECT value FROM meta WHERE key = 'extraction_version'").get() as
      | { value: string }
      | undefined)?.value;
    if (storedVersion !== EXTRACTION_VERSION) {
      db.exec("DELETE FROM docs; DELETE FROM files; DELETE FROM meta;");
      db.prepare("INSERT INTO meta (key, value) VALUES ('extraction_version', ?)").run(EXTRACTION_VERSION);
    }
    this.db = db;
    return db;
  }

  status(): SessionSearchStatus {
    let indexedFiles = 0;
    let ready = false;
    try {
      const db = this.ensureDb();
      indexedFiles = Number((db.prepare("SELECT count(*) AS n FROM files").get() as { n: number }).n);
      ready = Boolean(db.prepare("SELECT value FROM meta WHERE key = 'ready'").get());
    } catch {
      // Treat unreadable state as an empty index.
    }
    return {
      available: true,
      ready,
      refreshing: this.refreshPromise !== null,
      indexedFiles,
      pendingFiles: this.pendingFiles,
    };
  }

  /**
   * Bring the index up to date with the transcripts on disk. Concurrent callers
   * share one in-flight refresh. Work yields to the event loop between files so
   * the initial multi-hundred-MB build does not stall the Telegram bot.
   */
  refresh(): Promise<void> {
    if (!this.refreshPromise) {
      this.refreshPromise = this.runRefresh().finally(() => {
        this.refreshPromise = null;
        this.pendingFiles = 0;
      });
    }
    return this.refreshPromise;
  }

  search(query: string, limit = 10): SessionSearchResult {
    const match = buildFtsQuery(query);
    if (!match) {
      return { hits: [], totalMatches: 0 };
    }

    try {
      const db = this.ensureDb();
      const rows = db.prepare(`
        SELECT f.provider, f.session_id, f.path, f.workspace, f.title, f.updated_at,
               snippet(docs, 0, '', '', ' ... ', 14) AS snip
        FROM docs
        JOIN files f ON f.path = docs.path
        WHERE docs MATCH ?
        ORDER BY f.updated_at DESC
        LIMIT ?
      `).all(match, limit) as Array<{
        provider: string;
        session_id: string;
        path: string;
        workspace: string;
        title: string;
        updated_at: number;
        snip: string;
      }>;
      const total = Number((db.prepare(
        "SELECT count(*) AS n FROM docs WHERE docs MATCH ?",
      ).get(match) as { n: number }).n);

      return {
        totalMatches: total,
        hits: rows.map((row) => ({
          provider: row.provider === "claude" ? "claude" : "codex",
          sessionId: row.session_id,
          filePath: row.path,
          workspace: row.workspace,
          title: row.title,
          updatedAt: row.updated_at,
          snippet: normalizeWhitespace(row.snip),
        })),
      };
    } catch {
      // An FTS syntax error from hostile input degrades to "no results".
      return { hits: [], totalMatches: 0 };
    }
  }

  close(): void {
    try {
      this.db?.close();
    } catch {
      // Ignore close failures.
    }
    this.db = null;
  }

  private async runRefresh(): Promise<void> {
    const db = this.ensureDb();
    const claudeRoots = [this.options.claudeProjectsDir].filter((dir) => dir && existsSync(dir));
    const codexRoots = [this.options.codexSessionsDir, this.options.codexArchivedSessionsDir ?? ""]
      .filter((dir) => dir && existsSync(dir));
    const claudeFiles = claudeRoots.flatMap((dir) => listJsonlFiles(dir, { skipDirNames: new Set(["subagents"]) }));
    const codexFiles = dropCompressedDuplicates(codexRoots.flatMap((dir) => listJsonlFiles(dir, { allowZst: true })));
    const candidates = [
      ...claudeFiles.map((filePath) => ({ filePath, provider: "claude" as const })),
      ...codexFiles.map((filePath) => ({ filePath, provider: "codex" as const })),
    ];
    // A provider whose directory is missing (unset HOME, unmounted drive) keeps its
    // rows; only a directory that was actually scanned can prove a file is gone.
    const scannedProviders = new Set<string>([
      ...(claudeRoots.length > 0 ? ["claude"] : []),
      ...(codexRoots.length > 0 ? ["codex"] : []),
    ]);

    const known = new Map<string, { provider: string; mtime_ms: number; size: number }>();
    for (const row of db.prepare("SELECT path, provider, mtime_ms, size FROM files").all() as Array<{
      path: string;
      provider: string;
      mtime_ms: number;
      size: number;
    }>) {
      known.set(row.path, { provider: row.provider, mtime_ms: row.mtime_ms, size: row.size });
    }

    const seen = new Set<string>();
    const stale: Array<{ filePath: string; provider: "claude" | "codex"; mtimeMs: number; size: number }> = [];
    for (const candidate of candidates) {
      let mtimeMs = 0;
      let size = 0;
      try {
        const stat = statSync(candidate.filePath);
        mtimeMs = stat.mtimeMs;
        size = stat.size;
      } catch {
        continue;
      }
      seen.add(candidate.filePath);
      const existing = known.get(candidate.filePath);
      if (!existing || existing.mtime_ms !== mtimeMs || existing.size !== size) {
        stale.push({ ...candidate, mtimeMs, size });
      }
    }

    let removed = 0;
    for (const [knownPath, row] of known) {
      if (!seen.has(knownPath) && scannedProviders.has(row.provider)) {
        this.removeFile(knownPath);
        removed += 1;
      }
    }

    this.pendingFiles = stale.length;
    let failed = 0;
    for (const entry of stale) {
      try {
        await this.indexFile(entry);
      } catch (error) {
        failed += 1;
        const reason = error instanceof Error ? error.message : String(error);
        console.warn(`Failed to index session transcript ${entry.filePath}:`, reason);
        bridgeLog("search", `index failed path=${entry.filePath} error=${reason}`);
      }
      this.pendingFiles -= 1;
      await yieldToEventLoop();
    }

    db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('ready', '1')").run();
    if (stale.length > 0 || removed > 0) {
      bridgeLog(
        "search",
        `refresh claude=${claudeFiles.length} codex=${codexFiles.length} indexed=${stale.length - failed} ` +
          `failed=${failed} removed=${removed} claudeDir=${claudeRoots.join(";") || "missing"} ` +
          `codexDirs=${codexRoots.join(";") || "missing"}`,
      );
    }
  }

  private removeFile(filePath: string): void {
    const db = this.ensureDb();
    db.prepare("DELETE FROM docs WHERE path = ?").run(filePath);
    db.prepare("DELETE FROM files WHERE path = ?").run(filePath);
  }

  private async indexFile(entry: {
    filePath: string;
    provider: "claude" | "codex";
    mtimeMs: number;
    size: number;
  }): Promise<void> {
    const bytes = await readFile(entry.filePath);
    const raw = (entry.filePath.endsWith(".zst") ? await zstdDecompressAsync(bytes) : bytes).toString("utf8");
    const extracted = entry.provider === "claude"
      ? extractClaudeSession(raw, entry.filePath)
      : extractCodexSession(raw, entry.filePath);

    const db = this.ensureDb();
    this.removeFile(entry.filePath);
    db.prepare(`
      INSERT INTO files (path, provider, session_id, workspace, title, updated_at, mtime_ms, size)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      entry.filePath,
      entry.provider,
      extracted.sessionId,
      extracted.workspace,
      extracted.title,
      Math.round(entry.mtimeMs),
      entry.mtimeMs,
      entry.size,
    );
    db.prepare("INSERT INTO docs (content, path) VALUES (?, ?)").run(
      `${extracted.title}\n${extracted.content}`,
      entry.filePath,
    );
  }
}

interface ExtractedSession {
  sessionId: string;
  workspace: string;
  title: string;
  content: string;
}

function extractClaudeSession(raw: string, filePath: string): ExtractedSession {
  const parts: string[] = [];
  let total = 0;
  let workspace = "";
  let explicitTitle = "";
  let firstUserText = "";

  for (const line of raw.split(/\r?\n/)) {
    if (total >= MAX_SESSION_CHARS) {
      break;
    }
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    let entry: JsonObject;
    try {
      entry = JSON.parse(trimmed) as JsonObject;
    } catch {
      continue;
    }

    if (typeof entry.cwd === "string" && entry.cwd.trim() && !workspace) {
      workspace = entry.cwd;
    }

    if (entry.type === "ai-title" && typeof entry.aiTitle === "string" && entry.aiTitle.trim()) {
      explicitTitle = cleanSessionTitle(entry.aiTitle);
      continue;
    }
    if (entry.type === "custom-title" && typeof entry.customTitle === "string") {
      const candidate = cleanSessionTitle(entry.customTitle);
      if (candidate && !/^(?:telecode|telecodex)(?:\s+\S+)?$/i.test(candidate) && candidate.toLowerCase() !== "claude code") {
        explicitTitle = candidate;
      }
      continue;
    }

    let text = "";
    if (entry.type === "user" && entry.isMeta !== true && entry.isCompactSummary !== true) {
      text = extractMessageText(entry, "text");
      if (looksLikeCommandWrapper(text)) {
        continue;
      }
      text = stripTeleCodePlumbing(text);
      if (text && !firstUserText) {
        firstUserText = text;
      }
    } else if (entry.type === "assistant") {
      text = extractMessageText(entry, "text");
    } else {
      continue;
    }

    if (!text) {
      continue;
    }
    const clipped = text.slice(0, MAX_MESSAGE_CHARS);
    parts.push(clipped);
    total += clipped.length;
  }

  return {
    sessionId: path.basename(filePath, ".jsonl"),
    workspace,
    title: explicitTitle || deriveSessionTitle(firstUserText) || "",
    content: parts.join("\n"),
  };
}

function extractCodexSession(raw: string, filePath: string): ExtractedSession {
  const parts: string[] = [];
  let total = 0;
  let sessionId = "";
  let workspace = "";
  let firstUserText = "";

  for (const line of raw.split(/\r?\n/)) {
    if (total >= MAX_SESSION_CHARS) {
      break;
    }
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    let entry: JsonObject;
    try {
      entry = JSON.parse(trimmed) as JsonObject;
    } catch {
      continue;
    }

    const payload = asObject(entry.payload);
    if (!payload) {
      continue;
    }

    if (entry.type === "session_meta") {
      if (typeof payload.id === "string" && payload.id) {
        sessionId = payload.id;
      }
      if (typeof payload.cwd === "string" && payload.cwd) {
        workspace = payload.cwd;
      }
      continue;
    }

    if (entry.type !== "response_item" || payload.type !== "message") {
      continue;
    }
    const role = payload.role;
    if (role !== "user" && role !== "assistant") {
      continue;
    }

    let text = extractContentText(payload.content);
    const head = text.trimStart();
    if (!text || SKIPPED_MESSAGE_TAGS.test(head) || SKIPPED_INSTRUCTION_PREFIXES.test(head)) {
      continue;
    }
    text = stripTeleCodePlumbing(text);
    if (!text) {
      continue;
    }
    if (role === "user" && !firstUserText) {
      firstUserText = text;
    }

    const clipped = text.slice(0, MAX_MESSAGE_CHARS);
    parts.push(clipped);
    total += clipped.length;
  }

  return {
    sessionId: sessionId || sessionIdFromRolloutFilename(filePath),
    workspace,
    title: deriveSessionTitle(firstUserText) || "",
    content: parts.join("\n"),
  };
}

/**
 * Remove TeleCode plumbing from a message: the per-turn "Output files:" instruction
 * (prepended in old Codex sessions, appended everywhere else) and staged-file
 * boilerplate lines, keeping the user's actual words.
 */
export function stripTeleCodePlumbing(text: string): string {
  const kept = text
    .split(/\r?\n/)
    .filter((line) => {
      const trimmed = line.trim();
      if (trimmed.startsWith(OUTPUT_FILES_INSTRUCTION_PREFIX)) {
        return false;
      }
      if (/^Write any output files to: /.test(trimmed)) {
        return false;
      }
      if (trimmed === "The user will receive files from that directory after this turn completes.") {
        return false;
      }
      return true;
    })
    .join("\n");
  return kept.trim();
}

function looksLikeCommandWrapper(text: string): boolean {
  const trimmed = text.trimStart();
  return trimmed.startsWith("<local-command-caveat>") ||
    trimmed.startsWith("<command-name>") ||
    trimmed.startsWith("<local-command-stdout>") ||
    trimmed.startsWith("<task-notification>") ||
    trimmed.startsWith("<system-reminder>") ||
    trimmed.startsWith("Caveat: The messages below");
}

function sessionIdFromRolloutFilename(filePath: string): string {
  const base = path.basename(filePath).replace(/\.jsonl(?:\.zst)?$/, "");
  const uuid = base.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  return uuid?.[0] ?? base;
}

/** Extract concatenated text blocks from a Claude transcript message entry. */
function extractMessageText(entry: JsonObject, blockType: string): string {
  const message = asObject(entry.message);
  const content = message?.content;
  if (typeof content === "string") {
    return content.trim();
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .map((block) => {
      if (typeof block === "string") {
        return block;
      }
      const blockObject = asObject(block);
      if (blockObject && blockObject.type === blockType && typeof blockObject.text === "string") {
        return blockObject.text;
      }
      return "";
    })
    .filter((text) => {
      const head = text.trimStart();
      // Harness-injected context rides along in user messages as extra text
      // blocks; indexing it would make its words match every session.
      return Boolean(head) && !head.startsWith("<system-reminder>") && !head.startsWith("Caveat: The messages below");
    })
    .join("\n")
    .trim();
}

/** Extract text from a Codex rollout message content array. */
function extractContentText(content: unknown): string {
  if (typeof content === "string") {
    return content.trim();
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .map((item) => {
      const record = asObject(item);
      if (!record) {
        return "";
      }
      if (typeof record.text === "string") {
        return record.text;
      }
      if (typeof record.input_text === "string") {
        return record.input_text;
      }
      return "";
    })
    .filter(Boolean)
    .join("\n")
    .trim();
}

/**
 * Turn free-form user words into an FTS5 query: every term must appear, each as
 * a prefix match, so "financ" finds "finances" and "financial".
 */
export function buildFtsQuery(query: string): string {
  const terms = query
    .split(/\s+/)
    .map((term) => term.replace(/[^\p{L}\p{N}]+/gu, ""))
    .filter(Boolean);
  if (terms.length === 0) {
    return "";
  }
  return terms.map((term) => `"${term}"*`).join(" ");
}

/**
 * Codex writes `x.jsonl.zst` before deleting `x.jsonl`, so a scan can see both.
 * The plain file is the one still being appended to.
 */
function dropCompressedDuplicates(files: string[]): string[] {
  const plain = new Set(files.filter((file) => file.endsWith(".jsonl")));
  return files.filter((file) => !file.endsWith(".zst") || !plain.has(file.slice(0, -".zst".length)));
}

function listJsonlFiles(dir: string, options: { skipDirNames?: Set<string>; allowZst?: boolean }): string[] {
  if (!dir || !existsSync(dir)) {
    return [];
  }
  const results: string[] = [];
  const visit = (current: string): void => {
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (!options.skipDirNames?.has(entry.name.toLowerCase())) {
          visit(fullPath);
        }
      } else if (entry.isFile() && (entry.name.endsWith(".jsonl") || (options.allowZst && entry.name.endsWith(".jsonl.zst")))) {
        results.push(fullPath);
      }
    }
  };
  visit(dir);
  return results;
}

function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function asObject(value: unknown): JsonObject | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonObject
    : undefined;
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}
