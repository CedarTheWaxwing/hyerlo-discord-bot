import 'dotenv/config';
import express from 'express';
import {
  ButtonStyleTypes,
  InteractionResponseFlags,
  InteractionResponseType,
  InteractionType,
  MessageComponentTypes,
  verifyKeyMiddleware,
} from 'discord-interactions';
import { getRandomEmoji, DiscordRequest } from './utils.js';
import { getShuffledOptions, getResult } from './game.js';
import { startChannelWatcher } from './channel-watcher.js';

// Create an express app
const app = express();
// Get port, or default to 3000
const PORT = process.env.PORT || 3000;
// To keep track of our active games
const activeGames = {};

app.get('/health', (_req, res) => {
  res.status(200).json({ ok: true });
});

/**
 * Interactions endpoint URL where Discord will send HTTP requests
 * Parse request body and verifies incoming requests using discord-interactions package
 */
app.post('/interactions', verifyKeyMiddleware(process.env.PUBLIC_KEY), async function (req, res) {
  // Interaction id, type and data
  const { id, type, data } = req.body;

  /**
   * Handle verification requests
   */
  if (type === InteractionType.PING) {
    return res.send({ type: InteractionResponseType.PONG });
  }

  /**
   * Handle slash command requests
   * See https://discord.com/developers/docs/interactions/application-commands#slash-commands
   */
  if (type === InteractionType.APPLICATION_COMMAND) {
    const { name } = data;

    // "test" command
    if (name === 'test') {
      // Send a message into the channel where command was triggered from
      return res.send({
        type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
        data: {
          flags: InteractionResponseFlags.IS_COMPONENTS_V2,
          components: [
            {
              type: MessageComponentTypes.TEXT_DISPLAY,
              // Fetches a random emoji to send from a helper function
              content: `hello world ${getRandomEmoji()}`
            }
          ]
        },
      });
    }

    // "invite" command — owner-only; creates a never-expiring server invite
    if (name === 'invite') {
      const userId = req.body.member?.user?.id ?? req.body.user?.id;
      if (!process.env.OWNER_USER_ID || userId !== process.env.OWNER_USER_ID) {
        return res.send({
          type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
          data: {
            content: 'You cannot use this command.',
            flags: InteractionResponseFlags.EPHEMERAL,
          },
        });
      }

      const channelId = process.env.INVITE_CHANNEL_ID;
      if (!channelId) {
        return res.send({
          type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
          data: {
            content: 'INVITE_CHANNEL_ID is not configured.',
            flags: InteractionResponseFlags.EPHEMERAL,
          },
        });
      }

      try {
        const inviteRes = await DiscordRequest(`channels/${channelId}/invites`, {
          method: 'POST',
          body: {
            max_age: 0,
            max_uses: 0,
            unique: false,
          },
        });
        const invite = await inviteRes.json();
        return res.send({
          type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
          data: {
            content: `Invite link: https://discord.gg/${invite.code}`,
            flags: InteractionResponseFlags.EPHEMERAL,
          },
        });
      } catch (err) {
        console.error('Failed to create invite:', err);
        return res.send({
          type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
          data: {
            content: 'Failed to create invite. Check bot permissions and INVITE_CHANNEL_ID.',
            flags: InteractionResponseFlags.EPHEMERAL,
          },
        });
      }
    }

    console.error(`unknown command: ${name}`);
    return res.status(400).json({ error: 'unknown command' });
  }

  console.error('unknown interaction type', type);
  return res.status(400).json({ error: 'unknown interaction type' });
});

app.listen(PORT, () => {
  console.log('Listening on port', PORT);
});

startChannelWatcher().catch((err) => {
  console.error('[channel-watcher] Failed to start:', err.message);
});
