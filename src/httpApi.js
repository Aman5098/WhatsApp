'use strict';

/**
 * httpApi.js
 *
 * Outbound sends only: POST /send and /send-media. Everything else flows
 * over Socket.IO (see socketServer.js) — QR codes, connection state and
 * inbound messages are PUSHED to the owning project in real time; there is
 * deliberately nothing here to poll or fetch.
 *
 * Auth via a per-project API key (bearer token, see projectRegistry.js).
 * Every route also enforces that the caller's project owns the
 * restaurantId it's sending as.
 */

const express = require('express');
const sessionManager = require('./sessionManager');
const projectRegistry = require('./projectRegistry');

function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const apiKey = header.startsWith('Bearer ') ? header.slice(7) : null;
  const projectId = projectRegistry.resolveProjectByApiKey(apiKey);
  if (!projectId) return res.status(401).json({ error: 'Unauthorized' });
  req.projectId = projectId;
  next();
}

/**
 * restaurantId may legitimately be absent (the platform/superadmin tenant,
 * key null). Ownership is still enforced for that sentinel tenant — only
 * the project that first claims it (via wa:init/this same check) may act
 * on it afterwards.
 */
function requireOwnership(getRestaurantId) {
  return (req, res, next) => {
    const restaurantId = getRestaurantId(req);
    const owner = projectRegistry.getOwner(restaurantId);
    if (owner && owner !== req.projectId) {
      return res.status(403).json({ error: 'Tenant is owned by another project.' });
    }
    next();
  };
}

function buildRouter() {
  const router = express.Router();
  router.use(express.json({ limit: '20mb' })); // media sends are base64-encoded
  router.use(requireAuth);

  router.post(
    '/send',
    requireOwnership((req) => req.body?.restaurantId || null),
    async (req, res) => {
      const { restaurantId, digits, message, targetId } = req.body || {};
      if (!digits || !message) return res.status(400).json({ error: 'digits and message are required' });
      try {
        const result = await sessionManager.sendMessage(restaurantId || null, digits, message, targetId || null);
        res.json({ success: true, ...result });
      } catch (err) {
        res.status(422).json({ success: false, error: err.message });
      }
    }
  );

  router.post(
    '/send-media',
    requireOwnership((req) => req.body?.restaurantId || null),
    async (req, res) => {
      const { restaurantId, digits, fileBase64, filename, mimeType, caption, targetId } = req.body || {};
      if (!digits || !fileBase64 || !filename || !mimeType) {
        return res.status(400).json({ error: 'digits, fileBase64, filename and mimeType are required' });
      }
      try {
        const result = await sessionManager.sendMediaMessage(
          restaurantId || null, digits, fileBase64, filename, mimeType, caption || '', targetId || null
        );
        res.json({ success: true, ...result });
      } catch (err) {
        res.status(422).json({ success: false, error: err.message });
      }
    }
  );

  return router;
}

module.exports = { buildRouter };
