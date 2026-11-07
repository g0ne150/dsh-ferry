/**
 * Outbound peer operations: signed HTTP requests between DSH instances.
 *
 * The plugin does not implement networking. It assumes the operator made the
 * peer's web listener reachable (Tailscale today, a LAN or an SSH tunnel
 * tomorrow). Every failure here is reported as a transport result — "unreachable"
 * is a first-class answer, not an exception the UI has to guess at.
 * @module dsh-ferry/lib/ferry
 */
import { Readable } from 'node:stream';
import { createGunzip, createGzip } from 'node:zlib';
import { NonceWindow, signRequest, verifyRequest } from './auth.js';
import { HttpError } from './http.js';

/** Path prefix owned by this plugin on the peer's web server. */
export const PEER_PREFIX = '/dsh-ferry/v1';

/**
 * Turn one `fetch` failure into an actionable message.
 * @param {unknown} error - thrown value.
 * @param {string} url - attempted URL.
 * @returns {Error} normalized error.
 */
function transportError(error, url) {
  if (error instanceof HttpError) return error;
  const name = error instanceof Error ? error.name : '';
  if (name === 'TimeoutError' || name === 'AbortError') {
    return new HttpError(504, 'timeout', `Peer did not answer in time (${url})`);
  }
  const cause = error instanceof Error && error.cause instanceof Error ? `: ${error.cause.message}` : '';
  return new HttpError(
    502,
    'unreachable',
    `Cannot reach the peer at ${url}${cause}. Check that the peer's DSH web server listens on an address this host can reach (for example its Tailscale IP, not 127.0.0.1).`,
  );
}

/**
 * Join a peer origin and an endpoint path.
 * @param {{ url: string }} peer - peer entry.
 * @param {string} path - endpoint including query.
 * @returns {string} absolute URL.
 */
export function peerUrl(peer, path) {
  return `${peer.url}${PEER_PREFIX}${path}`;
}

/**
 * Build the outbound operations object.
 * @param {object} options - wiring.
 * @param {import('@deepseek-ai/cordis').Context} options.ctx - plugin context.
 * @param {object} options.config - normalized config.
 * @param {object} options.transfer - transfer engine.
 * @param {(message: string) => void} [options.log] - logger.
 * @returns {object} ferry API.
 */
export function createFerry({ ctx, config, transfer, log = () => {} }) {
  const peers = new Map(config.peers.map((peer) => [peer.id, peer]));
  /** @type {Array<{ peerId: string, token: string }>} */
  const secrets = [];
  // One fleet-wide token authenticates every peer in both directions; the
  // claimed peer id is a label, not a per-peer credential.
  if (config.token !== '') secrets.push({ peerId: '*', token: config.token });
  if (config.serverToken !== undefined) secrets.push({ peerId: '*', token: config.serverToken });
  const hasToken = config.token !== '';

  /** @returns {string} the configured shared token. */
  const requireToken = () => {
    if (!hasToken) {
      throw new HttpError(
        409,
        'no-token',
        'No shared token is configured; open the dsh-ferry panel and set one',
      );
    }
    return config.token;
  };
  const nonces = new NonceWindow();
  /** @type {string[] | null} */

  /**
   * Resolve one configured peer.
   * @param {string} peerId - peer id.
   * @returns {{ id: string, name: string, url: string }} peer.
   */
  const requirePeer = (peerId) => {
    const peer = peers.get(peerId);
    if (peer === undefined) throw new HttpError(404, 'unknown-peer', `Unknown peer "${peerId}"`);
    return peer;
  };

  /**
   * Compose the cancellation signal for one outbound request.
   * @param {AbortSignal} [signal] - caller cancellation.
   * @param {number} [timeoutMs] - request budget.
   * @returns {AbortSignal} combined signal.
   */
  const budget = (signal, timeoutMs = config.requestTimeoutMs) => {
    const timeout = AbortSignal.timeout(timeoutMs);
    return signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
  };

  /**
   * Send one signed JSON request.
   * @param {{ id: string, url: string }} peer - peer.
   * @param {string} path - endpoint with query.
   * @param {unknown} payload - JSON body.
   * @param {AbortSignal} [signal] - cancellation.
   * @param {number} [timeoutMs] - request budget.
   * @returns {Promise<unknown>} decoded JSON result.
   */
  const callJson = async (peer, path, payload, signal, timeoutMs) => {
    const headers = {
      ...signRequest({ secret: requireToken(), peerId: config.instance.id, method: 'POST', path: `${PEER_PREFIX}${path}` }),
      'content-type': 'application/json',
    };
    let response;
    try {
      response = await fetch(peerUrl(peer, path), {
        method: 'POST',
        headers,
        body: JSON.stringify(payload ?? {}),
        signal: budget(signal, timeoutMs),
      });
    } catch (error) {
      throw transportError(error, peerUrl(peer, path));
    }
    const text = await response.text();
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      throw new HttpError(502, 'bad-response', `Peer returned a non-JSON response (${response.status})`);
    }
    if (!response.ok || body?.ok === false) {
      const failure = body?.error ?? {};
      throw new HttpError(
        response.status === 401 ? 502 : response.status,
        typeof failure.code === 'string' ? failure.code : 'peer-error',
        typeof failure.message === 'string' ? failure.message : `Peer refused the request (${response.status})`,
      );
    }
    return body;
  };

  /**
   * Check one peer's reachability and identity.
   * @param {{ id: string, name: string, url: string, token: string }} peer - peer.
   * @returns {Promise<object>} status row.
   */
  const checkPeer = async (peer) => {
    const started = Date.now();
    if (!hasToken) {
      return {
        id: peer.id,
        name: peer.name,
        url: peer.url,
        online: false,
        latencyMs: 0,
        error: { code: 'no-token', message: 'No shared token is configured on this instance' },
      };
    }
    try {
      const body = await callJson(peer, '/ping', {}, undefined, config.handshakeTimeoutMs);
      return {
        id: peer.id,
        name: peer.name,
        url: peer.url,
        online: true,
        latencyMs: Date.now() - started,
        instance: body.instance,
      };
    } catch (error) {
      return {
        id: peer.id,
        name: peer.name,
        url: peer.url,
        online: false,
        latencyMs: Date.now() - started,
        error: {
          code: error instanceof HttpError ? error.code : 'unreachable',
          message: error instanceof Error ? error.message : String(error),
        },
      };
    }
  };

  /**
   * Report this instance and every configured peer.
   * @returns {Promise<object>} status.
   */
  const status = async () => ({
    self: { id: config.instance.id, name: config.instance.name, importRoots: config.importRoots },
    peers: await Promise.all(config.peers.map(checkPeer)),
  });

  /**
   * List the sessions visible on a peer.
   * @param {string} peerId - peer id.
   * @param {AbortSignal} [signal] - cancellation.
   * @returns {Promise<object>} session rows.
   */
  const remoteSessions = async (peerId, signal) => callJson(requirePeer(peerId), '/sessions', {}, signal);

  /**
   * Describe one session on a peer.
   * @param {string} peerId - peer id.
   * @param {string} sessionId - session id.
   * @param {object} [options] - options.
   * @param {AbortSignal} [options.signal] - cancellation.
   * @param {'auto'|'include'|'skip'} [options.git] - git handling.
   * @returns {Promise<object>} description.
   */
  const remoteDescribe = async (peerId, sessionId, { signal, git } = {}) =>
    callJson(requirePeer(peerId), '/describe', { sessionId, git }, signal);

  /**
   * Stream a bundle to a peer.
   * @param {{ id: string, url: string }} peer - peer.
   * @param {string} path - endpoint with query.
   * @param {AsyncIterable<Uint8Array>} frames - framed bundle.
   * @param {AbortSignal} [signal] - cancellation.
   * @returns {Promise<object>} receiver result.
   */
  const upload = async (peer, path, frames, signal) => {
    const url = peerUrl(peer, path);
    const headers = {
      ...signRequest({ secret: requireToken(), peerId: config.instance.id, method: 'POST', path: `${PEER_PREFIX}${path}` }),
      'content-type': 'application/vnd.dsh-ferry.bundle',
      'x-ferry-encoding': 'gzip',
    };
    const body = Readable.toWeb(Readable.from(frames).pipe(createGzip({ level: 4 })));
    let response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers,
        body,
        duplex: 'half',
        signal: budget(signal),
      });
    } catch (error) {
      throw transportError(error, url);
    }
    const text = await response.text();
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new HttpError(502, 'bad-response', `Peer returned a non-JSON result (${response.status})`);
    }
    if (!response.ok || parsed?.ok === false) {
      const failure = parsed?.error ?? {};
      throw new HttpError(
        response.status,
        typeof failure.code === 'string' ? failure.code : 'peer-error',
        typeof failure.message === 'string' ? failure.message : `Peer refused the transfer (${response.status})`,
      );
    }
    return parsed;
  };

  /**
   * Ask every peer what it would do with one local session.
   *
   * This is the dialog's data source: one round trip yields reachability plus
   * the state of the copy on the other side, so the operator can choose between
   * a fresh copy and an in-place update before anything is uploaded.
   * @param {object} request - request.
   * @param {string} request.sessionId - local session id.
   * @param {AbortSignal} [request.signal] - cancellation.
   * @returns {Promise<object>} session summary and one row per peer.
   */
  const pushPlan = async ({ sessionId, signal }) => {
    const description = await transfer.describeSession(sessionId, { signal });
    const timeout = Math.max(config.handshakeTimeoutMs, 15_000);
    const rows = await Promise.all(
      config.peers.map(async (peer) => {
        const online = await checkPeer(peer);
        if (online.online !== true) return { ...online, state: 'unknown' };
        try {
          const exchange = await callJson(
            peer,
            '/import/preflight',
            {
              sessionId,
              eventCount: description.session.eventCount,
              conversationCount: description.session.conversationCount,
              createdAt: description.session.createdAt,
              formatVersion: description.session.formatVersion,
              sourceRoot: description.session.cwd,
              merge: true,
              tail: description.session.tail,
            },
            signal,
            timeout,
          );
          const decision = exchange.result ?? {};
          return {
            ...online,
            state: typeof decision.state === 'string' ? decision.state : 'unknown',
            eventCount: decision.eventCount,
            active: decision.active === true,
            archived: decision.archived === true,
          };
        } catch (error) {
          return {
            ...online,
            state: 'unknown',
            error: {
              code: error instanceof HttpError ? error.code : 'unknown',
              message: error instanceof Error ? error.message : String(error),
            },
          };
        }
      }),
    );
    return { session: description.session, peers: rows };
  };

  /**
   * Push one local session (and its workspace) to a peer.
   * @param {object} request - push request.
   * @param {string} request.peerId - target peer.
   * @param {string} request.sessionId - local session id.
   * @param {'auto'|'new'|'update'} [request.mode] - how to treat an existing copy on the peer.
   * @param {string} [request.targetDir] - target working directory on the peer.
   * @param {boolean} [request.merge] - merge into a non-empty directory.
   * @param {'auto'|'include'|'skip'} [request.git] - git handling.
   * @param {boolean} [request.forkId] - import under a fresh session id.
   * @param {boolean} [request.archiveSource] - archive the source after success.
   * @param {boolean} [request.withWorkspace] - include workspace files.
   * @param {AbortSignal} [request.signal] - cancellation.
   * @returns {Promise<object>} peer result.
   */
  const push = async ({
    peerId,
    sessionId,
    mode = 'auto',
    targetDir,
    merge = false,
    git,
    forkId = false,
    archiveSource = false,
    withWorkspace = true,
    signal,
  }) => {
    const peer = requirePeer(peerId);
    requireToken();
    if (typeof sessionId !== 'string' || sessionId === '') throw new HttpError(400, 'bad-request', 'sessionId is required');
    const description = await transfer.describeSession(sessionId, { signal, git });
    if (description.workspace.overLimit) {
      throw new HttpError(
        413,
        'workspace-too-large',
        `Workspace is ${description.workspace.bytes} bytes, above the ${description.limits.maxWorkspaceBytes} byte limit`,
      );
    }
    const exchange = await callJson(
      peer,
      '/import/preflight',
      {
        // With a fresh id, an id collision on the peer is not a conflict.
        sessionId: forkId ? undefined : sessionId,
        eventCount: description.session.eventCount,
        conversationCount: description.session.conversationCount,
        createdAt: description.session.createdAt,
        formatVersion: description.session.formatVersion,
        // No target means the receiver applies its own mapping: reuse the
        // source directory when it exists there, else the incoming root.
        targetDir,
        sourceRoot: description.session.cwd,
        merge,
        tail: description.session.tail,
      },
      signal,
    );
    const preflight = exchange.result ?? {};
    if (preflight.ok === false) {
      throw new HttpError(409, preflight.code ?? 'preflight-failed', preflight.message ?? 'Peer refused the import');
    }
    const state = typeof preflight.state === 'string' ? preflight.state : 'unknown';
    const requested = mode === 'new' || mode === 'update' ? mode : 'auto';
    let freshId = forkId === true;
    let update = false;
    const warnings = [];
    if (!forkId) {
      if (requested === 'new') {
        freshId = state !== 'absent' && state !== 'unknown';
      } else if (requested === 'update') {
        if (state === 'ahead' || state === 'diverged') {
          throw new HttpError(
            409,
            preflight.code ?? `session-${state}`,
            `${preflight.message ?? 'The peer copy differs'}; push it as a new session instead`,
          );
        }
        if (preflight.active === true) {
          throw new HttpError(409, 'session-active', 'The peer is running this session; stop it there before updating it');
        }
        update = state === 'behind' || state === 'same';
      } else if (state === 'behind') {
        update = true;
      } else if (state === 'ahead' || state === 'diverged') {
        freshId = true;
        warnings.push({ code: 'sessionForked', state });
      }
    }
    if (!update && !freshId && preflight.decision === 'exists') {
      return {
        ok: true,
        status: 'exists',
        sessionId,
        targetDir: preflight.targetDir ?? targetDir,
        message: 'The peer already has this session with the same content',
      };
    }
    const resolvedTarget = preflight.targetDir;
    if (typeof resolvedTarget !== 'string' || resolvedTarget === '') {
      throw new HttpError(502, 'bad-response', 'Peer did not resolve a target directory for the import');
    }
    const { manifest, frames } = await transfer.exportSession(sessionId, { signal, git, withWorkspace });
    if (!withWorkspace) {
      // The peer must know it is a session-only transfer; it is implicit in a
      // bundle with no workspace entries.
      log(`dsh-ferry: pushing session ${sessionId} without workspace files`);
    }
    const query = new URLSearchParams({
      targetDir: String(resolvedTarget),
      merge: merge || update ? '1' : '0',
      forkId: freshId ? '1' : '0',
      update: update ? '1' : '0',
    });
    const result = await upload(peer, `/import?${query.toString()}`, frames, signal);
    if (archiveSource) {
      try {
        await ctx.workspaceRegistry.archiveSession(sessionId, { stopActivity: true });
      } catch (error) {
        result.warnings = [
          ...(Array.isArray(result.warnings) ? result.warnings : []),
          { code: 'sourceArchiveFailed', message: String(error) },
        ];
      }
    }
    if (warnings.length > 0) {
      result.warnings = [...(Array.isArray(result.warnings) ? result.warnings : []), ...warnings];
    }
    return { ...result, transfer: { bytes: manifest.totalBytes, session: manifest.session, workspace: manifest.workspace } };
  };

  /**
   * Ask what pulling one remote session would do to this instance.
   * @param {object} request - request.
   * @param {string} request.peerId - source peer.
   * @param {string} request.sessionId - remote session id.
   * @param {string} [request.targetDir] - local working directory.
   * @param {AbortSignal} [request.signal] - cancellation.
   * @returns {Promise<object>} plan.
   */
  const pullPlan = async ({ peerId, sessionId, targetDir, signal }) => {
    const peer = requirePeer(peerId);
    requireToken();
    if (typeof sessionId !== 'string' || sessionId === '') throw new HttpError(400, 'bad-request', 'sessionId is required');
    const description = await remoteDescribe(peerId, sessionId, { signal });
    const local = await transfer.preflight({
      sessionId,
      eventCount: description.session.eventCount,
      conversationCount: description.session.conversationCount,
      createdAt: description.session.createdAt,
      formatVersion: description.session.formatVersion,
      sourceRoot: description.session.cwd,
      targetDir,
      merge: true,
      tail: description.session.tail,
    });
    return {
      peer: { id: peer.id, name: peer.name },
      session: description.session,
      ok: local.ok !== false,
      state: local.state ?? 'unknown',
      eventCount: local.eventCount,
      active: local.active === true,
      archived: local.archived === true,
      targetDir: local.targetDir,
      ...(local.ok === false ? { message: local.message, code: local.code } : {}),
    };
  };

  /**
   * Pull one remote session (and its workspace) to this instance.
   * @param {object} request - pull request.
   * @param {string} request.peerId - source peer.
   * @param {string} request.sessionId - remote session id.
   * @param {'auto'|'new'|'update'} [request.mode] - how to treat an existing local copy.
   * @param {string} [request.targetDir] - local working directory.
   * @param {boolean} [request.merge] - merge into a non-empty directory.
   * @param {'auto'|'include'|'skip'} [request.git] - git handling.
   * @param {boolean} [request.forkId] - import under a fresh session id.
   * @param {AbortSignal} [request.signal] - cancellation.
   * @returns {Promise<object>} local import result.
   */
  const pull = async ({
    peerId,
    sessionId,
    mode = 'auto',
    targetDir,
    merge = false,
    git,
    forkId = false,
    signal,
  }) => {
    const peer = requirePeer(peerId);
    requireToken();
    if (typeof sessionId !== 'string' || sessionId === '') throw new HttpError(400, 'bad-request', 'sessionId is required');
    const description = await remoteDescribe(peerId, sessionId, { signal, git });
    const local = await transfer.preflight({
      sessionId: forkId ? undefined : sessionId,
      eventCount: description.session.eventCount,
      conversationCount: description.session.conversationCount,
      createdAt: description.session.createdAt,
      formatVersion: description.session.formatVersion,
      targetDir,
      sourceRoot: description.session.cwd,
      merge,
      tail: description.session.tail,
    });
    if (local.ok === false) {
      throw new HttpError(409, local.code ?? 'preflight-failed', local.message ?? 'Import refused');
    }
    const state = typeof local.state === 'string' ? local.state : 'unknown';
    const requested = mode === 'new' || mode === 'update' ? mode : 'auto';
    let freshId = forkId === true;
    let update = false;
    if (!forkId) {
      if (requested === 'new') {
        freshId = state !== 'absent' && state !== 'unknown';
      } else if (requested === 'update') {
        if (state === 'ahead' || state === 'diverged') {
          throw new HttpError(
            409,
            local.code ?? `session-${state}`,
            `${local.message ?? 'The local copy differs'}; pull it as a new session instead`,
          );
        }
        if (local.active === true) {
          throw new HttpError(409, 'session-active', 'This session is running here; stop it before updating it');
        }
        update = state === 'behind' || state === 'same';
      } else if (state === 'behind') {
        update = true;
      } else if (state === 'ahead' || state === 'diverged') {
        freshId = true;
      }
    }
    if (!update && !freshId && state === 'same') {
      return {
        ok: true,
        status: 'exists',
        sessionId,
        targetDir: local.targetDir,
        message: 'This instance already has the session with the same content',
      };
    }
    const path = '/export';
    const headers = {
      ...signRequest({ secret: requireToken(), peerId: config.instance.id, method: 'POST', path: `${PEER_PREFIX}${path}` }),
      'content-type': 'application/json',
    };
    const url = peerUrl(peer, path);
    let response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({ sessionId, git }),
        signal: budget(signal),
      });
    } catch (error) {
      throw transportError(error, url);
    }
    if (!response.ok) {
      const text = await response.text();
      let failure;
      try {
        failure = JSON.parse(text)?.error;
      } catch {
        failure = undefined;
      }
      throw new HttpError(
        response.status,
        typeof failure?.code === 'string' ? failure.code : 'export-failed',
        typeof failure?.message === 'string' ? failure.message : `Peer refused the export (${response.status})`,
      );
    }
    if (response.body === null) throw new HttpError(502, 'bad-response', 'Peer returned no bundle');
    const decoded = Readable.fromWeb(response.body).pipe(createGunzip());
    const result = await transfer.importSession({
      body: decoded,
      targetDir: local.targetDir,
      merge: merge || update,
      forkId: freshId,
      update,
      signal,
    });
    return { ...result, peer: { id: peer.id, name: peer.name } };
  };

  return {
    config,
    peers: config.peers,
    secrets,
    nonces,
    requirePeer,
    status,
    checkPeer,
    remoteSessions,
    remoteDescribe,
    push,
    pull,
    pushPlan,
    pullPlan,
    callJson,
  };
}

/**
 * Authenticate one inbound peer request.
 * @param {object} ferry - ferry API.
 * @param {import('node:http').IncomingMessage} req - request.
 * @param {number} maxSkewMs - accepted clock skew.
 * @returns {{ ok: true, peerId: string } | { ok: false, reason: string, status: number }} outcome.
 */
export function authenticateInbound(ferry, req, maxSkewMs) {
  return verifyRequest({
    headers: /** @type {Record<string, string | string[] | undefined>} */ (req.headers),
    method: req.method ?? 'GET',
    path: req.url ?? '/',
    secrets: ferry.secrets,
    nonces: ferry.nonces,
    maxSkewMs,
  });
}
