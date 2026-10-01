'use strict';

/**
 * socketServer.js
 *
 * Multiple independent projects can connect to this gateway as Socket.IO
 * CLIENTS (see backend/services/whatsappGatewayClient.js for the reference
 * implementation). Each connects with its own API key and is placed in a
 * room named `project:<projectId>` — events for a tenant are only ever
 * emitted into the room of the project that owns that tenant, so one
 * project never sees another project's messages.
 *
 * This is the ONE channel for everything except outbound sends (HTTP, see
 * httpApi.js): control commands IN (wa:init, wa:logout, wa:destroy,
 * wa:set-subscribers) and every event OUT, pushed in real time (wa:qr,
 * wa:status, wa:message — inbound messages with their media attached —
 * and wa:error). Projects never poll the gateway. A prior version split qr/status/error
 * onto a separate SSE connection — that introduced an ordering race
 * between two independently-reconnecting channels (a command sent on one
 * channel could complete before the other channel's connection was even
 * established, silently dropping the event it produced) that was hard to
 * reason about and harder to debug live. One connection, one order of
 * events, no cross-channel race — simpler beats clever here.
 *
 * Auth: `auth.apiKey` on connection, resolved to a projectId via
 * projectRegistry. Unrecognized keys are rejected at the handshake.
 */

const { Server } = require('socket.io');
const sessionManager = require('./sessionManager');
const projectRegistry = require('./projectRegistry');

function _projectRoom(projectId) {
  return `project:${projectId}`;
}

function attachSocketServer(httpServer) {
  const io = new Server(httpServer, {
    cors: { origin: '*' },
  });

  io.use((socket, next) => {
    const apiKey = socket.handshake.auth?.apiKey || socket.handshake.auth?.token; // `token` kept for backward-compat
    const projectId = projectRegistry.resolveProjectByApiKey(apiKey);
    if (!projectId) return next(new Error('unauthorized'));
    socket.projectId = projectId;
    next();
  });

  io.on('connection', (socket) => {
    socket.join(_projectRoom(socket.projectId));
    console.log(`[gateway] project=${socket.projectId} connected (socket ${socket.id}).`);

    // A project may only act on tenants it owns (or hasn't claimed yet —
    // wa:init is how a tenant gets claimed the first time). This stops
    // project A from sending as, reading, or tearing down project B's
    // WhatsApp session even if it guesses/knows the restaurantId.
    function assertOwnership(restaurantId) {
      const owner = projectRegistry.getOwner(restaurantId);
      if (owner && owner !== socket.projectId) {
        throw new Error(`Tenant is owned by another project.`);
      }
    }

    socket.on('wa:init', async ({ restaurantId, hasSubscribers } = {}) => {
      try {
        projectRegistry.claimTenant(restaurantId, socket.projectId);
        sessionManager.setHasSubscribers(restaurantId, hasSubscribers !== false);
        await sessionManager.initSession(restaurantId || null);
      } catch (err) {
        socket.emit('wa:error', { restaurantId, message: err.message });
      }
    });

    socket.on('wa:set-subscribers', ({ restaurantId, hasSubscribers } = {}) => {
      try {
        assertOwnership(restaurantId);
        sessionManager.setHasSubscribers(restaurantId, !!hasSubscribers);
      } catch (err) {
        socket.emit('wa:error', { restaurantId, message: err.message });
      }
    });

    socket.on('wa:logout', async ({ restaurantId } = {}) => {
      try {
        assertOwnership(restaurantId);
        await sessionManager.logoutSession(restaurantId || null);
        projectRegistry.releaseTenant(restaurantId);
      } catch (err) {
        socket.emit('wa:error', { restaurantId, message: err.message });
      }
    });

    socket.on('wa:destroy', async ({ restaurantId } = {}) => {
      try {
        assertOwnership(restaurantId);
        await sessionManager.destroySession(restaurantId || null);
      } catch (err) {
        socket.emit('wa:error', { restaurantId, message: err.message });
      }
    });

    socket.on('disconnect', () => {
      console.log(`[gateway] project=${socket.projectId} disconnected (socket ${socket.id}).`);
    });
  });

  // Fan out every session event (qr/status/message/error) into the room of
  // the project that owns this tenant only. An unclaimed tenant (shouldn't
  // normally happen — events only fire after some project's wa:init claims
  // it) is dropped rather than broadcast to everyone.
  sessionManager.onEvent((restaurantId, event, data) => {
    const owner = projectRegistry.getOwner(restaurantId);
    if (!owner) {
      console.warn(`[gateway] dropping wa:${event} for unclaimed tenant="${restaurantId || '__platform__'}".`);
      return;
    }
    io.to(_projectRoom(owner)).emit(`wa:${event}`, { restaurantId: restaurantId || null, ...data });
  });

  return io;
}

module.exports = { attachSocketServer };
