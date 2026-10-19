import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  ControlCenterClient,
  buildControlCenterAuthHeaders,
} from '../control-center-client.js';

describe('buildControlCenterAuthHeaders', () => {
  it('uses Bearer when only apiKey is set', () => {
    const headers = buildControlCenterAuthHeaders({ apiKey: 'secret-key' });
    assert.equal(headers.Authorization, 'Bearer secret-key');
    assert.equal(headers['X-Bot-Api-Key'], undefined);
  });

  it('uses Basic when user and password are set', () => {
    const headers = buildControlCenterAuthHeaders({
      basicUser: 'alice',
      basicPassword: 's3cret',
    });
    const expected = `Basic ${Buffer.from('alice:s3cret', 'utf8').toString('base64')}`;
    assert.equal(headers.Authorization, expected);
    assert.equal(headers['X-Bot-Api-Key'], undefined);
  });

  it('prefers Basic and sends X-Bot-Api-Key when basic and apiKey are both set', () => {
    const headers = buildControlCenterAuthHeaders({
      apiKey: 'bot-key',
      basicUser: 'alice',
      basicPassword: 's3cret',
    });
    const expected = `Basic ${Buffer.from('alice:s3cret', 'utf8').toString('base64')}`;
    assert.equal(headers.Authorization, expected);
    assert.equal(headers['X-Bot-Api-Key'], 'bot-key');
  });

  it('returns no Authorization when no credentials are provided', () => {
    const headers = buildControlCenterAuthHeaders({});
    assert.equal(headers.Authorization, undefined);
  });
});

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

  it('POSTs with Basic auth and X-Bot-Api-Key when basic credentials and apiKey are set', async () => {
    /** @type {RequestInit | undefined} */
    let lastInit;
    const fetchImpl = async (_url, init) => {
      lastInit = init;
      return { ok: true, status: 200, text: async () => '' };
    };

    const client = new ControlCenterClient({
      baseUrl: 'https://control.example.com',
      apiKey: 'bot-key',
      basicUser: 'caddy-user',
      basicPassword: 'caddy-pass',
      fetchImpl,
    });

    client.enqueue({
      type: 'bug',
      dedupe_key: 'discord:3',
      title: 't',
      description: 'd',
      source: 'discord',
      status: 'new',
      evidence_links: [],
    });

    await client.flush();

    const expectedBasic = `Basic ${Buffer.from('caddy-user:caddy-pass', 'utf8').toString('base64')}`;
    assert.equal(/** @type {string} */ (lastInit?.headers?.Authorization), expectedBasic);
    assert.equal(/** @type {string} */ (lastInit?.headers?.['X-Bot-Api-Key']), 'bot-key');
  });

  it('does not retry on 401 and logs credential rejection', async () => {
    let attempts = 0;
    /** @type {string[]} */
    const errorMessages = [];
    const fetchImpl = async () => {
      attempts += 1;
      return { ok: false, status: 401, text: async () => 'Unauthorized' };
    };

    const client = new ControlCenterClient({
      baseUrl: 'https://control.example.com',
      basicUser: 'user',
      basicPassword: 'wrong',
      fetchImpl,
      onError: (err) => {
        errorMessages.push(err.message);
      },
    });

    client.enqueue({
      type: 'bug',
      dedupe_key: 'discord:401',
      title: 't',
      description: 'd',
      source: 'discord',
      status: 'new',
      evidence_links: [],
    });

    await client.flush();

    assert.equal(attempts, 1);
    assert.equal(errorMessages.length, 1);
    assert.match(
      errorMessages[0],
      /Control Center rejected credentials, check CONTROL_CENTER_BASIC_USER\/PASSWORD/,
    );
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
