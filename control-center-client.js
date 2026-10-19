const MAX_BATCH_SIZE = 200;
const MAX_RETRIES = 4;
const INITIAL_BACKOFF_MS = 1000;

/**
 * @typedef {ReturnType<import('./qa-item-mapper.js').mapMessageToQaItem>} QaItem
 */

export class ControlCenterClient {
  /**
   * @param {{ baseUrl: string; apiKey: string; fetchImpl?: typeof fetch; onError?: (err: Error, context: string) => void }} options
   */
  constructor({ baseUrl, apiKey, fetchImpl = fetch, onError = defaultOnError }) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.apiKey = apiKey;
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
            Authorization: `Bearer ${this.apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ items: batch }),
        });
        if (res.ok) {
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
