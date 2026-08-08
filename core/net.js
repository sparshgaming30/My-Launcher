// core/net.js
// -----------------------------------------------------------------------------
// A retrying fetch wrapper. In practice, calls to Mojang/Forge/Fabric/Modrinth
// endpoints have shown intermittent "socket hang up" and "Client network
// socket disconnected before secure TLS connection was established" errors —
// a transient connection reset (flaky routing, antivirus SSL inspection,
// etc.), not a broken URL or a down service. A short retry-with-backoff
// absorbs most of these automatically instead of surfacing an error to the
// user on the first hiccup.
// -----------------------------------------------------------------------------

const fetch = require('node-fetch');

const TRANSIENT_ERROR_PATTERN =
  /socket hang up|ECONNRESET|disconnected before secure|ETIMEDOUT|EAI_AGAIN|network socket/i;

/**
 * @param {string} url
 * @param {object} options - standard node-fetch options
 * @param {object} config
 * @param {number} config.retries - total attempts (default 3)
 * @param {number} config.backoffMs - base delay between retries, multiplied by attempt number
 * @param {number} config.timeoutMs - abort a single attempt after this long
 */
async function retryFetch(url, options = {}, { retries = 3, backoffMs = 1000, timeoutMs = 20000 } = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, { ...options, signal: controller.signal });
      clearTimeout(timeout);
      return res;
    } catch (err) {
      clearTimeout(timeout);
      lastErr = err;
      const isTransient = TRANSIENT_ERROR_PATTERN.test(err.message || '') || err.name === 'AbortError';
      if (!isTransient || attempt === retries) {
        if (isTransient) {
          err.message = `${err.message} (failed after ${attempt} attempts — this usually means antivirus/firewall SSL inspection or a flaky connection is interrupting the request, not that the service is down)`;
        }
        throw err;
      }
      await new Promise((resolve) => setTimeout(resolve, backoffMs * attempt));
    }
  }
  throw lastErr;
}

module.exports = { retryFetch };
