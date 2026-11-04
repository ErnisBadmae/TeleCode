import { isAddressedToBot, stripBotMention, withGroupSender, type AddressableMessage } from "../src/group-addressing.js";

const bot = { id: 900, username: "coffeeagents_bot" };
const owner = { id: 1 };
const friend = { id: 2 };

function groupMessage(overrides: Partial<AddressableMessage> = {}): AddressableMessage {
  return { chat: { type: "supergroup" }, from: owner, message_thread_id: 10, ...overrides };
}

function mention(text: string, name: string) {
  const offset = text.indexOf(`@${name}`);
  return { type: "mention", offset, length: name.length + 1 };
}

function command(text: string) {
  return { type: "bot_command", offset: 0, length: text.split(" ")[0]!.length };
}

describe("group addressing", () => {
  it("always answers in private chats", () => {
    expect(isAddressedToBot({ chat: { type: "private" }, from: owner, text: "привет" }, bot)).toBe(true);
    expect(isAddressedToBot(undefined, bot)).toBe(true);
  });

  it("ignores untagged group talk, including tags of other people", () => {
    expect(isAddressedToBot(groupMessage({ text: "как дела?" }), bot)).toBe(false);
    const text = "@rapjra посмотри задачу 5";
    expect(isAddressedToBot(groupMessage({ text, entities: [mention(text, "rapjra")] }), bot)).toBe(false);
    expect(isAddressedToBot(groupMessage({ text: "молодец", reply_to_message: { message_id: 5, from: friend } }), bot))
      .toBe(false);
    expect(isAddressedToBot(groupMessage({ text: "ещё", reply_to_message: { message_id: 7, from: owner } }), bot))
      .toBe(false);
  });

  it("answers when the bot is tagged, by username in any case or by text mention", () => {
    const text = "@rapjra и @CoffeeAgents_bot проверь решение";
    expect(isAddressedToBot(groupMessage({
      text,
      entities: [mention(text, "rapjra"), mention(text, "CoffeeAgents_bot")],
    }), bot)).toBe(true);
    expect(isAddressedToBot(groupMessage({
      text: "Бот, проверь",
      entities: [{ type: "text_mention", offset: 0, length: 3, user: { id: 900, is_bot: true } }],
    }), bot)).toBe(true);
  });

  it("answers a voice reply to the bot, but a text reply still needs the tag", () => {
    const toBot = { message_id: 6, from: { id: 900, is_bot: true } };
    expect(isAddressedToBot(groupMessage({ reply_to_message: toBot }), bot)).toBe(true);
    expect(isAddressedToBot(groupMessage({ text: "Случайно", reply_to_message: toBot }), bot)).toBe(false);
    const text = "@rapjra верно ??";
    expect(isAddressedToBot(groupMessage({ text, entities: [mention(text, "rapjra")], reply_to_message: toBot }), bot))
      .toBe(false);
    const tagged = "@coffeeagents_bot а тут?";
    expect(isAddressedToBot(groupMessage({ text: tagged, entities: [mention(tagged, "coffeeagents_bot")], reply_to_message: toBot }), bot))
      .toBe(true);
  });

  it("tells the agent who wrote a group message", () => {
    expect(withGroupSender(groupMessage({ from: { id: 2, first_name: "Иван", username: "rapjra" } }), "сделай ревью"))
      .toBe("[Telegram group message from Иван (@rapjra, id 2)]\nсделай ревью");
    expect(withGroupSender({ chat: { type: "private" }, from: owner }, "привет")).toBe("привет");
  });

  it("does not treat the implicit forum topic root as a reply", () => {
    expect(isAddressedToBot(groupMessage({
      text: "привет",
      reply_to_message: { message_id: 10, from: { id: 900, is_bot: true }, forum_topic_created: {} },
    }), bot)).toBe(false);
  });

  it("answers its own commands but not another bot's", () => {
    for (const text of ["/new claude sonnet", "/new@CoffeeAgents_bot claude sonnet"]) {
      expect(isAddressedToBot(groupMessage({ text, entities: [command(text)] }), bot)).toBe(true);
    }
    const other = "/new@other_bot claude";
    expect(isAddressedToBot(groupMessage({ text: other, entities: [command(other)] }), bot)).toBe(false);
  });

  it("strips the bot tag so a tagged command still parses", () => {
    const text = "@coffeeagents_bot /new claude sonnet";
    const message = groupMessage({
      text,
      entities: [mention(text, "coffeeagents_bot"), { type: "bot_command", offset: 18, length: 4 }],
    });
    stripBotMention(message, bot);
    expect(message.text).toBe("/new claude sonnet");
    expect(message.entities).toEqual([{ type: "bot_command", offset: 0, length: 4 }]);
  });

  it("strips the tag from the middle or end and keeps other mentions", () => {
    const text = "скажи @rapjra, что @coffeeagents_bot прав";
    const message = groupMessage({ text, entities: [mention(text, "rapjra"), mention(text, "coffeeagents_bot")] });
    stripBotMention(message, bot);
    expect(message.text).toBe("скажи @rapjra, что прав");
    expect(message.entities).toEqual([{ type: "mention", offset: 6, length: 7 }]);

    const tail = groupMessage({ text: "сделай ревью @coffeeagents_bot", entities: [mention("сделай ревью @coffeeagents_bot", "coffeeagents_bot")] });
    stripBotMention(tail, bot);
    expect(tail.text).toBe("сделай ревью");
  });
});
