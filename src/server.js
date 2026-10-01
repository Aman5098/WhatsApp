'use strict';

require('dotenv').config();

const http = require('http');
const express = require('express');
const cors = require('cors');
const { attachSocketServer } = require('./socketServer');
const { buildRouter } = require('./httpApi');
const projectRegistry = require('./projectRegistry');
const sessionManager = require('./sessionManager');

/**
 * whatsapp-web.js's own internal handlers (page-navigation detection of a
 * phone-side "unlink device" logout, a destroyed Puppeteer execution
 * context mid-initialize(), Puppeteer teardown races, etc.) throw directly
 * inside event callbacks we don't control — outside any promise chain our
 * own code can wrap in try/catch. On Windows in particular,
 * LocalAuth.logout() unlinking its session lockfile right after Chromium
 * closes can hit EBUSY because the OS hasn't released the file handle yet,
 * and whatsapp-web.js re-throws that as a raw, unhandled Error. Without a
 * handler here, one tenant's bad luck takes down every other tenant's live
 * session on the same process.
 *
 * Only swallow these AFTER the HTTP server is actually listening — before
 * that point (e.g. EADDRINUSE because a previous instance is still up) an
 * uncaught exception means the process never really started, and hiding
 * that leaves you staring at a stale, unfixed gateway on the port while
 * believing the new one is live. Log and keep running only once we know
 * we're actually serving traffic; a crashed tenant's client already resets
 * its own state via the 'disconnected'/init-error handlers (see
 * sessionManager.js), so the worst case post-listen is that one tenant
 * needs a fresh wa:init, not a whole-process restart.
 */
let serverIsListening = false;
process.on('uncaughtException', (err) => {
  if (!serverIsListening) {
    console.error('[gateway] uncaughtException during startup — exiting:', err.message);
    process.exit(1);
  }
  console.error('[gateway] uncaughtException (continuing):', err.message);
});
process.on('unhandledRejection', (reason) => {
  if (!serverIsListening) {
    console.error('[gateway] unhandledRejection during startup — exiting:', reason?.message || reason);
    process.exit(1);
  }
  console.error('[gateway] unhandledRejection (continuing):', reason?.message || reason);
});

// Close browsers cleanly on Ctrl+C / stop so the saved WhatsApp logins survive
// the restart (see sessionManager.shutdownAll). Force-exit after 15s if a
// browser hangs on close.
let shuttingDown = false;
for (const sig of ['SIGINT', 'SIGTERM', 'SIGBREAK']) {
  process.on(sig, async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[gateway] ${sig} received — closing WhatsApp sessions cleanly…`);
    setTimeout(() => process.exit(1), 15000).unref();
    try {
      await sessionManager.shutdownAll();
    } finally {
      process.exit(0);
    }
  });
}

if (projectRegistry.listProjectIds().length === 0) {
  console.error(
    '[gateway] No projects configured — create projects.json (see projects.json.example) ' +
    'or set GATEWAY_SHARED_SECRET for a single legacy "default" project. Refusing to start unauthenticated.'
  );
  process.exit(1);
}
console.log(`[gateway] projects: ${projectRegistry.listProjectIds().join(', ')}`);

const app = express();
app.use(cors());
app.use('/api', buildRouter()); // /api/send, /send-media — request/response
app.get('/health', (_req, res) => res.json({ ok: true }));

const server = http.createServer(app);
attachSocketServer(server); // wa:qr/wa:status/wa:message/wa:error push + control commands, all on one channel

const PORT = process.env.PORT || 4100;
server.listen(PORT, () => {
  serverIsListening = true;
  console.log(`[gateway] whatsapp-gateway listening on :${PORT}`);

  // Resume every tenant already claimed by some project — a gateway
  // restart brings back all previously-connected sessions on its own,
  // without any consuming project needing to reconnect and ask first. Runs
  // after listen so a slow/large restore never delays the port opening.
  const claimed = projectRegistry.listClaimedTenantKeys();
  if (claimed.length > 0) {
    console.log(`[gateway] restoring ${claimed.length} previously-connected tenant(s)…`);
    sessionManager.restoreClaimedSessions(claimed);
  }
});
