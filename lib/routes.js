/**
 * HTTP surfaces of dsh-ferry.
 *
 * Two channels, deliberately separate:
 * - `/dsh-ferry/v1/*` on the web server's raw listener: instance-to-instance
 *   traffic, authenticated by HMAC-signed requests.
 * - `/api/dsh-ferry/rpc` through the browser Connection: owner-only requests
 *   from the Harness page, authenticated by the browser session cookie.
 * @module dsh-ferry/lib/routes
 */
import { Readable } from 'node:stream';
import { createGzip } from 'node:zlib';
import { PROTOCOL } from './bundle.js';
import { authenticateInbound, PEER_PREFIX } from './ferry.js';
import { HttpError, jsonResponse, readFetchJson, readJson, requestBody, sendError, sendJson, sendStream } from './http.js';

/**
 * Build the node:http handler for the peer channel.
 * @param {object} options - wiring.
 * @param {object} options.config - normalized config.
 * @param {object} options.ferry - ferry API.
 * @param {object} options.transfer - transfer engine.
 * @param {(message: string) => void} [options.log] - logger.
 * @returns {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => Promise<void>} handler.
 */
export function createPeerHandler({ config, ferry, transfer, log = () => {} }) {
  return async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://ferry.local');
    const path = url.pathname;
    if (!path.startsWith(`${PEER_PREFIX}/`) && path !== PEER_PREFIX) {
      sendJson(res, 404, { ok: false, error: { code: 'not-found', message: 'Not a dsh-ferry endpoint' } });
      return;
    }
    if (req.method === 'GET' && path === `${PEER_PREFIX}/handshake`) {
      sendJson(res, 200, {
        ok: true,
        protocol: PROTOCOL,
        instance: { id: config.instance.id, name: config.instance.name },
        capabilities: ['session', 'workspace', 'attachments'],
      });
      return;
    }

    const authentication = authenticateInbound(ferry, req, config.maxSkewMs);
    if (authentication.ok !== true) {
      req.resume();
      sendJson(res, authentication.status, {
        ok: false,
        error: { code: authentication.reason, message: 'Peer authentication failed' },
      });
      return;
    }
    const peerId = authentication.peerId;

    try {
      if (req.method !== 'POST') {
        throw new HttpError(405, 'method-not-allowed', 'Use POST');
      }
      switch (path) {
        case `${PEER_PREFIX}/ping`: {
          await readJson(req, 64 * 1024);
          sendJson(res, 200, {
            ok: true,
            instance: { id: config.instance.id, name: config.instance.name },
            protocol: PROTOCOL,
            time: Date.now(),
          });
          return;
        }
        case `${PEER_PREFIX}/sessions`: {
          await readJson(req, 64 * 1024);
          const listed = await transfer.listLocalSessions({ all: false });
          sendJson(res, 200, { ok: true, sessions: listed.sessions });
          return;
        }
        case `${PEER_PREFIX}/describe`: {
          const body = await readJson(req, 256 * 1024);
          const description = await transfer.describeSession(String(body.sessionId ?? ''), {
            git: validGit(body.git),
          });
          sendJson(res, 200, { ok: true, ...description });
          return;
        }
        case `${PEER_PREFIX}/export`: {
          const body = await readJson(req, 256 * 1024);
          const { frames, manifest } = await transfer.exportSession(String(body.sessionId ?? ''), {
            git: validGit(body.git),
            withWorkspace: body.withWorkspace !== false,
          });
          const gzip = Readable.from(frames).pipe(createGzip({ level: 4 }));
          await sendStream(
            res,
            gzip,
            {
              'content-type': 'application/vnd.dsh-ferry.bundle',
              'x-ferry-encoding': 'gzip',
              'x-ferry-protocol': PROTOCOL,
              'x-ferry-session': String(manifest.session.id),
            },
            () => log(`dsh-ferry: export of ${String(manifest.session.id)} to ${peerId} aborted`),
          );
          return;
        }
        case `${PEER_PREFIX}/import/preflight`: {
          const body = await readJson(req, 256 * 1024);
          const decision = await transfer.preflight({
            sessionId: typeof body.sessionId === 'string' ? body.sessionId : undefined,
            eventCount: typeof body.eventCount === 'number' ? body.eventCount : undefined,
            conversationCount: typeof body.conversationCount === 'number' ? body.conversationCount : undefined,
            createdAt: typeof body.createdAt === 'number' ? body.createdAt : undefined,
            formatVersion: typeof body.formatVersion === 'number' ? body.formatVersion : undefined,
            sourceRoot: typeof body.sourceRoot === 'string' ? body.sourceRoot : undefined,
            targetDir: typeof body.targetDir === 'string' ? body.targetDir : undefined,
            merge: body.merge === true,
            tail: body.tail,
          });
          // A refusal is a successful decision exchange, not an HTTP failure:
          // the caller needs the code and message to explain it.
          sendJson(res, 200, { ok: true, result: decision });
          return;
        }
        case `${PEER_PREFIX}/import`: {
          const targetDir = url.searchParams.get('targetDir') ?? undefined;
          const merge = url.searchParams.get('merge') === '1';
          const forkId = url.searchParams.get('forkId') === '1';
          const update = url.searchParams.get('update') === '1';
          const result = await transfer.importSession({
            body: requestBody(req),
            targetDir,
            merge,
            forkId,
            update,
          });
          // An early "already exists" answer may leave the upload unfinished;
          // drain it so the sender sees the response instead of a reset.
          if (result.status === 'exists') req.resume();
          sendJson(res, 200, { ok: true, ...result });
          return;
        }
        default:
          throw new HttpError(404, 'not-found', `Unknown dsh-ferry endpoint ${path}`);
      }
    } catch (error) {
      req.resume();
      log(`dsh-ferry: peer ${peerId} ${path} failed: ${error instanceof Error ? error.message : String(error)}`);
      sendError(res, error);
    }
  };
}

/**
 * Accept only the three git modes from a wire request.
 * @param {unknown} value - requested mode.
 * @returns {'auto'|'include'|'skip'|undefined} validated mode.
 */
function validGit(value) {
  return value === 'auto' || value === 'include' || value === 'skip' ? value : undefined;
}

/**
 * Accept only the three transfer modes from the page.
 * @param {unknown} value - requested mode.
 * @returns {'auto'|'new'|'update'} validated mode.
 */
function validMode(value) {
  return value === 'new' || value === 'update' ? value : 'auto';
}

/**
 * Build the browser RPC handler.
 * @param {object} options - wiring.
 * @param {object} options.ferry - ferry API.
 * @param {object} options.transfer - transfer engine.
 * @param {object} options.config - normalized config.
 * @param {(message: string) => void} [options.log] - logger.
 * @returns {(request: Request) => Promise<Response>} handler.
 */
export function createBrowserHandler({ ferry, transfer, settings, config, log = () => {} }) {
  return async (request) => {
    let body;
    try {
      body = await readFetchJson(request);
    } catch (error) {
      return failure(error);
    }
    const action = typeof body.action === 'string' ? body.action : '';
    try {
      switch (action) {
        case 'status': {
          const status = await ferry.status();
          return jsonResponse(200, {
            ok: true,
            ...status,
            limits: {
              maxWorkspaceBytes: config.workspace.maxWorkspaceBytes,
              maxFileBytes: config.workspace.maxFileBytes,
              git: config.workspace.git,
            },
          });
        }
        case 'sessions': {
          const listed = await transfer.listLocalSessions({ all: body.all === true });
          return jsonResponse(200, { ok: true, sessions: listed.sessions });
        }
        case 'settings': {
          if (settings === undefined) throw new HttpError(503, 'settings-unavailable', 'Settings are unavailable');
          return jsonResponse(200, { ok: true, settings: await settings.read() });
        }
        case 'saveSettings': {
          if (settings === undefined) throw new HttpError(503, 'settings-unavailable', 'Settings are unavailable');
          const applied = await settings.save({
            peers: body.peers,
            incomingRoot: body.incomingRoot,
            token: typeof body.token === 'string' ? body.token : undefined,
          });
          return jsonResponse(200, { ok: true, settings: applied });
        }
        case 'remoteSessions': {
          return jsonResponse(200, { ok: true, ...(await ferry.remoteSessions(requireString(body.peerId, 'peerId'))) });
        }
        case 'describe': {
          return jsonResponse(
            200,
            { ok: true, ...(await ferry.remoteDescribe(requireString(body.peerId, 'peerId'), requireString(body.sessionId, 'sessionId'), { git: validGit(body.git) })) },
          );
        }
        case 'pushPlan': {
          return jsonResponse(200, { ok: true, ...(await ferry.pushPlan({ sessionId: requireString(body.sessionId, 'sessionId') })) });
        }
        case 'pullPlan': {
          return jsonResponse(
            200,
            {
              ok: true,
              ...(await ferry.pullPlan({
                peerId: requireString(body.peerId, 'peerId'),
                sessionId: requireString(body.sessionId, 'sessionId'),
                targetDir: optionalString(body.targetDir),
              })),
            },
          );
        }
        case 'push': {
          const result = await ferry.push({
            peerId: requireString(body.peerId, 'peerId'),
            sessionId: requireString(body.sessionId, 'sessionId'),
            mode: validMode(body.mode),
            targetDir: optionalString(body.targetDir),
            merge: body.merge === true,
            git: validGit(body.git),
            forkId: body.forkId === true,
            archiveSource: body.archiveSource === true,
            withWorkspace: body.withWorkspace !== false,
          });
          return jsonResponse(200, { ok: true, ...result });
        }
        case 'pull': {
          const result = await ferry.pull({
            peerId: requireString(body.peerId, 'peerId'),
            sessionId: requireString(body.sessionId, 'sessionId'),
            mode: validMode(body.mode),
            targetDir: optionalString(body.targetDir),
            merge: body.merge === true,
            git: validGit(body.git),
            forkId: body.forkId === true,
          });
          return jsonResponse(200, { ok: true, ...result });
        }
        default:
          return failure(new HttpError(400, 'unknown-action', `Unknown action ${JSON.stringify(action)}`));
      }
    } catch (error) {
      log(`dsh-ferry: browser ${action} failed: ${error instanceof Error ? error.message : String(error)}`);
      return failure(error);
    }
  };
}

/**
 * @param {unknown} value - candidate.
 * @param {string} name - field name.
 * @returns {string} non-empty string.
 */
function requireString(value, name) {
  if (typeof value !== 'string' || value === '') throw new HttpError(400, 'bad-request', `${name} is required`);
  return value;
}

/**
 * @param {unknown} value - candidate.
 * @returns {string | undefined} trimmed string or undefined.
 */
function optionalString(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

/**
 * Build a JSON failure response.
 * @param {unknown} error - thrown value.
 * @returns {Response} response.
 */
function failure(error) {
  const status = error instanceof HttpError ? error.status : 500;
  const code = error instanceof HttpError ? error.code : 'internal';
  return jsonResponse(status, {
    ok: false,
    error: { code, message: error instanceof Error ? error.message : String(error) },
  });
}
