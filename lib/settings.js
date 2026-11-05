/**
 * Editable plugin configuration: peers, the shared token and the incoming
 * workspace root.
 *
 * Edits go through the profile's own config editor, so the `cordis.patch.yml`
 * row stays the single source of truth and survives plugin upgrades. The token
 * is never sent to the browser: the page only learns whether one exists, and a
 * save that omits it keeps the stored value.
 * @module dsh-ferry/lib/settings
 */
import os from 'node:os';
import path from 'node:path';
import { normalizeConfig } from './config.js';
import { HttpError } from './http.js';
import { canonicalRoots, canonicalize, isInside } from './paths.js';

/** Maximum peers one profile may configure. */
const MAX_PEERS = 32;

/**
 * Build the settings operations.
 * @param {object} options - wiring.
 * @param {import('@deepseek-ai/cordis').Context} options.ctx - plugin context.
 * @param {object} options.config - normalized config of the running instance.
 * @returns {object} settings API.
 */
export function createSettings({ ctx, config }) {
  const editor = ctx.get('configEditor');

  /** @returns {object | undefined} the loader entry of this plugin row. */
  const findEntry = () => {
    if (editor === undefined) return undefined;
    return editor
      .entries()
      .find((entry) => entry?.options?.id === 'dsh-ferry' || entry?.options?.name === 'dsh-ferry');
  };

  /**
   * Read the settings the page may display.
   * @returns {Promise<object>} public settings without the token value.
   */
  const read = async () => ({
    instance: { id: config.instance.id, name: config.instance.name },
    importRoots: config.importRoots,
    incomingRoot: config.incomingRoot,
    editable: editor !== undefined && findEntry() !== undefined,
    tokenSet: config.token !== '',
    peers: config.peers.map((peer) => ({ id: peer.id, name: peer.name, url: peer.url })),
  });

  /**
   * Persist peers, the shared token and the incoming root.
   * @param {object} input - page payload.
   * @param {Array<{ id: string, name?: string, url: string }>} input.peers - desired peers.
   * @param {string} [input.token] - new shared token; omitted or blank keeps the stored one.
   * @param {string} input.incomingRoot - desired incoming workspace root.
   * @returns {Promise<object>} the applied settings.
   */
  const save = async ({ peers, incomingRoot, token }) => {
    if (editor === undefined) {
      throw new HttpError(503, 'settings-unavailable', 'This profile has no config editor; edit cordis.patch.yml instead');
    }
    const entry = findEntry();
    if (entry === undefined) {
      throw new HttpError(409, 'settings-unaddressable', 'This plugin row is not addressable in the profile patch');
    }
    if (!Array.isArray(peers)) throw new HttpError(400, 'bad-request', 'peers must be a list');
    if (peers.length > MAX_PEERS) throw new HttpError(400, 'too-many-peers', `At most ${MAX_PEERS} peers`);
    if (typeof incomingRoot !== 'string' || incomingRoot.trim() === '') {
      throw new HttpError(400, 'bad-request', 'incomingRoot must be a non-empty path');
    }
    const suppliedToken = typeof token === 'string' ? token.trim() : '';
    if (suppliedToken === '' && config.token === '' && peers.length > 0) {
      throw new HttpError(400, 'token-required', 'Peers need a shared token; enter one above');
    }
    const rawRoot = incomingRoot.trim();
    const nextRoot =
      rawRoot === '~'
        ? os.homedir()
        : rawRoot.startsWith('~/')
          ? path.join(os.homedir(), rawRoot.slice(2))
          : path.resolve(rawRoot);

    // The incoming root is written before the Loader reloads the row, so its
    // admission check must happen first.
    const roots = await canonicalRoots(config.importRoots);
    const incoming = await canonicalize(nextRoot);
    if (roots.length > 0 && !roots.some((root) => isInside(root, incoming))) {
      throw new HttpError(
        400,
        'incoming-root-outside',
        `incomingRoot "${nextRoot}" is outside importRoots (${config.importRoots.join(', ')})`,
      );
    }

    let normalized;
    const reconcile = editor.edit(entry, (current) => {
      const mergedPeers = peers.map((peer, index) => {
        if (peer === null || typeof peer !== 'object') throw new HttpError(400, 'bad-peer', `peers[${index}] is not an object`);
        const id = typeof peer.id === 'string' ? peer.id.trim() : '';
        const name = typeof peer.name === 'string' && peer.name.trim() !== '' ? peer.name.trim() : id;
        const url = typeof peer.url === 'string' ? peer.url.trim() : '';
        if (id === '' || url === '') throw new HttpError(400, 'bad-peer', `peers[${index}] needs both id and url`);
        return { id, name, url };
      });
      const tokenNow =
        suppliedToken !== ''
          ? suppliedToken
          : typeof current.token === 'string' && current.token.trim() !== ''
            ? current.token.trim()
            : config.token;
      if (tokenNow === '' && mergedPeers.length > 0) {
        throw new HttpError(400, 'token-required', 'Peers need a shared token; enter one above');
      }
      const workspace = current.workspace !== null && typeof current.workspace === 'object' ? current.workspace : {};
      const next = {
        ...current,
        peers: mergedPeers,
        ...(tokenNow === '' ? {} : { token: tokenNow }),
        workspace: { ...workspace, incomingRoot: nextRoot },
      };
      // Old per-peer tokens are dropped here; the fleet-wide token replaces them.
      if (tokenNow === '' && Object.hasOwn(next, 'token')) delete next.token;
      // Validate the complete row before it reaches the Loader: an invalid
      // peer would otherwise fail activation and leave the plugin disabled.
      normalized = normalizeConfig(next);
      return next;
    });
    try {
      await reconcile;
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw new HttpError(400, 'invalid-config', error instanceof Error ? error.message : String(error));
    }

    return readWith(normalized);
  };

  /**
   * Public view of a normalized config.
   * @param {object} value - normalized config.
   * @returns {object} public settings.
   */
  const readWith = (value) => ({
    instance: { id: value.instance.id, name: value.instance.name },
    importRoots: value.importRoots,
    incomingRoot: value.incomingRoot,
    editable: true,
    tokenSet: value.token !== '',
    peers: value.peers.map((peer) => ({ id: peer.id, name: peer.name, url: peer.url })),
  });

  return { read, save };
}
