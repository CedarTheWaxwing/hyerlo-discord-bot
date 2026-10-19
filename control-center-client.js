const MAX_BATCH_SIZE = 200;
const MAX_RETRIES = 4;
const INITIAL_BACKOFF_MS = 1000;

/**
 * @typedef {ReturnType<import('./qa-item-mapper.js').mapMessageToQaItem>} QaItem
 */

/**
 * @param {{ apiKey?: string; basicUser?: string; basicPassword?: string }} creds
 * @returns {Record<string, string>}
 */
export function buildControlCenterAuthHeaders({ apiKey, basicUser, basicPassword }) {
  /** @type {Record<string, string>} */
  const headers = {};
  const useBasic = Boolean(basicUser && basicPassword);
  if (useBasic) {
    const token = Buffer.from(`${basicUser}:${basicPassword}`, 'utf8').toString('base64');
    headers.Authorization = `Basic ${token}`;
    if (apiKey) {
      headers['X-Bot-Api-Key'] = apiKey;
    }
  } else if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }
  return headers;
}

export class ControlCenterClient {
  /**
   * @param {{ baseUrl: string; apiKey?: string; basicUser?: string; basicPassword?: string; fetchImpl?: typeof fetch; onError?: (err: Error, context: string) => void }} options
   */
  constructor({
    baseUrl,
    apiKey,
    basicUser,
    basicPassword,
    fetchImpl = fetch,
    onError = defaultOnError,
  }) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.apiKey = apiKey;
    this.basicUser = basicUser;
    this.basicPassword = basicPassword;
    this.fetchImpl = fetchImpl;
    this.onError = onError;
    /** @type {QaItem[]} */
    this.queue = [];
    this.flushTimer = null;
    this.flushing = false;
  }

  /** @param {QaItem} item */
  enqueue(item) {
    this.queue.push(item);
    if (this.queue.length >= MAX_BATCH_SIZE) {
      void this.flush();
      return;
    }
    if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => {
        this.flushTimer = null;
        void this.flush();
      }, 500);
    }
  }

  async flush() {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.flushing || this.queue.length === 0) {
      return;
    }
    this.flushing = true;
    while (this.queue.length > 0) {
      const batch = this.queue.splice(0, MAX_BATCH_SIZE);
      try {
        await this.postBatchWithRetry(batch);
      } catch (err) {
        this.onError(err instanceof Error ? err : new Error(String(err)), 'postBatch');
      }
    }
    this.flushing = false;
  }

  /** @param {QaItem[]} batch */
  async postBatchWithRetry(batch) {
    let lastError;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const res = await this.fetchImpl(`${this.baseUrl}/api/hyerlo-qa-items`, {
          method: 'POST',
          headers: {
            ...buildControlCenterAuthHeaders({
              apiKey: this.apiKey,
              basicUser: this.basicUser,
              basicPassword: this.basicPassword,
            }),
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ items: batch }),
        });
        if (res.ok) {
          return;
        }
        if (res.status === 401) {
          this.onError(
            new Error(
              'Control Center rejected credentials, check CONTROL_CENTER_BASIC_USER/PASSWORD',
            ),
            'postBatch',
          );
          return;
        }
        const body = await safeReadText(res);
        lastError = new Error(
          `Control Center API returned ${res.status}${body ? `: ${body.slice(0, 500)}` : ''}`,
        );
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
      }
      if (attempt < MAX_RETRIES) {
        const delay = INITIAL_BACKOFF_MS * 2 ** attempt;
        await sleep(delay);
      }
    }
    throw lastError ?? new Error('Control Center API request failed');
  }
}

function defaultOnError(err, context) {
  console.error(`[control-center] ${context}:`, err.message);
}

async function safeReadText(res) {
  try {
    return await res.text();
  } catch {
    return '';
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
