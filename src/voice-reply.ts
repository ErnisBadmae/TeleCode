import { spawn } from "node:child_process";

/**
 * Voice replies. When a voice note asks to be answered by voice, the agent ends its
 * answer with a <voice> block: a short spoken version written by the agent that holds
 * the context. The bot strips the block from the text answer, sends the text as usual,
 * then sends the block as a Telegram voice note synthesized by any OpenAI-compatible
 * /v1/audio/speech endpoint (OpenAI itself or a local server).
 *
 * Disabled unless TTS_URL is set. TTS_START_COMMAND optionally launches a local TTS
 * server on demand when the endpoint is unreachable.
 */

export const VOICE_REPLY_INSTRUCTION = [
  "[Voice reply: if this voice message asks you to answer by voice, finish your reply with",
  "<voice>...</voice> containing a short spoken version of the answer: 2-5 plain sentences in",
  "the language the user spoke, keeping the essence (the conclusion or result and the next",
  "step). No code, paths, tables, links or markdown inside the block; if the essence does not",
  "fit, say that the details are in the text. Without such a request, do not add the block.]",
].join(" ");

const VOICE_BLOCK = /<voice>([\s\S]*?)<\/voice>\s*$/i;

export function extractVoiceBlock(text: string): { text: string; voice?: string } {
  const match = VOICE_BLOCK.exec(text);
  if (!match) {
    return { text };
  }
  const voice = match[1].trim();
  return { text: text.slice(0, match.index).trimEnd(), ...(voice ? { voice } : {}) };
}

export interface VoiceReplyConfig {
  /** Base URL of an OpenAI-compatible API, e.g. https://api.openai.com or http://127.0.0.1:8020. */
  url: string;
  apiKey?: string;
  model?: string;
  voice?: string;
  /** Shell command that starts a local TTS server when `url` is unreachable. */
  startCommand?: string;
}

export function voiceReplyConfigFromEnv(env: NodeJS.ProcessEnv = process.env): VoiceReplyConfig | undefined {
  const url = env.TTS_URL?.trim().replace(/\/+$/, "");
  if (!url) {
    return undefined;
  }
  const optional = (value: string | undefined) => value?.trim() || undefined;
  return {
    url,
    apiKey: optional(env.TTS_API_KEY),
    model: optional(env.TTS_MODEL),
    voice: optional(env.TTS_VOICE),
    startCommand: optional(env.TTS_START_COMMAND),
  };
}

const START_TIMEOUT_MS = 120_000;
const SYNTH_TIMEOUT_MS = 300_000;

async function isReachable(config: VoiceReplyConfig): Promise<boolean> {
  try {
    // Any HTTP answer means the server is up; only a connection failure means it is not.
    await fetch(config.url, { signal: AbortSignal.timeout(3_000) });
    return true;
  } catch {
    return false;
  }
}

const starting = new Map<string, Promise<void>>();

async function ensureServer(config: VoiceReplyConfig): Promise<void> {
  if (!config.startCommand || await isReachable(config)) {
    return;
  }
  let pending = starting.get(config.url);
  if (!pending) {
    pending = startServer(config).finally(() => starting.delete(config.url));
    starting.set(config.url, pending);
  }
  await pending;
}

async function startServer(config: VoiceReplyConfig): Promise<void> {
  const child = spawn(config.startCommand!, {
    shell: true,
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref();

  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    if (await isReachable(config)) {
      return;
    }
  }
  throw new Error("TTS server did not become reachable after TTS_START_COMMAND");
}

/** Synthesize text into an OGG/Opus voice note. */
export async function synthesizeVoice(config: VoiceReplyConfig, text: string): Promise<Buffer> {
  await ensureServer(config);
  const response = await fetch(`${config.url}/v1/audio/speech`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
    },
    body: JSON.stringify({
      input: text,
      response_format: "opus",
      ...(config.model ? { model: config.model } : {}),
      ...(config.voice ? { voice: config.voice } : {}),
    }),
    signal: AbortSignal.timeout(SYNTH_TIMEOUT_MS),
  });
  if (!response.ok) {
    const detail = (await response.text().catch(() => "")).trim();
    throw new Error(`TTS failed (${response.status}): ${detail || response.statusText}`);
  }
  return Buffer.from(await response.arrayBuffer());
}
