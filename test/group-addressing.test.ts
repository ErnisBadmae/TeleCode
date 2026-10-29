import { isAddressedToSomeoneElse, type AddressableMessage } from "../src/group-addressing.js";

const bot = { id: 900, username: "example_bot" };
const user = { id: 1 };
const member = { id: 2 };

function groupMessage(overrides: Partial<AddressableMessage> = {}): AddressableMessage {
  return { chat: { type: "supergroup" }, from: user, message_thread_id: 10, ...overrides };
}

function mention(text: string, name: string) {
  const offset = text.indexOf(`@${name}`);
  return { type: "mention", offset, length: name.length + 1 };
}

describe("group addressing", () => {
  it("lets untagged group messages and private chats through", () => {
    expect(isAddressedToSomeoneElse(groupMessage({ text: "solve this" }), bot)).toBe(false);
    expect(isAddressedToSomeoneElse({ chat: { type: "private" }, from: user, text: "@alice hi",
      entities: [mention("@alice hi", "alice")] }, bot)).toBe(false);
    expect(isAddressedToSomeoneElse(undefined, bot)).toBe(false);
  });

  it("skips a message that tags another member", () => {
    const text = "@alice look at task 5";
    expect(isAddressedToSomeoneElse(groupMessage({ text, entities: [mention(text, "alice")] }), bot)).toBe(true);
    expect(isAddressedToSomeoneElse(groupMessage({
      text: "Alice, look",
      entities: [{ type: "text_mention", offset: 0, length: 5, user: member }],
    }), bot)).toBe(true);
  });

  it("answers when the bot is tagged, even alongside someone else", () => {
    const text = "@alice and @Example_Bot check the solution";
    expect(isAddressedToSomeoneElse(groupMessage({
      text,
      entities: [mention(text, "alice"), mention(text, "Example_Bot")],
    }), bot)).toBe(false);
  });

  it("skips a reply to another person but not to the bot or to oneself", () => {
    expect(isAddressedToSomeoneElse(groupMessage({ text: "well done", reply_to_message: { message_id: 5, from: member } }), bot))
      .toBe(true);
    expect(isAddressedToSomeoneElse(groupMessage({
      text: "go on",
      reply_to_message: { message_id: 6, from: { id: 900, is_bot: true } },
    }), bot)).toBe(false);
    expect(isAddressedToSomeoneElse(groupMessage({ text: "more", reply_to_message: { message_id: 7, from: user } }), bot))
      .toBe(false);
  });

  it("ignores the implicit topic-root reply even in a topic another member created", () => {
    expect(isAddressedToSomeoneElse(groupMessage({
      text: "hello",
      reply_to_message: { message_id: 10, from: member, forum_topic_created: {} },
    }), bot)).toBe(false);
  });
});
