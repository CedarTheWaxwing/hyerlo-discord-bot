import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { mapMessageToQaItem, TITLE_MAX_LEN } from '../qa-item-mapper.js';

function mockMessage(overrides = {}) {
  return {
    id: '1234567890123456789',
    guildId: '987654321098765432',
    channelId: '111111111111111111',
    content: 'Please add dark mode to settings',
    author: {
      bot: false,
      username: 'testuser',
      globalName: 'Test User',
    },
    attachments: {
      values: () => [][Symbol.iterator](),
      first: () => undefined,
    },
    channel: {
      name: 'feature-requests',
      isThread: () => false,
    },
    ...overrides,
  };
}

describe('mapMessageToQaItem', () => {
  it('maps feature-requests messages to type feature', () => {
    const item = mapMessageToQaItem(mockMessage(), 'feature');
    assert.equal(item.type, 'feature');
    assert.equal(item.source, 'discord');
    assert.equal(item.status, 'new');
    assert.equal(item.dedupe_key, 'discord:1234567890123456789');
    assert.equal(item.title, 'Please add dark mode to settings');
    assert.match(item.description, /Reported by Test User/);
    assert.match(item.description, /dark mode/);
    assert.equal(item.evidence_links.length, 1);
    assert.match(item.evidence_links[0], /discord\.com\/channels\/987654321098765432\/111111111111111111\/1234567890123456789/);
    assert.equal(item.screenshot_url, null);
  });

  it('maps report-a-bug messages to type bug', () => {
    const item = mapMessageToQaItem(
      mockMessage({
        content: 'Save button does nothing',
        channel: { name: 'report-a-bug', isThread: () => false },
      }),
      'bug',
    );
    assert.equal(item.type, 'bug');
    assert.equal(item.severity, 'medium');
    assert.equal(item.steps_to_reproduce, 'Save button does nothing');
    assert.equal(item.page_or_area, 'report-a-bug');
  });

  it('truncates long titles to ~80 characters', () => {
    const long = 'a'.repeat(100);
    const item = mapMessageToQaItem(mockMessage({ content: long }), 'feature');
    assert.equal(item.title.length, TITLE_MAX_LEN);
    assert.ok(item.title.endsWith('…'));
  });

  it('uses first image attachment as screenshot_url', () => {
    const attachment = {
      url: 'https://cdn.discordapp.com/attachments/1/2/screenshot.png',
      contentType: 'image/png',
      name: 'screenshot.png',
    };
    const item = mapMessageToQaItem(
      mockMessage({
        attachments: {
          values: () => [attachment][Symbol.iterator](),
          first: () => attachment,
        },
      }),
      'bug',
    );
    assert.equal(item.screenshot_url, attachment.url);
  });
});
