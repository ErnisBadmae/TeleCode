import { readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// The shared skill registers reviewer IDs before/at provider startup. These
// transcripts remain resumable through the helper, outside ordinary browsing.
export function getPeerReviewSessionIds(): Set<string> {
  const root = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), ".local", "state"), "TeleCode", "peer-reviews");
  try {
    return new Set(readdirSync(root)
      .filter((name) => /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\.json$/i.test(name))
      .map((name) => name.slice(0, -5)));
  } catch {
    return new Set();
  }
}
