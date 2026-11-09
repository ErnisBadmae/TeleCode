import { spawn } from "node:child_process";
import path from "node:path";
import { readFile } from "node:fs/promises";

// Скачать, расшифровать и пересказать видео может минут десять на длинном ролике; полчаса — с запасом.
const TIMEOUT_MS = 30 * 60 * 1000;

export function videoSummaryConfigured(): boolean {
  return Boolean(process.env.VIDEO_SUMMARY_PYTHON?.trim() && process.env.VIDEO_SUMMARY_SCRIPT?.trim());
}

/**
 * Runs the external video_summary.py (yt-dlp → Whisper → local LLM) and returns the summary text.
 * The script prints the summary file path as its last stdout line.
 */
export function summarizeVideo(url: string): Promise<string> {
  const python = process.env.VIDEO_SUMMARY_PYTHON?.trim();
  const script = process.env.VIDEO_SUMMARY_SCRIPT?.trim();
  if (!python || !script) {
    return Promise.reject(new Error("VIDEO_SUMMARY_PYTHON and VIDEO_SUMMARY_SCRIPT are not configured"));
  }

  return new Promise<string>((resolve, reject) => {
    const child = spawn(python, [script, url], {
      cwd: path.dirname(script),
      env: { ...process.env, PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8" },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString("utf8")).slice(-4000);
    });
    const timer = setTimeout(() => child.kill(), TIMEOUT_MS);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      if (code !== 0) {
        const tail = (stderr || stdout).trim().split("\n").slice(-5).join("\n");
        reject(new Error(`video summary failed (${signal ?? `exit ${code}`}): ${tail}`));
        return;
      }
      const summaryPath = stdout.trim().split("\n").pop()?.trim() ?? "";
      readFile(summaryPath, "utf8").then(resolve, reject);
    });
  });
}
