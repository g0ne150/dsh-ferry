/**
 * dsh-ferry Host half.
 *
 * One plugin row composes:
 * - the peer channel on the web listener (`/dsh-ferry/v1/*`),
 * - the browser channel on the Connection API (`/api/dsh-ferry/rpc`),
 * - five agent tools over the same operations.
 *
 * Peers and transfer scope are configuration, not code: see README.md.
 * @module dsh-ferry
 */
import { normalizeConfig } from './lib/config.js';
import { createFerry } from './lib/ferry.js';
import { createBrowserHandler, createPeerHandler } from './lib/routes.js';
import { createSettings } from './lib/settings.js';
import { registerTools } from './lib/tools.js';
import { createTransfer } from './lib/transfer.js';

/** Plugin name, mirrored by the bundle patch row. */
export const name = 'dsh-ferry';

/** Services the plugin cannot work without. */
export const inject = ['tools', 'sessionPersistence', 'workspaceRegistry', 'attachments'];

/**
 * Activate the Host plugin.
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 * @param {unknown} config - loader row config, validated here.
 */
export function apply(ctx, config) {
  const normalized = normalizeConfig(config);
  const debug = process.env.DSH_FERRY_DEBUG === '1';
  const log = debug ? (message) => console.error(message) : () => {};

  const transfer = createTransfer({ ctx, config: normalized, rules: normalized.workspace, log });
  const ferry = createFerry({ ctx, config: normalized, transfer, log });
  const settings = createSettings({ ctx, config: normalized });

  registerTools(ctx, { ferry, transfer });

  const peerHandler = createPeerHandler({ config: normalized, ferry, transfer, log });
  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(() =>
      webCtx.webServer.register({
        kind: 'prefix',
        path: '/dsh-ferry',
        handler: peerHandler,
      }),
    );
  });

  // Queued updates from an earlier push are applied on this start, before a
  // browser can resume the sessions they target.
  void transfer.applyPending().catch((error) => {
    log(`dsh-ferry: applying queued updates failed: ${error instanceof Error ? error.message : String(error)}`);
  });

  const browserHandler = createBrowserHandler({ ferry, transfer, settings, config: normalized, log });
  ctx.inject(['connection'], (connCtx) => {
    const registry = connCtx.connection?.fetch;
    if (registry === undefined || typeof registry.register !== 'function') {
      // Headless compositions have no browser Connection service; tools remain usable.
      log('dsh-ferry: no browser Connection fetch registry; settings page stays inactive');
      return;
    }
    connCtx.effect(() =>
      registry.register({
        path: '/api/dsh-ferry/rpc',
        methods: ['POST'],
        requestBody: 'buffered',
        fetch: browserHandler,
      }),
    );
  });
}
