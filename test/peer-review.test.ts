import { fork, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { listModels, reviewerEnv, runPeerReview, validateRequest } from "../skills/peer-review/scripts/peer-review.mjs";

const helper = fileURLToPath(new URL("../skills/peer-review/scripts/peer-review.mjs", import.meta.url));
let workspace: string;
let workerPath: string;
let receiptRoot: string;

beforeAll(() => {
  workspace = mkdtempSync(path.join(os.tmpdir(), "telecode-peer-unit-"));
  receiptRoot = path.join(workspace, "receipts");
  workerPath = path.join(workspace, "worker.mjs");
  writeFileSync(workerPath, `
import {spawn} from "node:child_process";
import {writeFileSync} from "node:fs";
import {randomUUID} from "node:crypto";
import path from "node:path";
import {guardWorker} from ${JSON.stringify(pathToFileURL(helper).href)};
process.once("message", (r) => {
  guardWorker(r.timeoutMs);
  if (r.prompt === "hang") {
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {stdio:"ignore", windowsHide:true});
    writeFileSync(path.join(r.cwd, "pids.json"), JSON.stringify({worker:process.pid, child:child.pid}));
    return;
  }
  if (r.prompt === "crash") process.exit(4);
  if (r.prompt === "fail") { process.send({type:"result", result:{ok:false, sessionId:r.providerSessionId, code:"provider_error", error:"unavailable"}}); return; }
  process.send({type:"result", result:{ok:true, sessionId:r.resume ?? r.providerSessionId ?? randomUUID(), answer:r.prompt, applied:{model:r.model,effort:r.effort}}});
});
`);
});

afterAll(() => rmSync(workspace, { recursive: true, force: true }));

function request(overrides = {}) {
  return { provider: "claude", model: "sonnet", effort: "medium", cwd: workspace, prompt: "review", ...overrides };
}
function call(raw = request()) { return runPeerReview(raw, { workerPath, receiptRoot }); }

it("lists only the Codex models the account offers, with their efforts", () => {
  const home = path.join(workspace, "codex-home");
  mkdirSync(home, { recursive: true });
  writeFileSync(path.join(home, "models_cache.json"), JSON.stringify({ fetched_at: "t", models: [
    { slug: "visible-model", display_name: "Visible", visibility: "list", supported_reasoning_levels: [{ effort: "low" }, { effort: "max" }] },
    { slug: "hidden-model", visibility: "hide", supported_reasoning_levels: [] },
  ] }));
  const listed = listModels(home);
  expect(listed.codex.models).toEqual([{ model: "visible-model", name: "Visible", efforts: ["low", "max"] }]);
  expect(listed.claude.models.map((m: { model: string }) => m.model)).toContain("opus");
  expect(listModels(path.join(workspace, "missing")).codex.error).toMatch(/unreadable/);
});

it("requires caller choices rather than filling them from another session", () => {
  for (const key of ["provider", "model", "effort", "cwd"]) {
    const raw = request();
    delete raw[key as keyof typeof raw];
    expect(() => validateRequest(raw)).toThrow();
  }
  expect(() => validateRequest(request({ effort: "ultra" }))).toThrow();
  expect(() => validateRequest(request({ timeoutMs: 0 }))).toThrow();
  expect(() => validateRequest(request({ permissionMode: "bypassPermissions" }))).toThrow();
});

it("keeps authentication while removing competing bridge and inherited effort settings", () => {
  const env = reviewerEnv({ PATH: "path", ANTHROPIC_API_KEY: "auth", CODEX_HOME: "codex-auth", CLAUDE_CODE_OAUTH_TOKEN: "oauth-auth", CLAUDE_CODE_USE_VERTEX: "1", CLAUDE_CODE_GIT_BASH_PATH: "bash-path", CLAUDECODE: "1", CLAUDE_CODE_EFFORT_LEVEL: "max", CLAUDE_CODE_SESSION_ID: "busy", ANTHROPIC_MODEL: "old", TELEGRAM_BOT_TOKEN: "bot", telegram_other_token: "other", TELECODE_MODEL: "old", NODE_OPTIONS: "--require dangerous" });
  expect(env.ANTHROPIC_API_KEY).toBe("auth");
  expect(env.CODEX_HOME).toBe("codex-auth");
  expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe("oauth-auth");
  expect(env.CLAUDE_CODE_USE_VERTEX).toBe("1");
  expect(env.CLAUDE_CODE_GIT_BASH_PATH).toBe("bash-path");
  expect(env.CLAUDE_CODE_EFFORT_LEVEL).toBeUndefined();
  expect(env.CLAUDECODE).toBeUndefined();
  expect(env.ANTHROPIC_MODEL).toBeUndefined();
  expect(env.TELEGRAM_BOT_TOKEN).toBeUndefined();
  expect(env.telegram_other_token).toBeUndefined();
  expect(env.TELECODE_MODEL).toBeUndefined();
  expect(env.NODE_OPTIONS).toBeUndefined();
});

it("round-trips literal prompt text and explicitly resumes only its own reviewer", async () => {
  const prompt = "Belgian café, $(), `backticks`, quotes \" and ' remain text.";
  const first = await call(request({ prompt }));
  expect(first.ok).toBe(true);
  expect(first.answer).toBe(prompt);
  const second = await call(request({ resume: first.sessionId, model: "opus", effort: "high", prompt: "counterargument" }));
  expect(second.ok).toBe(true);
  expect(second.sessionId).toBe(first.sessionId);
  expect(second.requested.model).toBe("opus");
  expect(second.requested.effort).toBe("high");
  expect((await call(request({ resume: "11111111-1111-4111-8111-111111111111" }))).ok).toBe(false);
  expect((await call(request({ resume: first.sessionId, provider: "codex" }))).ok).toBe(false);
  expect((await call(request({ resume: first.sessionId, cwd: os.tmpdir() }))).ok).toBe(false);
});

it("keeps parallel callers' model and effort separate", async () => {
  const [max, medium] = await Promise.all([
    call(request({ model: "opus", effort: "max", prompt: "A" })),
    call(request({ provider: "codex", model: "gpt-6.1-sol", effort: "medium", prompt: "B" })),
  ]);
  expect(max.ok && medium.ok).toBe(true);
  expect(max.sessionId).not.toBe(medium.sessionId);
  expect(max.requested.effort).toBe("max");
  expect(medium.requested.effort).toBe("medium");
  expect(max.applied).toEqual({ model: "opus", effort: "max" });
  expect(medium.applied).toEqual({ model: "gpt-6.1-sol", effort: "medium" });
});

it("settles provider failures and crashes, without allowing an incomplete review to resume", async () => {
  const failed = await call(request({ prompt: "fail" }));
  expect(failed.code).toBe("provider_error");
  const resumed = await call(request({ resume: failed.sessionId }));
  expect(resumed.ok).toBe(false);
  expect(resumed.error).toMatch(/not completed/);
  const crashed = await call(request({ prompt: "crash" }));
  expect(crashed.code).toBe("provider_error");
  expect(crashed.error).toContain("exited before");
});

it("kills both the worker and its descendant on timeout", async () => {
  const result = await call(request({ prompt: "hang", timeoutMs: 1500 }));
  expect(result.code).toBe("timeout");
  expect(existsSync(path.join(workspace, "pids.json"))).toBe(true);
  const pids = JSON.parse(readFileSync(path.join(workspace, "pids.json"), "utf8"));
  for (const pid of [pids.worker, pids.child]) {
    await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow(), { timeout: 3000 });
  }
}, 10_000);

it("reaps the reviewer tree when its caller disappears abruptly", async () => {
  const worker = fork(workerPath, [], { windowsHide: true, detached: process.platform !== "win32", stdio: ["ignore", "ignore", "ignore", "ipc"] });
  const pidFile = path.join(workspace, "pids.json");
  rmSync(pidFile, { force: true });
  worker.send(request({ prompt: "hang", timeoutMs: 10_000 }));
  await vi.waitFor(() => expect(existsSync(pidFile)).toBe(true));
  const pids = JSON.parse(readFileSync(pidFile, "utf8"));
  worker.disconnect();
  for (const pid of [pids.worker, pids.child]) {
    await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow(), { timeout: 5000 });
  }
}, 10_000);

it("runs through an installed skill junction and returns a structured CLI failure", async () => {
  const installed = path.join(workspace, "installed-skill");
  symlinkSync(path.dirname(helper), installed, process.platform === "win32" ? "junction" : "dir");
  const result = await new Promise<{ code: number | null; output: string }>((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(installed, "peer-review.mjs")], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (data) => { output += data.toString(); });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, output }));
    child.stdin.end("{malformed}");
  });
  expect(result.code).toBe(1);
  expect(JSON.parse(result.output).code).toBe("invalid_request");
});
