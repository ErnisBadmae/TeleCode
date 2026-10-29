/**
 * In a group the allowed user also talks to other members. A message that tags another
 * user, or replies to another person, is addressed to them and must not become
 * a prompt. Untagged messages (voice notes included) still reach the agent.
 */

interface MessageUser {
  id: number;
  is_bot?: boolean;
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

export function isAddressedToSomeoneElse(
  message: AddressableMessage | undefined,
  bot: { id: number; username?: string },
): boolean {
  if (!message || message.chat.type === "private") {
    return false;
  }

  const text = message.text ?? message.caption ?? "";
  const entities = message.entities ?? message.caption_entities ?? [];
  const botUsername = bot.username?.toLowerCase();
  let mentionsBot = false;
  let mentionsOther = false;
  for (const entity of entities) {
    if (entity.type === "mention") {
      const name = text.slice(entity.offset + 1, entity.offset + entity.length).toLowerCase();
      if (botUsername && name === botUsername) {
        mentionsBot = true;
      } else {
        mentionsOther = true;
      }
    } else if (entity.type === "text_mention" && entity.user) {
      if (entity.user.id === bot.id) {
        mentionsBot = true;
      } else {
        mentionsOther = true;
      }
    }
  }
  if (mentionsBot) {
    return false;
  }
  if (mentionsOther) {
    return true;
  }

  // Forum topics attach the topic's root service message as reply_to_message even
  // without an explicit reply; only a real reply to another person counts.
  const reply = message.reply_to_message;
  if (!reply || reply.forum_topic_created !== undefined || reply.message_id === message.message_thread_id) {
    return false;
  }
  const replyAuthor = reply.from;
  return Boolean(replyAuthor && !replyAuthor.is_bot && replyAuthor.id !== message.from?.id);
}
