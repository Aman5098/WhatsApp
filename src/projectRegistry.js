'use strict';

/**
 * projectRegistry.js
 *
 * Lets multiple independent projects share one whatsapp-gateway instance,
 * each managing its own set of tenants, without seeing or touching each
 * other's sessions/events.
 *
 * - Each project has its own API key, defined in projects.json (or via the
 *   PROJECTS env var — see _loadFromEnv below) — never a single shared
 *   secret for everyone.
 * - Tenant ownership (`restaurantId` -> `projectId`) is claimed the first
 *   time a project calls wa:init/init for that restaurantId, and persisted
 *   to disk so a gateway restart doesn't forget who owns what and let a
 *   different project hijack an existing tenant.
 *
 * NOTE: this is intentionally a flat JSON file, not a database — the
 * gateway has no DB of its own by design (see sessionManager.js's header).
 * If the number of projects/tenants grows large enough for this to matter,
 * swap _load/_save for a real store without changing the public API below.
 */

const fs = require('fs');
const path = require('path');

const PROJECTS_FILE = path.join(__dirname, '..', 'projects.json');
// Override with TENANT_OWNERSHIP_FILE to keep it on a mounted volume — it
// must survive restarts just like the sessions themselves.
const OWNERSHIP_FILE = process.env.TENANT_OWNERSHIP_FILE || path.join(__dirname, '..', '.tenant-ownership.json');

// ─── Projects (id -> apiKey) ────────────────────────────────────────────────
/**
 * projects.json shape:
 * {
 *   "dinera-backend":  { "apiKey": "..." },
 *   "some-other-app":  { "apiKey": "..." }
 * }
 *
 * Falls back to a single legacy project "default" using
 * GATEWAY_SHARED_SECRET, so existing single-project deployments (just the
 * Dinera backend) keep working without creating projects.json.
 */
function _loadProjects() {
  try {
    const raw = fs.readFileSync(PROJECTS_FILE, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    if (err.code !== 'ENOENT') console.error('[projectRegistry] failed to read projects.json:', err.message);
    if (process.env.GATEWAY_SHARED_SECRET) {
      return { default: { apiKey: process.env.GATEWAY_SHARED_SECRET } };
    }
    return {};
  }
}

let _projects = _loadProjects();
let _apiKeyIndex = _buildApiKeyIndex(_projects);

function _buildApiKeyIndex(projects) {
  const index = new Map();
  for (const [projectId, cfg] of Object.entries(projects)) {
    if (cfg?.apiKey) index.set(cfg.apiKey, projectId);
  }
  return index;
}

function reloadProjects() {
  _projects = _loadProjects();
  _apiKeyIndex = _buildApiKeyIndex(_projects);
}

/** Returns the projectId for a given API key, or null if unrecognized. */
function resolveProjectByApiKey(apiKey) {
  if (!apiKey) return null;
  return _apiKeyIndex.get(apiKey) || null;
}

function listProjectIds() {
  return Object.keys(_projects);
}

// ─── Tenant ownership (restaurantId -> projectId) ──────────────────────────
function _tenantKey(restaurantId) {
  return restaurantId || '__platform__';
}

function _loadOwnership() {
  try {
    return JSON.parse(fs.readFileSync(OWNERSHIP_FILE, 'utf8'));
  } catch (err) {
    return {};
  }
}

let _ownership = _loadOwnership();

function _saveOwnership() {
  try {
    fs.writeFileSync(OWNERSHIP_FILE, JSON.stringify(_ownership, null, 2));
  } catch (err) {
    console.error('[projectRegistry] failed to persist tenant ownership:', err.message);
  }
}

/**
 * Returns the projectId that owns this tenant, or null if unclaimed.
 */
function getOwner(restaurantId) {
  return _ownership[_tenantKey(restaurantId)] || null;
}

/**
 * Claims a tenant for a project if unclaimed, or verifies the existing
 * claim. Throws if a DIFFERENT project already owns this tenant — one
 * restaurantId can only ever belong to one project, since restaurantId
 * values are only unique within their own project's database.
 *
 * Callers needing cross-project-safe tenant ids should namespace
 * restaurantId themselves (e.g. "<projectId>:<restaurantId>") before
 * calling into the gateway, rather than relying on this claim as a dedupe.
 */
function claimTenant(restaurantId, projectId) {
  const key = _tenantKey(restaurantId);
  const owner = _ownership[key];
  if (owner && owner !== projectId) {
    const err = new Error(`Tenant "${key}" is already owned by project "${owner}".`);
    err.code = 'TENANT_OWNED_BY_OTHER_PROJECT';
    throw err;
  }
  if (!owner) {
    _ownership[key] = projectId;
    _saveOwnership();
  }
}

function releaseTenant(restaurantId) {
  const key = _tenantKey(restaurantId);
  if (_ownership[key]) {
    delete _ownership[key];
    _saveOwnership();
  }
}

/**
 * Every currently-claimed tenant key (the same internal keys
 * sessionManager._key()/PLATFORM_TENANT_KEY uses — '__platform__' for the
 * null/platform tenant, the raw restaurantId otherwise). Used at boot to
 * resume every tenant a project previously connected, without needing that
 * project to reconnect and ask for it first.
 */
function listClaimedTenantKeys() {
  return Object.keys(_ownership);
}

module.exports = {
  reloadProjects,
  resolveProjectByApiKey,
  listProjectIds,
  getOwner,
  claimTenant,
  releaseTenant,
  listClaimedTenantKeys,
};
