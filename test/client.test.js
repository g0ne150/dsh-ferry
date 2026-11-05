import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

/**
 * Load the browser half the way the Harness ModuleLoader does, without a DOM:
 * the factory only needs React symbols and a client context for `apply`.
 * @returns {{ plugin: { inject: string[], apply: Function }, dictionaries: Map<string, object>, registrations: Array<object> }}
 */
function loadClientHalf() {
  const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8');
  const dictionaries = new Map();
  /** @type {any} */
  let plugin;
  const react = {
    createElement: () => null,
    useState: () => [undefined, () => {}],
    useEffect: () => {},
    useMemo: (factory) => factory(),
    useCallback: (callback) => callback,
    useRef: () => ({ current: null }),
  };
  const sandbox = {
    window: {
      __ModuleLoader__: {
        load({ id, factory }) {
          assert.equal(id, 'dsh-ferry');
          plugin = factory((name) => {
            assert.equal(name, 'react', 'the client half may only import react');
            return react;
          });
        },
      },
    },
  };
  const run = new Function('window', source);
  run(sandbox.window);
  const registrations = [];
  const ctx = {
    effect(execute) {
      const dispose = execute();
      return typeof dispose === 'function' ? dispose : () => {};
    },
    locale: {
      register(namespace, dicts) {
        dictionaries.set(namespace, dicts);
        return () => {};
      },
      bind(namespace) {
        return (key) => {
          const dicts = dictionaries.get(namespace);
          return dicts?.en?.[key] ?? key;
        };
      },
    },
    layout: { selectPanel: () => {} },
    slots: {
      inject(slot, callback) {
        callback();
        return () => {};
      },
      register(options, Component) {
        registrations.push({ options, Component });
        return () => {};
      },
    },
  };
  plugin.apply(ctx);
  return { plugin, dictionaries, registrations };
}

test('the client half registers the sidebar panel, its page, the menu item and the toast host', () => {
  const { plugin, dictionaries, registrations } = loadClientHalf();
  assert.deepEqual(plugin.inject, ['slots', 'locale', 'layout']);
  const byKey = new Map(
    registrations.map(({ options, Component }) => [
      `${options.name}:${options.id ?? options.key}`,
      { options, Component },
    ]),
  );

  const panel = byKey.get('sidebar.panellist:dsh-ferry');
  assert.ok(panel, 'sidebar.panellist must be registered');
  assert.equal(panel.options.id, 'dsh-ferry');
  assert.equal(panel.options.locale, 'dshFerry');
  assert.equal(panel.options.label(), 'dsh-ferry');
  assert.equal(typeof panel.Component, 'function');

  const main = byKey.get('main:dsh-ferry');
  assert.ok(main, 'main must be registered');
  assert.equal(main.options.key, 'dsh-ferry', 'the main panel key must match the panel id');
  assert.equal(typeof main.Component, 'function');

  const menu = byKey.get('sidebar.workspaces.session.menu.item:dsh-ferry-push');
  assert.ok(menu, 'the session menu item must be registered');
  assert.equal(menu.options.id, 'dsh-ferry-push');
  assert.equal(menu.options.order, 500);
  assert.equal(typeof menu.options.inject, 'function');
  assert.equal(typeof menu.options.inject().openPanel, 'function');

  const toast = byKey.get('shell.overlay:dsh-ferry-toast');
  assert.ok(toast, 'the toast host must be registered');

  const dialog = byKey.get('shell.overlay:dsh-ferry-push-dialog');
  assert.ok(dialog, 'the push dialog must be registered in the overlay');
  assert.equal(dialog.options.order, 90);
  assert.equal(typeof dialog.Component, 'function');
  assert.equal(
    registrations.filter(({ options }) => options.name === 'shell.overlay').length,
    2,
    'the overlay hosts both the push dialog and the toast',
  );
  assert.equal(
    registrations.some(({ options }) => options.name === 'settings.section'),
    false,
    'the settings section was replaced by the sidebar panel',
  );

  const dicts = dictionaries.get('dshFerry');
  assert.ok(dicts.en && dicts.zh);
  const enKeys = Object.keys(dicts.en).sort();
  const zhKeys = Object.keys(dicts.zh).sort();
  assert.deepEqual(enKeys, zhKeys, 'both languages must carry the same keys');
  for (const key of enKeys) {
    assert.equal(typeof dicts.en[key], 'string', `en.${key} must be a string`);
    assert.equal(typeof dicts.zh[key], 'string', `zh.${key} must be a string`);
  }
  for (const key of [
    'title',
    'description',
    'pushTo',
    'noOnlinePeer',
    'addPeer',
    'save',
    'incomingRoot',
    'pullSection',
    'category_dependency',
    'code_gitSkippedTooLarge',
  ]) {
    assert.ok(enKeys.includes(key), `missing locale key ${key}`);
  }
});
