/**
 * Agent tools: the same operations the settings page exposes, callable by the
 * model so a transfer can be part of a larger task ("finish this on the
 * workstation"). Each tool returns canonical JSON and renders a readable text
 * block.
 * @module dsh-ferry/lib/tools
 */

/** Loose object schema reused by result shapes. */
const JSON_OBJECT = { type: 'object', additionalProperties: true };
const JSON_ARRAY = { type: 'array', items: JSON_OBJECT };

/**
 * Drop properties and array holes that JSON cannot carry, so the canonical
 * value passes the registry's lossless-JSON check.
 * @param {unknown} value - tool value.
 * @returns {unknown} JSON-safe copy.
 */
function jsonSafe(value) {
  return JSON.parse(JSON.stringify(value));
}

/**
 * Render one tool result as pretty JSON.
 * @param {unknown} value - canonical value.
 * @returns {Array<{ type: 'text', text: string }>} content blocks.
 */
function render(value) {
  return [{ type: 'text', text: JSON.stringify(value, null, 2) }];
}

/**
 * Describe the portable subset of one peer status row.
 * @param {object} row - peer status.
 * @returns {object} JSON-safe row.
 */
function peerRow(row) {
  return {
    id: row.id,
    name: row.name,
    url: row.url,
    online: row.online === true,
    latencyMs: row.latencyMs,
    ...(row.error === undefined ? {} : { error: row.error }),
    ...(row.instance === undefined ? {} : { instance: row.instance }),
  };
}

/**
 * Register every ferry tool on the plugin fiber.
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 * @param {object} api - ferry + transfer operations.
 * @returns {void}
 */
export function registerTools(ctx, { ferry, transfer }) {
  const register = (definition) => {
    ctx.effect(() => ctx.tools.register(definition));
  };

  register({
    name: 'ferry_peers',
    description:
      'List the DSH instances this instance can ferry Sessions to, with a live reachability check for each. Use it before pushing or pulling to find a connected peer id.',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          self: JSON_OBJECT,
          peers: JSON_ARRAY,
        },
        required: ['ok', 'self', 'peers'],
      },
      render: (_args, value) => render(value),
    },
    async execute() {
      const status = await ferry.status();
      return jsonSafe({
        ok: true,
        self: status.self,
        peers: status.peers.map(peerRow),
      });
    },
  });

  register({
    name: 'ferry_sessions',
    description:
      'List this instance\'s Sessions as transfer candidates. A Session that is running cannot be pushed until its turn stops.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        all: {
          type: 'boolean',
          description: 'Include subagent sessions as well as user-visible ones.',
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { ok: { type: 'boolean' }, sessions: JSON_ARRAY },
        required: ['ok', 'sessions'],
      },
      render: (_args, value) => render(value),
    },
    async execute(args) {
      const listed = await transfer.listLocalSessions({ all: args.all === true });
      return jsonSafe({ ok: true, sessions: listed.sessions });
    },
  });

  register({
    name: 'ferry_remote_sessions',
    description:
      'List the Sessions available on one connected peer, newest first. Use the returned sessionId with ferry_pull.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        peer: { type: 'string', description: 'Peer id from ferry_peers.' },
      },
      required: ['peer'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { ok: { type: 'boolean' }, sessions: JSON_ARRAY },
        required: ['ok', 'sessions'],
      },
      render: (_args, value) => render(value),
    },
    async execute(args, exec) {
      const body = await ferry.remoteSessions(args.peer, exec.signal);
      return jsonSafe({ ok: true, sessions: body.sessions ?? [] });
    },
  });

  register({
    name: 'ferry_push',
    description:
      'Push one local Session, together with the workspace files it needs, to a connected peer. The peer can then resume the Session. The Session must be idle. Dependency trees, build output, caches, credentials, and oversize files are not transferred; the result reports what stayed behind. Writing into an existing non-empty directory requires merge.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        peer: { type: 'string', description: 'Peer id from ferry_peers.' },
        session: { type: 'string', description: 'Local session id from ferry_sessions.' },
        targetDir: {
          type: 'string',
          description: 'Absolute working directory on the peer. Omit to keep the same path.',
        },
        merge: {
          type: 'boolean',
          description: 'Write into a non-empty target directory, overwriting differing files after backing them up.',
        },
        git: {
          type: 'string',
          enum: ['auto', 'include', 'skip'],
          description: 'Git history handling: auto copies .git within the size cap, include always tries, skip never does.',
        },
        forkId: {
          type: 'boolean',
          description: 'Import under a fresh session id instead of the original id.',
        },
        archiveSource: {
          type: 'boolean',
          description: 'Archive the local Session after a successful push so it no longer appears as current work.',
        },
        withWorkspace: {
          type: 'boolean',
          description: 'Transfer workspace files. Defaults to true; false transfers only the Session log and attachments.',
        },
      },
      required: ['peer', 'session'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          ok: { type: 'boolean' },
          status: { type: 'string' },
          sessionId: { type: 'string' },
          targetDir: { type: 'string' },
          warnings: JSON_ARRAY,
        },
        required: ['ok'],
      },
      render: (_args, value) => render(value),
    },
    async execute(args, exec) {
      const result = await ferry.push({
        peerId: args.peer,
        sessionId: args.session,
        targetDir: args.targetDir,
        merge: args.merge === true,
        git: args.git,
        forkId: args.forkId === true,
        archiveSource: args.archiveSource === true,
        withWorkspace: args.withWorkspace !== false,
        signal: exec.signal,
      });
      return jsonSafe({ ok: true, ...result });
    },
  });

  register({
    name: 'ferry_pull',
    description:
      'Pull one Session, together with the workspace files it needs, from a connected peer into this instance. The peer Session stays in place. Writing into an existing non-empty directory requires merge; a session id that already exists locally requires forkId.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        peer: { type: 'string', description: 'Peer id from ferry_peers.' },
        session: { type: 'string', description: 'Remote session id from ferry_remote_sessions.' },
        targetDir: {
          type: 'string',
          description: 'Absolute working directory on this instance. Omit to reuse the remote path.',
        },
        merge: {
          type: 'boolean',
          description: 'Write into a non-empty target directory, overwriting differing files after backing them up.',
        },
        git: {
          type: 'string',
          enum: ['auto', 'include', 'skip'],
          description: 'Git history handling: auto copies .git within the size cap, include always tries, skip never does.',
        },
        forkId: {
          type: 'boolean',
          description: 'Import under a fresh session id instead of the original id.',
        },
      },
      required: ['peer', 'session'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          ok: { type: 'boolean' },
          status: { type: 'string' },
          sessionId: { type: 'string' },
          targetDir: { type: 'string' },
          warnings: JSON_ARRAY,
        },
        required: ['ok'],
      },
      render: (_args, value) => render(value),
    },
    async execute(args, exec) {
      const result = await ferry.pull({
        peerId: args.peer,
        sessionId: args.session,
        targetDir: args.targetDir,
        merge: args.merge === true,
        git: args.git,
        forkId: args.forkId === true,
        signal: exec.signal,
      });
      return jsonSafe({ ok: true, ...result });
    },
  });
}
