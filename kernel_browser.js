/**
 * kernel_browser.js
 *
 * Helper to create a Playwright browser connected via Kernel's cloud
 * using a residential proxy. Requires:
 *   - KERNEL_API_KEY environment variable
 *   - @onkernel/sdk package (npm install @onkernel/sdk)
 *
 * When KERNEL_API_KEY is missing, falls back to a local Chromium browser
 * (useful for offline/dev verification; geo-blocked sites may fail).
 *
 * Proxy IDs (from dashboard.onkernel.com):
 *   - ngr-peru  → zjvah9ffg1n2yk0lshnupv7v  (Residential, Peru)
 *   - dart-proxy → d41y7cvkpixootc1ix1kxvew  (Residential, Argentina)
 */

const { chromium } = require('playwright');

// Map of friendly proxy names to their Kernel proxy IDs
const PROXY_IDS = {
  'ngr-peru':   'zjvah9ffg1n2yk0lshnupv7v',
  'dart-proxy': 'd41y7cvkpixootc1ix1kxvew',
};

/**
 * Create a remote Kernel browser with a residential proxy.
 * Returns { browser, context, kernelBrowser, kernel } so the caller can close both.
 *
 * @param {object} options
 * @param {string} [options.proxy='ngr-peru'] - Friendly proxy name or a raw proxy_id
 * @param {boolean} [options.stealth=true]    - Enable Kernel's stealth mode
 * @returns {Promise<{ browser: import('playwright').Browser, context: import('playwright').BrowserContext, kernelBrowser: object|null, kernel: object|null }>}
 */
async function createKernelBrowser({ proxy = 'ngr-peru', stealth = true } = {}) {
  if (!process.env.KERNEL_API_KEY) {
    console.warn('[Kernel] KERNEL_API_KEY not set — using local Chromium (no Peru residential proxy).');
    const browser = await chromium.launch({ headless: true, channel: 'chrome' });
    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      locale: 'es-PE',
      timezoneId: 'America/Lima',
    });
    return { browser, context, kernelBrowser: null, kernel: null };
  }

  const Kernel = require('@onkernel/sdk').default || require('@onkernel/sdk');
  const kernel = new Kernel({ apiKey: process.env.KERNEL_API_KEY });

  const proxyId = PROXY_IDS[proxy] || proxy; // accept raw IDs too
  console.log(`[Kernel] Creating cloud browser (proxy: ${proxy}, stealth: ${stealth})...`);

  const kernelBrowser = await kernel.browsers.create({
    proxy_id: proxyId,
    stealth,
  });

  console.log(`[Kernel] Session created: ${kernelBrowser.session_id}`);
  console.log(`[Kernel] Connecting via CDP...`);

  const browser = await chromium.connectOverCDP(kernelBrowser.cdp_ws_url);

  // When connectOverCDP is used, Kernel already has a context and page open.
  const context = browser.contexts()[0] || (await browser.newContext());

  console.log(`[Kernel] Connected! Browser is running in Kernel's cloud using residential proxy.`);

  return { browser, context, kernelBrowser, kernel };
}

/**
 * Cleanly closes the Playwright browser connection and terminates the Kernel session.
 *
 * @param {object} params
 * @param {import('playwright').Browser} params.browser
 * @param {object|null} params.kernelBrowser
 * @param {object|null} params.kernel
 */
async function closeKernelBrowser({ browser, kernelBrowser, kernel }) {
  try {
    await browser.close();
  } catch (_) {}
  if (kernel && kernelBrowser?.session_id) {
    try {
      await kernel.browsers.deleteByID(kernelBrowser.session_id);
      console.log(`[Kernel] Session ${kernelBrowser.session_id} terminated.`);
    } catch (e) {
      console.warn(`[Kernel] Could not delete session: ${e.message}`);
    }
  }
}

module.exports = { createKernelBrowser, closeKernelBrowser, PROXY_IDS };
