const TITLE_MAX_LEN = 80;

/**
 * @param {import('discord.js').Message} message
 * @param {'feature' | 'bug'} itemType
 */
export function mapMessageToQaItem(message, itemType) {
  const author = message.author;
  const username =
    author?.globalName ||
    author?.username ||
    (author?.tag ? author.tag.replace(/#\d+$/, '') : 'unknown');

  const guildId = message.guildId ?? message.guild?.id;
  const channelId = message.channelId ?? message.channel?.id;
  const jumpLink =
    guildId && channelId
      ? `https://discord.com/channels/${guildId}/${channelId}/${message.id}`
      : null;

  const rawContent = (message.content ?? '').trim();
  const titleSource = rawContent || firstAttachmentLabel(message) || 'Discord message';
  const title =
    titleSource.length <= TITLE_MAX_LEN
      ? titleSource
      : `${titleSource.slice(0, TITLE_MAX_LEN - 1)}…`;

  const descriptionParts = [`Reported by ${username}`];
  if (rawContent) {
    descriptionParts.push('', rawContent);
  }
  if (jumpLink) {
    descriptionParts.push('', `Message: ${jumpLink}`);
  }

  const screenshotUrl = firstImageAttachmentUrl(message);
  const channelName =
    message.channel?.name ??
    (typeof message.channel?.isThread === 'function' && message.channel.isThread()
      ? message.channel.parent?.name
      : undefined);

  return {
    type: itemType,
    severity: itemType === 'bug' ? 'medium' : 'low',
    title,
    page_or_area: channelName ?? (itemType === 'bug' ? 'report-a-bug' : 'feature-requests'),
    description: descriptionParts.join('\n'),
    steps_to_reproduce: itemType === 'bug' && rawContent ? rawContent : '',
    expected_vs_actual: '',
    screenshot_url: screenshotUrl,
    source: 'discord',
    evidence_links: jumpLink ? [jumpLink] : [],
    status: 'new',
    dedupe_key: `discord:${message.id}`,
  };
}

function firstImageAttachmentUrl(message) {
  for (const attachment of message.attachments?.values?.() ?? []) {
    if (attachment.contentType?.startsWith('image/')) {
      return attachment.url;
    }
    const name = attachment.name?.toLowerCase() ?? '';
    if (/\.(png|jpe?g|gif|webp|bmp|svg)$/.test(name)) {
      return attachment.url;
    }
  }
  return null;
}

function firstAttachmentLabel(message) {
  const first = message.attachments?.first?.() ?? message.attachments?.values?.()?.next?.()?.value;
  if (!first) return '';
  return first.name ? `[Attachment: ${first.name}]` : '[Attachment]';
}

export { TITLE_MAX_LEN };
