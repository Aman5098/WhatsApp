'use strict';

/**
 * sessionManager.js
 *
 * Owns every whatsapp-web.js / Puppeteer Client, one per tenant (restaurantId,
 * or the sentinel PLATFORM_TENANT_KEY for the platform/superadmin number).
 *
 * This service has NO Dinera business logic — no DB models, no auto-reply,
 * no message persistence. It only:
 *   - creates/destroys whatsapp-web.js clients and their LocalAuth sessions
 *   - turns client events (qr/status/message) into plain events, forwarded
 *     to whoever is listening (see socketServer.js)
 *   - executes send requests against the right tenant's client (see httpApi.js)
 */

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const { getPuppeteerLaunchOptions } = require('./puppeteerLaunchOptions');

// Override with WWEBJS_AUTH_PATH to keep sessions on a mounted volume.
const AUTH_ROOT = process.env.WWEBJS_AUTH_PATH || path.join(__dirname, '..', '.wwebjs_auth');
const PLATFORM_TENANT_KEY = '__platform__';

// How long an unscanned QR is allowed to sit before the gateway gives up and
// tears the session down on its own — someone who asked for a QR and never
// came back must not hold a Chromium open (and keep rotating/re-pushing a
// QR nobody's scanning) forever. Starts counting from the FIRST qr event of
// a session, not reset per rotation — WhatsApp itself rotates the QR every
// ~20s regardless, so resetting per-rotation would never actually expire.
const QR_EXPIRY_MS = (parseInt(process.env.QR_EXPIRY_SECONDS, 10) || 120) * 1000;

// Map<tenantKey, TenantState>
const tenants = new Map();

function _createTenantState() {
  return {
    client: null,
    status: 'disconnected',
    clientInfo: null,
    lastQrImage: null,
    connectedAt: null, // seconds — cutoff used by the backend to drop history backlog
    qrExpiryTimer: null,
  };
}

function _clearQrExpiryTimer(tenant) {
  if (tenant.qrExpiryTimer) {
    clearTimeout(tenant.qrExpiryTimer);
    tenant.qrExpiryTimer = null;
  }
}

function _key(restaurantId) {
  return restaurantId || PLATFORM_TENANT_KEY;
}

function _getTenant(restaurantId) {
  const key = _key(restaurantId);
  if (!tenants.has(key)) tenants.set(key, _createTenantState());
  return tenants.get(key);
}

function _authDataPath(restaurantId) {
  return path.join(AUTH_ROOT, _key(restaurantId));
}

/**
 * Kills Chrome processes still holding this tenant's profile — left behind
 * when a previous gateway run was killed hard (crash, closed terminal,
 * force-restart), which otherwise makes the next launch fail with "The
 * browser is already running". Only called when this process has no live
 * client for the tenant, so anything found is an orphan by definition.
 * Matches on the tenant's own --user-data-dir, so other tenants are untouched.
 */
async function _killOrphanBrowsers(restaurantId, label) {
  const profileDir = path.join(_authDataPath(restaurantId), 'session');
  try {
    if (process.platform === 'win32') {
      const script =
        "$d = $env:WA_PROFILE_DIR; " +
        "Get-CimInstance Win32_Process -Filter \"Name like 'chrome%' or Name like 'chromium%'\" | " +
        "Where-Object { $_.CommandLine -and $_.CommandLine.Contains($d) } | " +
        "ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue; $_.ProcessId }";
      const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
        env: { ...process.env, WA_PROFILE_DIR: profileDir },
        timeout: 15000,
        windowsHide: true,
      });
      if (stdout.trim()) console.log(`[gateway] tenant=${label} killed orphan browser pid(s): ${stdout.trim().split(/\s+/).join(', ')}`);
    } else {
      // pkill exits 1 when nothing matched — that's the normal case.
      await execFileAsync('pkill', ['-f', `--user-data-dir=${profileDir}`], { timeout: 10000 }).catch(() => {});
    }
  } catch (err) {
    console.warn(`[gateway] tenant=${label} orphan-browser cleanup skipped:`, err.message);
  }
}

function _clearStaleSingletonLocks(restaurantId) {
  // The Chromium user-data dir is <auth path>/session (LocalAuth's default
  // clientId); the singleton locks sit in its root, not in Default/.
  //
  // SingletonLock/Cookie/Socket are how Chromium's ProcessSingleton does this
  // on Linux/macOS (a symlink + a listening socket) — harmless to remove once
  // this process has confirmed (via _killOrphanBrowsers, called just before
  // this) that no process is actually holding the profile any more. On
  // Windows there are no such files; ProcessSingleton instead backs onto
  // Default/LOCK plus a named kernel mutex that self-releases when the last
  // handle to it closes (i.e. when the owning process dies) — so on Windows
  // it's Default/LOCK, not the Singleton* names, that survives a hard kill
  // and must be cleared here, or the next launch fails with "The browser is
  // already running ... Use a different userDataDir" despite no Chromium
  // process actually being alive for this tenant any more.
  const root = _authDataPath(restaurantId);
  const dirs = [path.join(root, 'session'), path.join(root, 'session', 'Default')];
  const lockFiles = ['SingletonLock', 'SingletonCookie', 'SingletonSocket', 'lockfile', 'LOCK'];
  for (const dir of dirs) {
    for (const name of lockFiles) {
      try {
        fs.rmSync(path.join(dir, name), { force: true });
      } catch (_) { }
    }
  }
}

function _statusPayload(tenant) {
  return {
    status: tenant.status,
    isReady: tenant.status === 'connected',
    clientInfo: tenant.clientInfo
      ? { phone: tenant.clientInfo?.wid?.user || null, name: tenant.clientInfo?.pushname || null }
      : null,
  };
}

/**
 * Emitted for every lifecycle/event this service produces. The backend's
 * gateway client (see backend/services/whatsappGatewayClient.js) subscribes
 * via Socket.IO; see socketServer.js for the actual `.emit()` wiring.
 *
 * events: 'qr' | 'status' | 'message' | 'error'
 * handler(restaurantId, payload)
 */
const listeners = new Set();
function onEvent(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
function _emit(restaurantId, event, data) {
  for (const fn of listeners) {
    try { fn(restaurantId, event, data); } catch (err) {
      console.error('[sessionManager] listener error:', err.message);
    }
  }
}

/**
 * Whether anyone is currently interested in a fresh QR for this tenant.
 * The gateway itself has no notion of "SSE subscribers" (that lives on the
 * backend) — the backend tells it via `hasSubscribers` on init/status-check.
 * Defaults to true so a bare `initSession` call (e.g. a first-time connect)
 * always broadcasts its QR.
 */
const subscriberFlags = new Map();
function setHasSubscribers(restaurantId, has) {
  subscriberFlags.set(_key(restaurantId), !!has);
}
function _hasSubscribers(restaurantId) {
  const key = _key(restaurantId);
  return subscriberFlags.has(key) ? subscriberFlags.get(key) : true;
}

const NON_CONVERSATIONAL_TYPES = new Set([
  'e2e_notification', 'notification', 'notification_template',
  'call_log', 'protocol', 'gp2', 'group_notification',
  'broadcast_notification', 'revoked', 'ciphertext', 'debug',
]);

/**
 * Digits-only phone number for a 1:1 chat jid.
 *
 * contact.number reads whatever WhatsApp Web has cached locally for this
 * contact, which for an @lid-addressed chat (multi-device /
 * privacy-preserving numbering, common on newer accounts) is often empty
 * even for a contact that has messaged before — the local cache was never
 * populated with a real-number mapping for that LID. Rather than silently
 * falling back to the LID's own numeric part (meaningless as a phone number
 * — it's an opaque internal id, not anyone's number), actively resolve it
 * via getContactLidAndPhone(), which forces WhatsApp Web to query for the
 * real number if it doesn't already have it cached (see whatsapp-web.js's
 * enforceLidAndPnRetrieval).
 */
async function _resolveNumber(client, label, jid, contact) {
  const stripServer = (id) => String(id || '').replace(/@.*$/, '').replace(/\D/g, '');

  if (!jid.endsWith('@lid')) {
    return { number: stripServer(contact?.number) || stripServer(jid), resolved: true };
  }

  // For an @lid chat, contact.number is the LID's own digits (whatsapp-web.js
  // sets it from userid) — truthy but NOT a phone number — so it must never
  // short-circuit resolution. Ask WhatsApp Web for the real phone JID.
  let phone = null;
  try {
    const [result] = await client.getContactLidAndPhone([jid]);
    console.log(`[gateway] tenant=${label} LID resolution for ${jid} →`, JSON.stringify(result));
    if (result?.pn) phone = stripServer(result.pn);
  } catch (err) {
    console.warn(`[gateway] tenant=${label} LID→phone resolution failed for ${jid}:`, err.message);
  }
  // Fallback: the contact model may already carry the phone JID as its id.
  if (!phone && contact?.id?.server === 'c.us') phone = stripServer(contact.id._serialized);

  // Unresolved: return the LID digits so the message isn't lost; the caller
  // sees `numberResolved: false` and keys the chat by jid instead.
  return { number: phone || stripServer(jid), resolved: !!phone };
}

// Inbound media is pushed WITH the message (base64), so a project never has
// to call back to fetch it. Files above this cap are announced but not
// attached (`media: null, mediaError`) — WhatsApp allows up to 2GB documents,
// which don't belong in a socket frame.
const MAX_INBOUND_MEDIA_BYTES = (parseInt(process.env.MAX_INBOUND_MEDIA_MB, 10) || 16) * 1024 * 1024;

async function _inboundMedia(msg, label) {
  if (!msg.hasMedia) return { hasMedia: false, media: null };
  const declaredSize = msg._data?.size || 0;
  if (declaredSize > MAX_INBOUND_MEDIA_BYTES) {
    return { hasMedia: true, media: null, mediaError: 'too_large' };
  }
  try {
    const media = await msg.downloadMedia();
    if (!media?.data) return { hasMedia: true, media: null, mediaError: 'unavailable' };
    if (Buffer.byteLength(media.data, 'base64') > MAX_INBOUND_MEDIA_BYTES) {
      return { hasMedia: true, media: null, mediaError: 'too_large' };
    }
    return {
      hasMedia: true,
      media: { mimetype: media.mimetype, data: media.data, filename: media.filename || null },
    };
  } catch (err) {
    console.warn(`[gateway] tenant=${label} media download failed:`, err.message);
    return { hasMedia: true, media: null, mediaError: 'unavailable' };
  }
}

// initSession only assigns tenant.client after an await (launch options), so
// two near-simultaneous calls — the gateway's own boot restore and the
// backend's wa:init resume — both used to pass the "already initialised"
// check and start two Chromiums on one profile ("browser is already
// running"). Share one in-flight call per tenant instead.
function initSession(restaurantId) {
  const tenant = _getTenant(restaurantId);
  if (tenant.initInFlight) return tenant.initInFlight;
  tenant.initInFlight = _initSession(restaurantId).finally(() => {
    tenant.initInFlight = null;
  });
  return tenant.initInFlight;
}

async function _initSession(restaurantId) {
  const tenant = _getTenant(restaurantId);
  const label = _key(restaurantId);

  if (tenant.client) {
    console.log(`[gateway] tenant=${label} already initialised — re-emitting current state.`);
    _emit(restaurantId, 'status', _statusPayload(tenant));
    if (tenant.lastQrImage) _emit(restaurantId, 'qr', { qr: tenant.lastQrImage });
    return _statusPayload(tenant);
  }

  console.log(`[gateway] tenant=${label} initialising client …`);
  tenant.status = 'initializing';
  _emit(restaurantId, 'status', { status: tenant.status });

  await _killOrphanBrowsers(restaurantId, label);
  // Re-check: an init may have raced in while we were waiting on the cleanup.
  if (tenant.client) return _statusPayload(tenant);
  _clearStaleSingletonLocks(restaurantId);

  const client = new Client({
    authStrategy: new LocalAuth({ dataPath: _authDataPath(restaurantId) }),
    puppeteer: await getPuppeteerLaunchOptions(),
  });
  tenant.client = client;

  client.on('qr', async (qrString) => {
    tenant.status = 'qr_ready';

    if (!_hasSubscribers(restaurantId)) {
      console.log(`[gateway] tenant=${label} QR received but no subscribers — discarding and tearing down.`);
      _clearQrExpiryTimer(tenant);
      tenant.client = null;
      tenant.lastQrImage = null;
      tenant.status = 'disconnected';
      // Tell the owning project, or it's left believing the tenant is still
      // 'initializing' (e.g. a boot-time restore whose saved session had
      // expired server-side and now needs a fresh scan).
      _emit(restaurantId, 'status', { status: tenant.status });
      client.destroy().catch((err) => {
        console.error(`[gateway] tenant=${label} error destroying unwatched QR client:`, err.message);
      });
      return;
    }

    try {
      tenant.lastQrImage = await qrcode.toDataURL(qrString, { width: 300 });
      _emit(restaurantId, 'qr', { qr: tenant.lastQrImage });
      _emit(restaurantId, 'status', { status: tenant.status });
    } catch (err) {
      console.error(`[gateway] tenant=${label} QR encode error:`, err.message);
    }

    // Start the expiry clock on the FIRST qr of this session only — WhatsApp
    // itself re-fires this event with a fresh QR every ~20s regardless of
    // whether anyone's looking, so a timer restarted on every rotation
    // would never actually fire.
    if (!tenant.qrExpiryTimer) {
      tenant.qrExpiryTimer = setTimeout(() => {
        tenant.qrExpiryTimer = null;
        if (tenant.client !== client || tenant.status !== 'qr_ready') return; // already scanned/torn down
        console.log(`[gateway] tenant=${label} QR left unscanned for ${QR_EXPIRY_MS / 1000}s — giving up.`);
        tenant.client = null;
        tenant.lastQrImage = null;
        tenant.status = 'expired';
        _emit(restaurantId, 'status', { status: tenant.status });
        client.destroy().catch((err) => {
          console.error(`[gateway] tenant=${label} error destroying expired-QR client:`, err.message);
        });
      }, QR_EXPIRY_MS);
    }
  });

  client.on('authenticated', () => {
    console.log(`[gateway] tenant=${label} authenticated.`);
    _clearQrExpiryTimer(tenant); // scanned in time — the QR window is over
    tenant.lastQrImage = null;
    tenant.status = 'authenticated';
    _emit(restaurantId, 'status', { status: tenant.status });
  });

  client.on('ready', () => {
    const alreadyConnected = tenant.status === 'connected';
    tenant.status = 'connected';
    tenant.clientInfo = client.info || null;
    const phone = tenant.clientInfo?.wid?.user || 'unknown';
    const name = tenant.clientInfo?.pushname || 'unknown';

    if (alreadyConnected) {
      console.log(`[gateway] tenant=${label} duplicate READY event ignored — already connected.`);
      return;
    }

    tenant.connectedAt = Date.now() / 1000; // whatsapp-web.js message.timestamp is in seconds
    console.log(`[gateway] tenant=${label} READY — +${phone} (${name}).`);
    tenant.lastQrImage = null;
    _emit(restaurantId, 'status', { status: tenant.status, isReady: true, clientInfo: { phone, name } });

    const markDeadClient = (reason) => {
      if (tenant.client !== client) return;
      console.warn(`[gateway] tenant=${label} underlying browser/page died (${reason}) — resetting.`);
      tenant.status = 'disconnected';
      tenant.lastQrImage = null;
      tenant.clientInfo = null;
      tenant.client = null;
      tenant.connectedAt = null;
      _emit(restaurantId, 'status', { status: tenant.status });
    };
    client.pupPage?.once('close', () => markDeadClient('page closed'));
    client.pupBrowser?.once('disconnected', () => markDeadClient('browser disconnected'));
  });

  client.on('auth_failure', (msg) => {
    console.error(`[gateway] tenant=${label} auth failure:`, msg);
    _clearQrExpiryTimer(tenant);
    tenant.status = 'error';
    _emit(restaurantId, 'status', { status: tenant.status });
    _emit(restaurantId, 'error', { message: `Auth failed: ${msg}` });
  });

  client.on('disconnected', (reason) => {
    console.warn(`[gateway] tenant=${label} disconnected:`, reason);
    _clearQrExpiryTimer(tenant);
    tenant.status = 'disconnected';
    tenant.lastQrImage = null;
    tenant.clientInfo = null;
    tenant.client = null;
    tenant.connectedAt = null;
    _emit(restaurantId, 'status', { status: tenant.status });
  });

  const isNewConversationalMessage = (msg, chatJid) => {
    if (msg.isStatus || msg.broadcast || chatJid === 'status@broadcast') return false;
    if (typeof chatJid === 'string' && chatJid.endsWith('@g.us')) return false;
    if (msg.type && NON_CONVERSATIONAL_TYPES.has(msg.type)) return false;
    // history backlog replayed on every fresh connect — not a new message
    if (!tenant.connectedAt || (typeof msg.timestamp === 'number' && msg.timestamp < tenant.connectedAt)) return false;
    return true;
  };

  client.on('message', async (msg) => {
    const jid = msg.from;
    if (!isNewConversationalMessage(msg, jid)) return;

    const contact = await msg.getContact().catch(() => null);
    const { number, resolved: numberResolved } = await _resolveNumber(client, label, jid, contact);

    _emit(restaurantId, 'message', {
      waMessageId: msg.id?.id || null,
      jid,
      number,
      numberResolved,
      contactName: contact?.pushname || contact?.name || null,
      body: msg.body || '',
      type: msg.type || 'chat',
      timestamp: msg.timestamp, // seconds, per whatsapp-web.js
      ...(await _inboundMedia(msg, label)),
    });
  });

  client.initialize().catch((err) => {
    // A client we already tore down on purpose (unwatched QR, destroy,
    // logout) rejects its pending initialize() with "Target closed" — that's
    // expected, and must not overwrite the state that teardown reported.
    if (tenant.client !== client) return;
    console.error(`[gateway] tenant=${label} initialize error:`, err.message);
    tenant.status = 'error';
    tenant.client = null;
    _emit(restaurantId, 'status', { status: tenant.status });
    _emit(restaurantId, 'error', { message: err.message });
  });

  return _statusPayload(tenant);
}

/**
 * Resolve which JID/LID to send to. The gateway has no message history of
 * its own (that lives in the backend's DB) — the caller (backend) must pass
 * the last-known jid/lid for this contact, if any; falls back to
 * getNumberId() for a brand-new outbound-first contact.
 */
async function _resolveSendTarget(tenant, digits, knownTargetId) {
  if (!tenant.client || tenant.status !== 'connected') {
    throw new Error('WhatsApp is not ready. Scan the QR code first.');
  }

  const client_ = tenant.client;
  const isDetachedFrameError = (err) => /detached Frame/i.test(err?.message || '');
  const rethrowIfDeadClient = (restaurantId) => (err) => {
    if (!isDetachedFrameError(err)) throw err;
    if (tenant.client === client_) {
      tenant.status = 'disconnected';
      tenant.lastQrImage = null;
      tenant.clientInfo = null;
      tenant.client = null;
      _emit(restaurantId, 'status', { status: tenant.status });
    }
    throw new Error('WhatsApp session was lost (browser disconnected). Please reconnect and try again.');
  };

  if (knownTargetId) return { targetId: knownTargetId, rethrowIfDeadClient };

  let numberId;
  try {
    numberId = await tenant.client.getNumberId(digits);
  } catch (err) {
    throw err;
  }
  if (!numberId) throw new Error(`"${digits}" is not a valid WhatsApp number.`);
  return { targetId: numberId._serialized, rethrowIfDeadClient };
}

async function sendMessage(restaurantId, digits, message, knownTargetId) {
  const tenant = _getTenant(restaurantId);
  const { targetId, rethrowIfDeadClient } = await _resolveSendTarget(tenant, digits, knownTargetId);

  let sent;
  try {
    sent = await tenant.client.sendMessage(targetId, String(message), { sendSeen: false });
  } catch (err) {
    rethrowIfDeadClient(restaurantId)(err);
  }
  return { messageId: sent?.id?.id || null, targetId };
}

async function sendMediaMessage(restaurantId, digits, fileBufferBase64, filename, mimeType, caption, knownTargetId) {
  const tenant = _getTenant(restaurantId);
  const { targetId, rethrowIfDeadClient } = await _resolveSendTarget(tenant, digits, knownTargetId);

  const media = new MessageMedia(mimeType, fileBufferBase64, filename);
  let sent;
  try {
    sent = await tenant.client.sendMessage(targetId, media, { caption: caption || undefined, sendSeen: false });
  } catch (err) {
    rethrowIfDeadClient(restaurantId)(err);
  }
  return { messageId: sent?.id?.id || null, targetId };
}

async function destroySession(restaurantId) {
  const tenant = _getTenant(restaurantId);
  _clearQrExpiryTimer(tenant);
  if (!tenant.client) {
    // e.g. logout() above already tore the client down — still make sure
    // the owning project hears the final state exactly once.
    if (tenant.status !== 'disconnected') {
      tenant.status = 'disconnected';
      tenant.lastQrImage = null;
      tenant.clientInfo = null;
      _emit(restaurantId, 'status', { status: tenant.status });
    }
    return;
  }
  const client = tenant.client;
  tenant.client = null; // before destroy(), so its in-flight initialize() rejection is ignored
  try { await client.destroy(); } catch (_) { }

  // A new initSession() may have raced in and already assigned a live
  // client while the old one's destroy() was still tearing down (it's a
  // real Puppeteer/Chromium shutdown, not instant) — don't stomp that
  // session's state back to disconnected, and don't emit a status for it
  // that describes the OLD client, not the current one.
  if (tenant.client) return;

  tenant.status = 'disconnected';
  tenant.lastQrImage = null;
  tenant.clientInfo = null;
  _emit(restaurantId, 'status', { status: tenant.status });
}

async function logoutSession(restaurantId) {
  // Unlink on WhatsApp's side first, so the device disappears from the
  // phone's "Linked devices" list — destroy() alone only closes our
  // browser and leaves the link active until WhatsApp expires it.
  const tenant = _getTenant(restaurantId);
  if (tenant.client && tenant.status === 'connected') {
    try {
      await tenant.client.logout();
    } catch (err) {
      console.warn(`[gateway] tenant=${_key(restaurantId)} logout() failed (continuing to destroy):`, err.message);
    }
  }
  await destroySession(restaurantId);
  await new Promise((resolve) => setTimeout(resolve, 3000));

  // A new initSession() may have raced in during the delay above (e.g. the
  // caller immediately retries after logout) and already be writing to this
  // same on-disk profile — deleting it out from under a live client would
  // corrupt that session, not this one's. Only clean up if nothing is using
  // this tenant's directory right now.
  if (tenant.client) {
    console.log(`[gateway] tenant=${_key(restaurantId)} logout: a new session started before cleanup — leaving its directory alone.`);
    return;
  }

  const dataPath = _authDataPath(restaurantId);
  try {
    await fs.promises.rm(dataPath, { recursive: true, force: true });
    console.log(`[gateway] tenant=${_key(restaurantId)} session directory removed.`);
  } catch (err) {
    console.warn(`[gateway] tenant=${_key(restaurantId)} failed to remove session dir:`, err.message);
  }
}

/**
 * Resumes every tenant key already claimed by some project (per
 * projectRegistry's ownership file) — called once on server boot so a
 * gateway restart brings every previously-connected tenant back on its own,
 * with no consuming project needing to ask for it first.
 *
 * Subscribers start false: a tenant whose saved session is still valid
 * resumes straight to 'connected' (no QR involved), but one whose session
 * has expired server-side would otherwise emit a QR nobody is watching yet
 * — that gets discarded and the tenant reported 'disconnected' instead,
 * exactly like any other unwatched QR (see the 'qr' handler above). Its
 * owning project sees that status push and can prompt a fresh scan.
 */
async function restoreClaimedSessions(tenantKeys) {
  for (const key of tenantKeys) {
    const restaurantId = key === PLATFORM_TENANT_KEY ? null : key;
    setHasSubscribers(restaurantId, false);
    try {
      await initSession(restaurantId);
    } catch (err) {
      console.error(`[gateway] tenant=${key} failed to restore on boot:`, err.message);
    }
    // Launching every tenant's Chromium at once starves the CPU and makes
    // protocol calls time out — space the boot restores out.
    await new Promise((r) => setTimeout(r, 4000));
  }
}

/**
 * Graceful process shutdown: close every tenant's browser cleanly so Chromium
 * flushes the WhatsApp login (IndexedDB/cookies) to the profile — a hard kill
 * mid-write is what makes a saved session unreadable on the next boot.
 * Deliberately NOT logout: the phone stays linked and the profile stays on
 * disk, so the next start resumes with no QR. Emits nothing to projects (the
 * process is going away; that isn't an unexpected disconnect to alert on).
 */
async function shutdownAll() {
  const closing = [];
  for (const [key, tenant] of tenants) {
    if (!tenant.client) continue;
    _clearQrExpiryTimer(tenant);
    const client = tenant.client;
    tenant.client = null; // so its own 'disconnected'/initialize handlers stay quiet
    closing.push(
      client.destroy().catch((err) => console.warn(`[gateway] tenant=${key} error closing browser on shutdown:`, err.message))
    );
  }
  await Promise.all(closing);
}

module.exports = {
  PLATFORM_TENANT_KEY,
  shutdownAll,
  onEvent,
  setHasSubscribers,
  initSession,
  restoreClaimedSessions,
  sendMessage,
  sendMediaMessage,
  destroySession,
  logoutSession,
};
