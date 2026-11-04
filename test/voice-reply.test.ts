import { extractVoiceBlock, voiceReplyConfigFromEnv } from "../src/voice-reply.js";

describe("voice reply block", () => {
  it("splits a trailing <voice> block off the text answer", () => {
    const answer = "Tests pass.\n\n```\nnpm test\n```\n\n<voice>\nTests pass and the fix is ready.\n</voice>\n";
    expect(extractVoiceBlock(answer)).toEqual({
      text: "Tests pass.\n\n```\nnpm test\n```",
      voice: "Tests pass and the fix is ready.",
    });
  });

  it("leaves answers without a trailing block untouched", () => {
    expect(extractVoiceBlock("Just text.")).toEqual({ text: "Just text." });
    const quoted = "Use <voice>...</voice> at the end, then more text.";
    expect(extractVoiceBlock(quoted)).toEqual({ text: quoted });
  });

  it("drops an empty block without producing a voice note", () => {
    expect(extractVoiceBlock("Answer.\n<voice> </voice>")).toEqual({ text: "Answer." });
  });
});

describe("voice reply config", () => {
  it("is disabled without TTS_URL", () => {
    expect(voiceReplyConfigFromEnv({ TTS_MODEL: "tts-1" })).toBeUndefined();
    expect(voiceReplyConfigFromEnv({ TTS_URL: "  " })).toBeUndefined();
  });

  it("reads the endpoint and optional settings", () => {
    expect(voiceReplyConfigFromEnv({
      TTS_URL: "https://api.openai.com/",
      TTS_API_KEY: "sk-test",
      TTS_MODEL: "gpt-4o-mini-tts",
      TTS_VOICE: "alloy",
      TTS_START_COMMAND: "",
    })).toEqual({
      url: "https://api.openai.com",
      apiKey: "sk-test",
      model: "gpt-4o-mini-tts",
      voice: "alloy",
      startCommand: undefined,
    });
  });
});
