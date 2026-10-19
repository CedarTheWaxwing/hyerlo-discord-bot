import {
  ChannelType,
  Client,
  GatewayIntentBits,
  Partials,
} from 'discord.js';
import { ControlCenterClient } from './control-center-client.js';
import { mapMessageToQaItem } from './qa-item-mapper.js';

const BACKFILL_LIMIT = 100;
const FEATURE_CHANNEL_NAME = 'feature-requests';
const BUG_CHANNEL_NAME = 'report-a-bug';

/**
 * @param {{ onError?: (err: Error, context: string) => void }} [options]
 */
export async function startChannelWatcher(options = {}) {
  const onError =
    options.onError ??
    ((err, context) => {
      console.error(`[channel-watcher] ${context}:`, err.message);
    });

  const baseUrl = process.env.CONTROL_CENTER_URL;
  const apiKey = process.env.CONTROL_CENTER_BOT_API_KEY;
  const basicUser = process.env.CONTROL_CENTER_BASIC_USER;
  const basicPassword = process.env.CONTROL_CENTER_BASIC_PASSWORD;
  const token = process.env.DISCORD_TOKEN;
  const hasBasicAuth = Boolean(basicUser && basicPassword);
  const hasBearerAuth = Boolean(apiKey);

  if (!token) {
    console.warn('[channel-watcher] DISCORD_TOKEN missing; QA channel watcher not started.');
    return null;
  }
  if (!baseUrl || (!hasBasicAuth && !hasBearerAuth)) {
    console.warn(
      '[channel-watcher] CONTROL_CENTER_URL missing or no Control Center credentials (set CONTROL_CENTER_BASIC_USER/PASSWORD and/or CONTROL_CENTER_BOT_API_KEY); QA channel watcher not started.',
    );
    return null;
  }

  const controlCenter = new ControlCenterClient({
    baseUrl,
    apiKey,
    basicUser,
    basicPassword,
    onError,
  });

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
    partials: [Partials.Channel, Partials.Message],
  });

  /** @type {Map<string, 'feature' | 'bug'>} */
  const monitoredChannelTypes = new Map();

  const resolveMonitoredChannels = () => {
    monitoredChannelTypes.clear();
    const featureId = process.env.FEATURE_REQUESTS_CHANNEL_ID;
    const bugId = process.env.REPORT_BUG_CHANNEL_ID;

    if (featureId) {
      monitoredChannelTypes.set(featureId, 'feature');
    }
    if (bugId) {
      monitoredChannelTypes.set(bugId, 'bug');
    }

    for (const guild of client.guilds.cache.values()) {
      for (const channel of guild.channels.cache.values()) {
        if (!featureId && channel.name === FEATURE_CHANNEL_NAME) {
          if (
            channel.type === ChannelType.GuildText ||
            channel.type === ChannelType.GuildForum ||
            channel.type === ChannelType.GuildAnnouncement
          ) {
            monitoredChannelTypes.set(channel.id, 'feature');
          }
        }
        if (!bugId && channel.name === BUG_CHANNEL_NAME) {
          if (
            channel.type === ChannelType.GuildText ||
            channel.type === ChannelType.GuildForum ||
            channel.type === ChannelType.GuildAnnouncement
          ) {
            monitoredChannelTypes.set(channel.id, 'bug');
          }
        }
      }
    }

    if (monitoredChannelTypes.size === 0) {
      console.warn(
        '[channel-watcher] No monitored channels found (feature-requests / report-a-bug).',
      );
    } else {
      console.log(
        '[channel-watcher] Monitoring channels:',
        [...monitoredChannelTypes.entries()]
          .map(([id, type]) => `${id} (${type})`)
          .join(', '),
      );
    }
  };

  const itemTypeForMessage = (message) => {
    const channel = message.channel;
    if (!channel) return null;
    const direct = monitoredChannelTypes.get(channel.id);
    if (direct) return direct;
    const parentId =
      typeof channel.isThread === 'function' && channel.isThread()
        ? channel.parentId
        : null;
    if (parentId) {
      return monitoredChannelTypes.get(parentId) ?? null;
    }
    return null;
  };

  const handleMessage = (message) => {
    try {
      if (!message || message.author?.bot) return;
      const itemType = itemTypeForMessage(message);
      if (!itemType) return;
      const item = mapMessageToQaItem(message, itemType);
      controlCenter.enqueue(item);
    } catch (err) {
      onError(err instanceof Error ? err : new Error(String(err)), 'handleMessage');
    }
  };

  client.on('messageCreate', handleMessage);

  client.on('threadCreate', async (thread) => {
    try {
      if (!thread.parentId || !monitoredChannelTypes.has(thread.parentId)) {
        return;
      }
      if (thread.joinable && !thread.joined) {
        await thread.join().catch(() => undefined);
      }
      const starter = await thread.fetchStarterMessage().catch(() => null);
      if (starter && !starter.author?.bot) {
        handleMessage(starter);
      }
    } catch (err) {
      onError(err instanceof Error ? err : new Error(String(err)), 'threadCreate');
    }
  });

  client.once('clientReady', async () => {
    console.log('[channel-watcher] Gateway connected.');
    await Promise.all(
      [...client.guilds.cache.values()].map((guild) =>
        guild.channels.fetch().catch(() => undefined),
      ),
    );
    resolveMonitoredChannels();
    if (shouldBackfill()) {
      await backfillMonitoredChannels(client, monitoredChannelTypes, handleMessage, onError);
    }
  });

  client.on('channelCreate', () => resolveMonitoredChannels());
  client.on('channelUpdate', () => resolveMonitoredChannels());

  client.on('error', (err) => onError(err, 'discordClient'));
  client.on('shardError', (err) => onError(err, 'discordShard'));

  await client.login(token);
  return client;
}

function shouldBackfill() {
  const flag = process.env.QA_BACKFILL_ON_STARTUP;
  if (flag === '0' || flag === 'false' || flag === 'no') {
    return false;
  }
  return true;
}

/**
 * @param {Client} client
 * @param {Map<string, 'feature' | 'bug'>} monitoredChannelTypes
 * @param {(message: import('discord.js').Message) => void} handleMessage
 * @param {(err: Error, context: string) => void} onError
 */
async function backfillMonitoredChannels(client, monitoredChannelTypes, handleMessage, onError) {
  console.log(`[channel-watcher] Backfilling up to ${BACKFILL_LIMIT} messages per channel…`);
  for (const channelId of monitoredChannelTypes.keys()) {
    try {
      const channel = await client.channels.fetch(channelId).catch(() => null);
      if (!channel) continue;

      if (channel.type === ChannelType.GuildForum) {
        await backfillForumChannel(channel, handleMessage, onError);
        continue;
      }

      if (
        channel.type === ChannelType.GuildText ||
        channel.type === ChannelType.GuildAnnouncement
      ) {
        const messages = await channel.messages.fetch({ limit: BACKFILL_LIMIT });
        const sorted = [...messages.values()].sort(
          (a, b) => a.createdTimestamp - b.createdTimestamp,
        );
        for (const message of sorted) {
          handleMessage(message);
        }
      }
    } catch (err) {
      onError(err instanceof Error ? err : new Error(String(err)), `backfill:${channelId}`);
    }
  }
}

async function backfillForumChannel(forumChannel, handleMessage, onError) {
  let collected = 0;
  const seenThreads = new Set();

  const processThread = async (thread) => {
    if (seenThreads.has(thread.id)) return;
    seenThreads.add(thread.id);
    try {
      if (thread.joinable && !thread.joined) {
        await thread.join().catch(() => undefined);
      }
      const starter = await thread.fetchStarterMessage().catch(() => null);
      if (starter) {
        handleMessage(starter);
        collected += 1;
      }
      if (collected >= BACKFILL_LIMIT) return;
      const remaining = BACKFILL_LIMIT - collected;
      if (remaining <= 0) return;
      const messages = await thread.messages.fetch({ limit: Math.min(remaining, 50) });
      const sorted = [...messages.values()]
        .filter((m) => m.id !== starter?.id)
        .sort((a, b) => a.createdTimestamp - b.createdTimestamp);
      for (const message of sorted) {
        if (collected >= BACKFILL_LIMIT) break;
        handleMessage(message);
        collected += 1;
      }
    } catch (err) {
      onError(err instanceof Error ? err : new Error(String(err)), `backfillThread:${thread.id}`);
    }
  };

  const active = await forumChannel.threads.fetchActive();
  for (const thread of active.threads.values()) {
    if (collected >= BACKFILL_LIMIT) break;
    await processThread(thread);
  }

  if (collected < BACKFILL_LIMIT) {
    let before;
    while (collected < BACKFILL_LIMIT) {
      const archived = await forumChannel.threads.fetchArchived({
        limit: 50,
        before,
      });
      if (archived.threads.size === 0) break;
      for (const thread of archived.threads.values()) {
        if (collected >= BACKFILL_LIMIT) break;
        await processThread(thread);
      }
      before = archived.threads.last()?.id;
      if (!before) break;
    }
  }
}
