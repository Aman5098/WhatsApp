'use strict';

const fs = require('fs');
// whatsapp-web.js already bundles its own puppeteer (nested in ITS
// node_modules) to actually launch the browser — this only borrows that same
// copy to resolve/download the Chrome binary path, so there's no reason to
// also carry a second, separately-versioned puppeteer as our own dependency.
const puppeteer = require(require.resolve('puppeteer', { paths: [require.resolve('whatsapp-web.js')] }));
const { execFileSync } = require('child_process');

const resolveChromePath = async () => {
  try {
    const resolved = await puppeteer.executablePath();
    if (resolved && fs.existsSync(resolved)) return resolved;
  } catch (err) {
    // puppeteer throws if it has no build info at all yet — fall through to install.
  }
  return null;
};

const installChrome = () => {
  try {
    console.log('[puppeteer] Chrome not found, installing...');
    execFileSync('npx', ['puppeteer', 'browsers', 'install', 'chrome'], {
      stdio: 'inherit',
      shell: process.platform === 'win32',
    });
  } catch (err) {
    console.error('[puppeteer] on-demand Chrome install failed:', err.message);
  }
};

const getPuppeteerLaunchOptions = async () => {
  let executablePath = process.env.PUPPETEER_EXECUTABLE_PATH || (await resolveChromePath());

  if (!executablePath) {
    installChrome();
    executablePath = await resolveChromePath();
  }

  return {
    ...(executablePath ? { executablePath } : {}),
    headless: true,
    protocolTimeout: 300000, // default 180s is too tight when several Chromiums start together
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
  };
};

module.exports = { getPuppeteerLaunchOptions };
