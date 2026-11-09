import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { summarizeVideo, videoSummaryConfigured } from "../src/video-summary.js";

describe("video-summary", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "telecode-video-"));
    process.env.VIDEO_SUMMARY_PYTHON = process.execPath; // node stands in for python
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    delete process.env.VIDEO_SUMMARY_PYTHON;
    delete process.env.VIDEO_SUMMARY_SCRIPT;
  });

  it("reads the summary file named on the last stdout line", async () => {
    const summary = path.join(dir, "abc.summary.txt");
    writeFileSync(summary, "Кратко\nо видео", "utf8");
    const script = path.join(dir, "fake.js");
    writeFileSync(script, `console.log("progress"); console.log(${JSON.stringify(summary)});`, "utf8");
    process.env.VIDEO_SUMMARY_SCRIPT = script;

    expect(videoSummaryConfigured()).toBe(true);
    await expect(summarizeVideo("https://youtu.be/abc")).resolves.toBe("Кратко\nо видео");
  });

  it("rejects with the stderr tail when the script fails", async () => {
    const script = path.join(dir, "fail.js");
    writeFileSync(script, `console.error("не удалось скачать звук"); process.exit(1);`, "utf8");
    process.env.VIDEO_SUMMARY_SCRIPT = script;

    await expect(summarizeVideo("https://youtu.be/abc")).rejects.toThrow("не удалось скачать звук");
  });
});
