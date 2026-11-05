/**
 * Configuration normalization for the dsh-ferry Host plugin.
 *
 * The plugin declares no schemastery `Config` because a profile-installed
 * plain-JavaScript plugin cannot import `@deepseek-ai/schemastery`; this module
 * therefore validates the row's `config` itself and fills every default, so a
 * typo fails activation with an actionable message instead of misbehaving at
 * transfer time.
 * @module dsh-ferry/lib/config
 */
import os from 'node:os';
import path from 'node:path';
import { normalizeWorkspaceRules } from './workspace.js';

/**
 * Normalize one peer entry.
 * @param {unknown} raw - peer configuration.
 * @param {number} index - position, for diagnostics.
 * @returns {{ id: string, name: string, url: string, token: string }} peer.
 */
function normalizePeer(raw, index) {
  if (raw === null || typeof raw !== 'object') throw new Error(`dsh-ferry: peers[${index}] must be an object`);
  const value = /** @type {Record<string, unknown>} */ (raw);
  const id = typeof value.id === 'string' && value.id.trim() !== '' ? value.id.trim() : undefined;
  const name = typeof value.name === 'string' && value.name.trim() !== '' ? value.name.trim() : id;
  const token = typeof value.token === 'string' ? value.token.trim() : '';
  if (id === undefined) throw new Error(`dsh-ferry: peers[${index}].id is required`);
  if (typeof value.url !== 'string' || value.url.trim() === '') {
    throw new Error(`dsh-ferry: peers[${index}].url is required (for example http://100.64.0.2:3080)`);
  }
  if (token === '') throw new Error(`dsh-ferry: peers[${index}].token is required`);
  let parsed;
  try {
    parsed = new URL(value.url.trim());
  } catch {
    throw new Error(`dsh-ferry: peers[${index}].url is not a valid URL: ${value.url}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`dsh-ferry: peers[${index}].url must be http or https`);
  }
  if (parsed.pathname !== '/' || parsed.search !== '' || parsed.hash !== '') {
    throw new Error(`dsh-ferry: peers[${index}].url must be an origin without a path, such as http://100.64.0.2:3080`);
  }
  return { id: /** @type {string} */ (id), name: name ?? /** @type {string} */ (id), url: parsed.origin, token };
}

/**
 * Normalize the plugin configuration.
 * @param {unknown} raw - loader row config.
 * @returns {object} normalized configuration.
 */
export function normalizeConfig(raw = {}) {
  const value = raw !== null && typeof raw === 'object' ? raw : {};
  const instanceRaw = value.instance !== null && typeof value.instance === 'object' ? value.instance : {};
  const hostname = os.hostname();
  const instance = {
    id:
      typeof instanceRaw.id === 'string' && instanceRaw.id.trim() !== ''
        ? instanceRaw.id.trim()
        : hostname.toLowerCase().replace(/[^\w.-]+/g, '-'),
    name:
      typeof instanceRaw.name === 'string' && instanceRaw.name.trim() !== ''
        ? instanceRaw.name.trim()
        : hostname,
  };
  if (!Array.isArray(value.peers ?? [])) throw new Error('dsh-ferry: peers must be a list');
  const peers = (value.peers ?? []).map(normalizePeer);
  const seen = new Set();
  for (const peer of peers) {
    if (seen.has(peer.id)) throw new Error(`dsh-ferry: duplicate peer id "${peer.id}"`);
    if (peer.id === instance.id) throw new Error(`dsh-ferry: peer id "${peer.id}" equals this instance's id`);
    seen.add(peer.id);
  }

  const home = os.homedir();
  let importRoots;
  if (value.importRoots === undefined) importRoots = [home];
  else if (!Array.isArray(value.importRoots) || value.importRoots.some((item) => typeof item !== 'string')) {
    throw new Error('dsh-ferry: importRoots must be a list of absolute paths');
  } else {
    importRoots = value.importRoots.map((item) => item.trim()).filter((item) => item !== '');
    if (importRoots.length === 0) importRoots = [];
  }

  const dshHome = process.env.DSH_HOME !== undefined && process.env.DSH_HOME !== '' ? process.env.DSH_HOME : path.join(home, '.dsh');
  const dataDir =
    typeof value.dataDir === 'string' && value.dataDir.trim() !== ''
      ? path.resolve(value.dataDir.trim())
      : path.join(dshHome, 'ferry');

  const serverToken = typeof value.serverToken === 'string' ? value.serverToken.trim() : '';
  const workspaceIncoming =
    value.workspace !== null && typeof value.workspace === 'object' && typeof value.workspace.incomingRoot === 'string'
      ? value.workspace.incomingRoot.trim()
      : '';
  const incomingRoot =
    workspaceIncoming === ''
      ? path.join(dshHome, 'ferry', 'incoming')
      : path.resolve(expandHome(workspaceIncoming, home));
  if (!path.isAbsolute(incomingRoot)) throw new Error('dsh-ferry: workspace.incomingRoot must be an absolute path');
  const timeouts = value.timeouts !== null && typeof value.timeouts === 'object' ? value.timeouts : {};
  const requestTimeoutMs = positive(timeouts.requestMs, 20 * 60 * 1000, 'timeouts.requestMs');
  const handshakeTimeoutMs = positive(timeouts.handshakeMs, 6000, 'timeouts.handshakeMs');

  return {
    instance,
    peers,
    serverToken: serverToken === '' ? undefined : serverToken,
    importRoots,
    dataDir,
    workspace: normalizeWorkspaceRules(value.workspace),
    incomingRoot,
    maxSessionBytes: positive(value.maxSessionBytes, 256 * 1024 * 1024, 'maxSessionBytes'),
    maxAttachmentBytes: positive(value.maxAttachmentBytes, 128 * 1024 * 1024, 'maxAttachmentBytes'),
    requestTimeoutMs,
    handshakeTimeoutMs,
    maxSkewMs: positive(value.maxSkewMs, 5 * 60 * 1000, 'maxSkewMs'),
  };
}

/**
 * Expand a leading `~` or `~/` to the process home directory.
 * @param {string} value - configured path.
 * @param {string} home - home directory.
 * @returns {string} expanded path.
 */
function expandHome(value, home) {
  if (value === '~') return home;
  if (value.startsWith('~/')) return path.join(home, value.slice(2));
  return value;
}

/** @param {unknown} value @param {number} fallback @param {string} name @returns {number} */
function positive(value, fallback, name) {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`dsh-ferry: ${name} must be a positive integer`);
  }
  return value;
}
