import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ControlCenterClient } from '../control-center-client.js';

describe('ControlCenterClient', () => {
  it('POSTs batches to the hyerlo-qa-items endpoint with bearer auth', async () => {
    /** @type {RequestInit | undefined} */
    let lastInit;
    let callCount = 0;
    const fetchImpl = async (url, init) => {
      callCount += 1;
      lastInit = init;
      return { ok: true, status: 200, text: async () => '' };
    };

    const client = new ControlCenterClient({
      baseUrl: 'https://control.example.com',
      apiKey: 'secret-key',
      fetchImpl,
    });

    client.enqueue({
      type: 'feature',
      dedupe_key: 'discord:1',
      title: 't',
      description: 'd',
      source: 'discord',
      status: 'new',
      evidence_links: [],
    });

    await client.flush();

    assert.equal(callCount, 1);
    assert.equal(
      /** @type {string} */ (lastInit?.headers?.Authorization),
      'Bearer secret-key',
    );
    const body = JSON.parse(/** @type {string} */ (lastInit?.body));
    assert.equal(body.items.length, 1);
    assert.equal(body.items[0].dedupe_key, 'discord:1');
  });

  it('retries failed requests with backoff without throwing to caller of flush', async () => {
    let attempts = 0;
    const fetchImpl = async () => {
      attempts += 1;
      if (attempts < 3) {
        return { ok: false, status: 503, text: async () => 'unavailable' };
      }
      return { ok: true, status: 200, text: async () => '' };
    };

    const client = new ControlCenterClient({
      baseUrl: 'https://control.example.com',
      apiKey: 'key',
      fetchImpl,
    });

    client.enqueue({
      type: 'bug',
      dedupe_key: 'discord:2',
      title: 't',
      description: 'd',
      source: 'discord',
      status: 'new',
      evidence_links: [],
    });

    await client.flush();
    assert.equal(attempts, 3);
  });
});
