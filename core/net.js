// core/net.js
// Wraps node-fetch with automatic retries + a timeout for OUR OWN network
// calls (version manifest, Forge/Fabric/Modrinth lookups). This is separate
// from the patch in patches/minecraft-launcher-core+3.18.1.patch, which
// fixes the actual asset-download engine inside minecraft-launcher-core
// itself (the far bigger source of connection resets, since it downloads
// thousands of files). This module just adds the same resilience to the
// smaller number of requests our own code makes directly.

const fetch = require('node-fetch');

const TRANSIENT_ERROR_PATTERN =
  /socket hang up|ECONNRESET|disconnected before secure|ETIMEDOUT|EAI_AGAIN|network socket/i;

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
          err.message = `${err.message} (failed after ${attempt} attempts)`;
        }
        throw err;
      }
      await new Promise((resolve) => setTimeout(resolve, backoffMs * attempt));
    }
  }
  throw lastErr;
}

module.exports = { retryFetch };
