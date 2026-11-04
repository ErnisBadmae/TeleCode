/**
 * In a group the owner also talks to other people, so a group message becomes a
 * prompt only when it is explicitly addressed to the bot:
 * - it tags the bot (@username or a text mention of the bot user);
 * - it starts with a bot command (`/new`, or `/new@this_bot`; `/new@other_bot` is not ours);
 * - it has no text at all (a voice note) and replies to one of the bot's messages:
 *   a voice note cannot carry a tag. A text reply to the bot still needs the tag,
 *   because people quote the bot's answers while talking to each other.
 * Everything else in a group is conversation between people and is ignored.
 * Private chats are always addressed to the bot.
 */

interface MessageUser {
  id: number;
  is_bot?: boolean;
  first_name?: string;
  last_name?: string;
  username?: string;
}

interface MessageEntity {
  type: string;
  offset: number;
  length: number;
  user?: MessageUser;
}

export interface AddressableMessage {
  chat: { type: string };
  from?: MessageUser;
  message_thread_id?: number;
  text?: string;
  caption?: string;
  entities?: MessageEntity[];
  caption_entities?: MessageEntity[];
  reply_to_message?: {
    message_id: number;
    from?: MessageUser;
    forum_topic_created?: unknown;
  };
}

interface BotIdentity {
  id: number;
  username?: string;
}

function isBotMention(text: string, entity: MessageEntity, bot: BotIdentity): boolean {
  if (entity.type === "text_mention") {
    return entity.user?.id === bot.id;
  }
  if (entity.type !== "mention" || !bot.username) {
    return false;
  }
  const name = text.slice(entity.offset + 1, entity.offset + entity.length);
  return name.toLowerCase() === bot.username.toLowerCase();
}

export function isAddressedToBot(message: AddressableMessage | undefined, bot: BotIdentity): boolean {
  if (!message || message.chat.type === "private") {
    return true;
  }

  const text = message.text ?? message.caption ?? "";
  const entities = message.entities ?? message.caption_entities ?? [];
  if (entities.some((entity) => isBotMention(text, entity, bot))) {
    return true;
  }

  const command = entities.find((entity) => entity.type === "bot_command" && entity.offset === 0);
  if (command) {
    const commandText = text.slice(0, command.length);
    const at = commandText.indexOf("@");
    if (at < 0) {
      return true;
    }
    return Boolean(bot.username) && commandText.slice(at + 1).toLowerCase() === bot.username!.toLowerCase();
  }

  if (message.text !== undefined || message.caption !== undefined) {
    return false;
  }

  // Forum topics attach the topic's root service message as reply_to_message even
  // without an explicit reply; only a real reply to the bot counts.
  const reply = message.reply_to_message;
  if (!reply || reply.forum_topic_created !== undefined || reply.message_id === message.message_thread_id) {
    return false;
  }
  return reply.from?.id === bot.id;
}

/**
 * Removes the bot's own tag from a group message so the agent gets the request
 * itself and a tagged command (`@bot /new claude`) still parses as a command.
 * Mutates the message in place and shifts the remaining entity offsets.
 */
export function stripBotMention(message: AddressableMessage | undefined, bot: BotIdentity): void {
  if (!message || message.chat.type === "private") {
    return;
  }
  const field = message.text !== undefined ? "text" : message.caption !== undefined ? "caption" : undefined;
  if (!field) {
    return;
  }
  const entitiesField = field === "text" ? "entities" : "caption_entities";
  let text = message[field]!;
  let entities = [...(message[entitiesField] ?? [])];
  const mentions = entities
    .filter((entity) => isBotMention(text, entity, bot))
    .sort((a, b) => b.offset - a.offset);
  if (mentions.length === 0) {
    return;
  }

  for (const mention of mentions) {
    let start = mention.offset;
    let end = mention.offset + mention.length;
    // Drop one separator next to the tag: "@bot, сделай" / "сделай @bot".
    while (end < text.length && /[\s,:]/.test(text[end]!)) {
      end += 1;
    }
    if (end === mention.offset + mention.length) {
      while (start > 0 && /\s/.test(text[start - 1]!)) {
        start -= 1;
      }
    }
    const removed = end - start;
    text = text.slice(0, start) + text.slice(end);
    entities = entities
      .filter((entity) => entity.offset + entity.length <= start || entity.offset >= end)
      .map((entity) => (entity.offset >= end ? { ...entity, offset: entity.offset - removed } : entity));
  }

  const leading = text.length - text.trimStart().length;
  text = text.trim();
  entities = entities
    .map((entity) => ({ ...entity, offset: entity.offset - leading }))
    .filter((entity) => entity.offset >= 0 && entity.offset + entity.length <= text.length);

  message[field] = text;
  message[entitiesField] = entities;
}

/**
 * In a group several people talk to the same agent session; prefix the prompt with
 * the sender so the agent knows who asked. Private chats stay unchanged.
 */
export function withGroupSender(message: AddressableMessage | undefined, prompt: string): string {
  if (!message || message.chat.type === "private" || !message.from) {
    return prompt;
  }
  const { first_name, last_name, username, id } = message.from;
  const name = [first_name, last_name].filter(Boolean).join(" ") || "user";
  const handle = username ? `@${username}, ` : "";
  return `[Telegram group message from ${name} (${handle}id ${id})]\n${prompt}`;
}
