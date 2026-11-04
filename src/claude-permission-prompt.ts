import { randomUUID } from "node:crypto";

import { escapeHTML } from "./format.js";
import type { AgentPermissionDecision, AgentPermissionRequest } from "./providers/types.js";

/**
 * Telegram approval for Claude tool calls outside the allow rules. The SDK
 * bridge has no terminal, so without this every such call was auto-denied.
 */

export const CLAUDE_PERMISSION_CALLBACK = /^cperm:(a|s|d):([0-9a-f]{12})$/;

export type PermissionSettleReason = "answered" | "timeout" | "aborted" | "failed";

const DECISION_BY_CODE: Record<string, AgentPermissionDecision> = {
  a: "allow",
  s: "allow_always",
  d: "deny",
};

const MAX_DETAIL_CHARS = 1500;

export function permissionCallbackData(code: "a" | "s" | "d", id: string): string {
  return `cperm:${code}:${id}`;
}

export class PermissionPromptRegistry {
  private readonly pending = new Map<string, (decision: AgentPermissionDecision) => void>();

  constructor(private readonly timeoutMs: number) {}

  get size(): number {
    return this.pending.size;
  }

  /**
   * Resolves with the user's decision. `show` posts the prompt; `settled` updates
   * it once answered. Timeout, turn abort, and a failed post all deny.
   */
  request(
    request: AgentPermissionRequest,
    show: (id: string) => Promise<void>,
    settled: (decision: AgentPermissionDecision, reason: PermissionSettleReason) => Promise<void>,
  ): Promise<AgentPermissionDecision> {
    const id = randomUUID().replace(/-/g, "").slice(0, 12);
    return new Promise((resolve) => {
      let done = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const onAbort = (): void => finish("deny", "aborted");
      const finish = (decision: AgentPermissionDecision, reason: PermissionSettleReason): void => {
        if (done) {
          return;
        }
        done = true;
        if (timer) {
          clearTimeout(timer);
        }
        request.signal.removeEventListener("abort", onAbort);
        this.pending.delete(id);
        resolve(decision);
        void settled(decision, reason).catch(() => {});
      };

      if (request.signal.aborted) {
        finish("deny", "aborted");
        return;
      }
      timer = setTimeout(() => finish("deny", "timeout"), this.timeoutMs);
      timer.unref?.();
      request.signal.addEventListener("abort", onAbort, { once: true });
      this.pending.set(id, (decision) => finish(decision, "answered"));
      show(id).catch(() => finish("deny", "failed"));
    });
  }

  /** Applies a button press; undefined when the request is gone (answered, expired, restart). */
  answer(id: string, code: string): AgentPermissionDecision | undefined {
    const decision = DECISION_BY_CODE[code];
    const resolve = this.pending.get(id);
    if (!decision || !resolve) {
      return undefined;
    }
    resolve(decision);
    return decision;
  }
}

export function formatPermissionPrompt(request: AgentPermissionRequest): { html: string; plain: string } {
  const heading = request.title?.trim() || `Claude wants to use ${request.toolName}`;
  const detail = permissionDetail(request);
  const description = request.description?.trim();
  const reason = request.decisionReason?.trim();
  const html = [
    `🔐 <b>${escapeHTML(heading)}</b>`,
    detail ? `<pre>${escapeHTML(detail)}</pre>` : "",
    description ? `<i>${escapeHTML(description)}</i>` : "",
    request.blockedPath ? `Path: <code>${escapeHTML(request.blockedPath)}</code>` : "",
    reason ? `Reason: ${escapeHTML(reason)}` : "",
  ].filter(Boolean).join("\n");
  const plain = [
    `🔐 ${heading}`,
    detail,
    description ?? "",
    request.blockedPath ? `Path: ${request.blockedPath}` : "",
    reason ? `Reason: ${reason}` : "",
  ].filter(Boolean).join("\n");
  return { html, plain };
}

export function formatPermissionOutcome(
  decision: AgentPermissionDecision,
  reason: PermissionSettleReason,
  timeoutMinutes: number,
): string {
  if (reason === "timeout") {
    return `⌛ No answer within ${timeoutMinutes} min, denied.`;
  }
  if (reason === "aborted") {
    return "⏹ The turn ended before an answer, denied.";
  }
  if (reason === "failed") {
    return "Denied: the prompt could not be shown.";
  }
  if (decision === "allow_always") {
    return "♾ Always allowed.";
  }
  return decision === "allow" ? "✅ Allowed." : "❌ Denied.";
}

function permissionDetail(request: AgentPermissionRequest): string {
  const input = request.input;
  const pick = (key: string): string | undefined =>
    typeof input[key] === "string" && (input[key] as string).trim() ? (input[key] as string) : undefined;
  const text = pick("command") ?? pick("url") ?? pick("query") ?? pick("file_path") ?? pick("path")
    ?? (Object.keys(input).length ? JSON.stringify(input, null, 2) : "");
  return text.length > MAX_DETAIL_CHARS ? `${text.slice(0, MAX_DETAIL_CHARS)}…` : text;
}
