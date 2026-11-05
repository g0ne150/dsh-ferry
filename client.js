/**
 * dsh-ferry browser half.
 *
 * Three surfaces, one plugin:
 * - a sidebar panel (`dsh-ferry`) that manages peers and pulls sessions,
 * - a Session "..." menu entry that pushes to a connected peer,
 * - an overlay toast host for transfer results.
 *
 * Plain JavaScript and React.createElement only; data crosses the browser
 * Connection at `/api/dsh-ferry/rpc`.
 */
window.__ModuleLoader__.load({
  id: 'dsh-ferry',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useState, useEffect, useMemo, useCallback } = React;

    const CSS = `
.ferry-root{display:flex;flex-direction:column;gap:18px;font-size:14px;color:var(--dsw-alias-label-primary);padding:28px 32px 48px;max-width:940px;min-height:100%;overflow:auto;box-sizing:border-box}
.ferry-title{font-size:18px;font-weight:600;line-height:26px}
.ferry-desc{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;margin-top:4px;max-width:76ch}
.ferry-card{border:.5px solid var(--dsw-alias-border-l1);border-radius:10px;padding:16px 18px;background:var(--dsw-alias-bg-layer-1)}
.ferry-card-head{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.ferry-section-title{font-size:14px;font-weight:600;line-height:20px}
.ferry-meta{color:var(--dsw-alias-label-secondary);font-size:11px;line-height:16px}
.ferry-mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;word-break:break-all}
.ferry-spacer{flex:1 1 auto}
.ferry-btn{appearance:none;border:.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);border-radius:7px;padding:4px 11px;font-size:12px;line-height:18px;cursor:pointer;white-space:nowrap}
.ferry-btn:hover:not(:disabled){border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}
.ferry-btn.primary{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary);background:transparent}
.ferry-btn.danger{border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary)}
.ferry-btn:disabled{opacity:.45;cursor:default}
.ferry-input,.ferry-select{background:var(--dsw-alias-bg-layer-2);border:.5px solid var(--dsw-alias-border-l2);border-radius:6px;padding:4px 8px;color:var(--dsw-alias-label-primary);font-size:12px;line-height:18px;min-width:0;box-sizing:border-box}
.ferry-input.wide{width:100%}
.ferry-field{display:flex;align-items:center;gap:6px;font-size:12px;color:var(--dsw-alias-label-secondary)}
.ferry-peer{border-top:.5px solid var(--dsw-alias-border-l1);padding:12px 0;display:flex;flex-direction:column;gap:8px}
.ferry-peer:first-of-type{border-top:none;padding-top:4px}
.ferry-peer-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.ferry-dot{width:8px;height:8px;border-radius:50%;flex:none;display:inline-block}
.ferry-dot.on{background:var(--dsw-alias-state-success-primary)}
.ferry-dot.off{background:var(--dsw-alias-state-error-primary)}
.ferry-dot.idle{background:var(--dsw-alias-state-idle-primary)}
.ferry-list{max-height:340px;overflow:auto;margin-top:6px;border-top:.5px solid var(--dsw-alias-border-l1)}
.ferry-item{display:flex;gap:12px;align-items:center;padding:9px 0;border-bottom:.5px solid var(--dsw-alias-border-l1)}
.ferry-item-main{min-width:0;flex:1 1 auto}
.ferry-item-title{font-size:13px;line-height:18px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ferry-badge{display:inline-block;font-size:10px;line-height:16px;padding:0 6px;border-radius:999px;border:.5px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);margin-left:6px}
.ferry-badge.run{color:var(--dsw-alias-state-warn-primary);border-color:var(--dsw-alias-state-warn-primary)}
.ferry-notice{border-radius:8px;padding:9px 12px;font-size:12px;line-height:18px;border:.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);margin-top:10px}
.ferry-notice.success{border-color:var(--dsw-alias-state-success-primary)}
.ferry-notice.error{border-color:var(--dsw-alias-state-error-primary)}
.ferry-empty{padding:16px 0;color:var(--dsw-alias-label-secondary);font-size:12px;text-align:center}
.ferry-menu-item{display:flex;align-items:center;gap:8px;width:100%;padding:4px 7px;background:transparent;border:none;border-radius:var(--dsw-radius-md);color:inherit;font:inherit;font-size:calc(var(--dsh-content-font-size-secondary,13px) - 1px);line-height:20px;text-align:left;cursor:pointer;box-sizing:border-box}
.ferry-menu-item:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2)}
.ferry-menu-item:disabled{opacity:.45;cursor:default}
.ferry-flyout{position:fixed;z-index:80;min-width:170px;max-height:280px;overflow:auto;padding:5px;border:.5px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-overlay);box-shadow:0 10px 28px rgba(0,0,0,.28)}
.ferry-flyout-head{padding:5px 9px 4px;font-size:11px;color:var(--dsw-alias-label-secondary)}
.ferry-flyout-row{display:flex;align-items:center;gap:8px;width:100%;padding:6px 9px;border:none;border-radius:6px;background:transparent;color:inherit;font:inherit;font-size:13px;line-height:19px;text-align:left;cursor:pointer}
.ferry-flyout-row:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2)}
.ferry-flyout-row:disabled{opacity:.5;cursor:default}
.ferry-flyout-foot{border-top:.5px solid var(--dsw-alias-border-l1);margin-top:4px;padding:7px 9px 3px;display:flex;flex-direction:column;gap:6px}
.ferry-check{display:flex;align-items:center;gap:6px;font-size:11px;color:var(--dsw-alias-label-secondary);cursor:pointer}
.ferry-toasts{position:fixed;right:20px;bottom:20px;z-index:90;display:flex;flex-direction:column;gap:8px;max-width:380px;pointer-events:none}
.ferry-toast{pointer-events:auto;border:.5px solid var(--dsw-alias-border-l2);border-left-width:3px;border-radius:8px;background:var(--dsw-alias-bg-overlay);padding:10px 12px;font-size:12px;line-height:18px;box-shadow:0 8px 24px rgba(0,0,0,.24)}
.ferry-toast.success{border-left-color:var(--dsw-alias-state-success-primary)}
.ferry-toast.error{border-left-color:var(--dsw-alias-state-error-primary)}
.ferry-toast.info{border-left-color:var(--dsw-alias-brand-primary)}
.ferry-toast-title{font-weight:600;margin-bottom:2px}
`;

    const en = {
      title: 'dsh-ferry',
      description:
        'Push a Session (and the files it needs) to a connected DSH instance, or pull one back. Instances must be able to reach each other; configure peers below.',
      instances: 'Peers',
      thisInstance: 'This instance',
      noPeers: 'No peers yet. Add one with its DSH web URL and a shared token.',
      addPeer: 'Add peer',
      save: 'Save settings',
      saving: 'Saving…',
      saved: 'Settings saved',
      name: 'Name',
      url: 'URL',
      token: 'Token',
      urlNeeded: 'Enter the peer DSH web URL',
      tokenKeep: 'Token is set; leave blank to keep it',
      tokenNeeded: 'Enter a shared token',
      remove: 'Remove',
      refresh: 'Refresh status',
      checking: 'Checking…',
      online: 'online',
      offline: 'offline',
      latency: 'ms',
      incomingRoot: 'Incoming workspace directory',
      incomingRootHint:
        'When a received workspace has no directory on this machine, it lands here, in a subdirectory named after the source workspace and session.',
      peersHint: 'Both instances must share the same token. The token never leaves this machine.',
      pullSection: 'Pull a session',
      pullHint: 'Choose a peer, load its sessions, then pull one here.',
      loadRemote: 'Load sessions',
      noSessions: 'No matching sessions',
      unnamed: 'Untitled session',
      running: 'running',
      targetDir: 'Target directory',
      targetDirHint: 'Leave blank to map automatically: same path when it exists here, else the incoming directory.',
      merge: 'Merge into an existing directory',
      mergeHint: 'Overwrites differing files after backing them up.',
      pull: 'Pull',
      pulling: 'Pulling…',
      push: 'Push',
      pushing: 'Pushing…',
      pushTo: 'Push to…',
      noOnlinePeer: 'No peer is connected right now',
      managePeers: 'Manage peers…',
      mergeInMenu: 'Merge into an existing directory (backs up)',
      files: 'files',
      overwritten: 'overwritten',
      skippedTitle: 'Left behind',
      warningsTitle: 'Notes',
      dismiss: 'Dismiss',
      success: 'Done',
      failed: 'Failed',
      alreadyThere: 'Already present with the same content; nothing was overwritten.',
      resultTarget: 'Target',
      settingsUnavailable: 'This profile has no config editor; edit cordis.patch.yml instead.',
      noPeerSelected: 'Choose a peer first.',
      category_dependency: 'dependencies',
      category_build: 'build output',
      category_cache: 'caches',
      category_editor: 'editor state',
      category_ignored: 'gitignored',
      category_secret: 'credentials',
      category_large: 'oversize files',
      category_symlink: 'external symlinks',
      category_special: 'special files',
      category_git: 'git history',
      'category_user-exclude': 'excluded by config',
      category_internal: 'transfer staging',
      code_gitSkippedTooLarge: 'Git history was larger than the transfer cap and stayed behind; clone it on the target if needed.',
      code_gitSkippedWorktree: 'This workspace uses a git worktree; the .git pointer was not transferred.',
      code_gitConfigMayHoldCredentials: 'The copied .git/config may embed remote credentials.',
      code_childSessionsStayBehind: 'Subagent sessions stay on this instance.',
      code_parentLineageDangling: 'The parent session is not on the target instance.',
      code_attachmentsIncomplete: 'Some attachments could not be read and stay referenced but missing.',
      code_attachmentUnreadable: 'One attachment could not be read.',
      code_attachmentBudgetExceeded: 'Attachment bytes exceeded the transfer budget.',
      code_attachmentWriteFailed: 'One attachment could not be stored on the target.',
      code_agentPresetMissing: 'The session uses an agent preset this instance does not have.',
      code_workspaceAttachFailed: 'The workspace was materialized but the session was not attached to it.',
      code_sourceArchiveFailed: 'The transfer succeeded but the source session could not be archived.',
      code_workspaceOverLimit: 'The workspace exceeded the configured size limit.',
      code_directoryUnreadable: 'A directory could not be read.',
      code_entryUnreadable: 'A file could not be read.',
      code_targetHasGit: 'The target already had a .git directory; its history was kept.',
      code_target_not_empty: 'The target directory already exists and is not empty; enable merge to write into it.',
      code_session_conflict: 'The target already has this session with different content; pull it under a new session id instead.',
      code_unreachable: 'The peer is unreachable. Check that its DSH web server listens on an address this machine can reach.',
      code_unauthorized: 'The peer rejected the token. Both sides must share the same token.',
      code_unauthenticated: 'The peer rejected the request signature. Both sides must share the same token.',
      code_replayed: 'The peer rejected a replayed request; check the clocks on both machines.',
    };

    const zh = {
      title: 'dsh-ferry',
      description:
        '把会话以及它需要的工作区文件推送到另一个可达的 DSH 实例，或从对端拉取。实例之间必须网络可达；在下方配置对端。',
      instances: '实例',
      thisInstance: '本实例',
      noPeers: '还没有对端。填写对端的 DSH Web 地址和共享令牌即可添加。',
      addPeer: '添加实例',
      save: '保存配置',
      saving: '保存中…',
      saved: '配置已保存',
      name: '名称',
      url: '地址',
      token: '令牌',
      urlNeeded: '请填写对端的 DSH Web 地址',
      tokenKeep: '已设置令牌，留空保持不变',
      tokenNeeded: '请填写共享令牌',
      remove: '删除',
      refresh: '刷新状态',
      checking: '检查中…',
      online: '在线',
      offline: '离线',
      latency: '毫秒',
      incomingRoot: '工作区接收目录',
      incomingRootHint: '收到的会话如果没有本机映射目录，会放到这里，并以“源工作区名-会话 ID”建立子目录。',
      peersHint: '两端必须使用同一个令牌。令牌不会离开本机。',
      pullSection: '拉取会话',
      pullHint: '选择对端，加载它的会话列表，然后拉取到本机。',
      loadRemote: '加载会话',
      noSessions: '没有匹配的会话',
      unnamed: '未命名会话',
      running: '运行中',
      targetDir: '目标目录',
      targetDirHint: '留空则自动映射：本机存在同路径就用它，否则放到接收目录。',
      merge: '合并到已有目录',
      mergeHint: '覆盖同名文件前会先备份。',
      pull: '拉取',
      pulling: '拉取中…',
      push: '推送',
      pushing: '推送中…',
      pushTo: '推送到…',
      noOnlinePeer: '当前没有已连接的对端',
      managePeers: '管理实例…',
      mergeInMenu: '合并已有目录（自动备份）',
      files: '文件',
      overwritten: '覆盖',
      skippedTitle: '未传输',
      warningsTitle: '提示',
      dismiss: '知道了',
      success: '完成',
      failed: '失败',
      alreadyThere: '目标已有内容相同的会话，没有覆盖任何内容。',
      resultTarget: '目标',
      settingsUnavailable: '当前 profile 没有配置编辑器，请直接编辑 cordis.patch.yml。',
      noPeerSelected: '请先选择一个对端。',
      category_dependency: '依赖目录',
      category_build: '构建产物',
      category_cache: '缓存',
      category_editor: '编辑器状态',
      category_ignored: '被忽略文件',
      category_secret: '凭据',
      category_large: '超大文件',
      category_symlink: '外部符号链接',
      category_special: '特殊文件',
      category_git: 'Git 历史',
      'category_user-exclude': '配置排除',
      category_internal: '传输暂存',
      code_gitSkippedTooLarge: 'Git 历史超过上限，未传输；需要时在目标机 clone。',
      code_gitSkippedWorktree: '该工作区使用 git worktree，未传输 .git 指针。',
      code_gitConfigMayHoldCredentials: '复制过去的 .git/config 可能包含远端凭据。',
      code_childSessionsStayBehind: '子会话仍留在本实例。',
      code_parentLineageDangling: '父会话不在目标实例上。',
      code_attachmentsIncomplete: '部分附件无法读取，会话仍引用但目标缺失。',
      code_attachmentUnreadable: '有一个附件无法读取。',
      code_attachmentBudgetExceeded: '附件总量超过传输预算。',
      code_attachmentWriteFailed: '有一个附件无法写入目标。',
      code_agentPresetMissing: '该会话使用的 agent preset 在目标实例上不存在。',
      code_workspaceAttachFailed: '工作区已写入，但会话没有挂到该工作区。',
      code_sourceArchiveFailed: '传输成功，但源会话归档失败。',
      code_workspaceOverLimit: '工作区超过配置的大小上限。',
      code_directoryUnreadable: '有一个目录无法读取。',
      code_entryUnreadable: '有一个文件无法读取。',
      code_targetHasGit: '目标已有 .git，保留了目标的历史。',
      code_target_not_empty: '目标目录已存在且非空；需要勾选合并才能写入。',
      code_session_conflict: '目标已有同 ID 但内容不同的会话；请改用新会话 ID 拉取。',
      code_unreachable: '对端不可达。检查它的 DSH Web 是否监听本机可达的地址。',
      code_unauthorized: '对端拒绝了令牌。两端必须使用同一个令牌。',
      code_unauthenticated: '对端拒绝了请求签名。两端必须使用同一个令牌。',
      code_replayed: '对端拒绝了重放请求；检查两端的时钟。',
    };

    /** Module-scoped toast bus shared by the panel, the menu item and the overlay. */
    const toasts = (() => {
      let items = [];
      let next = 1;
      const listeners = new Set();
      const emit = () => {
        for (const listener of listeners) listener();
      };
      const bus = {
        push({ tone = 'info', title, text, durationMs = 9000 }) {
          const id = next++;
          items = [...items, { id, tone, title, text }];
          emit();
          if (durationMs > 0) setTimeout(() => bus.dismiss(id), durationMs);
          return id;
        },
        dismiss(id) {
          items = items.filter((item) => item.id !== id);
          emit();
        },
        subscribe(listener) {
          listeners.add(listener);
          return () => {
            listeners.delete(listener);
          };
        },
        snapshot() {
          return items;
        },
      };
      return bus;
    })();

    async function rpc(body) {
      let response;
      try {
        response = await fetch('/api/dsh-ferry/rpc', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
      } catch (error) {
        throw new Error(String(error));
      }
      let payload;
      try {
        payload = await response.json();
      } catch {
        throw new Error(`HTTP ${response.status}`);
      }
      if (!response.ok || payload?.ok === false) {
        const failure = payload?.error;
        const error = new Error(failure?.message ?? `HTTP ${response.status}`);
        error.code = failure?.code;
        throw error;
      }
      return payload;
    }

    function formatBytes(bytes) {
      if (typeof bytes !== 'number' || !Number.isFinite(bytes)) return '';
      if (bytes < 1024) return `${bytes} B`;
      if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
      return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
    }

    function formatTime(ts) {
      if (typeof ts !== 'number') return '';
      try {
        return new Date(ts).toLocaleString();
      } catch {
        return '';
      }
    }

    function codeText(code, t) {
      const key = `code_${String(code).replace(/-/g, '_')}`;
      const text = t(key);
      return text === key ? String(code) : text;
    }

    function transferSummary(result, t) {
      const pieces = [];
      if (result?.targetDir) pieces.push(`${t('resultTarget')}: ${result.targetDir}`);
      if (result?.workspace) {
        const parts = [
          `${t('files')} ${result.workspace.written ?? result.workspace.files ?? 0}`,
          formatBytes(result.workspace.bytes ?? 0),
        ];
        if (result.workspace.overwritten) parts.push(`${t('overwritten')} ${result.workspace.overwritten}`);
        pieces.push(parts.join(' · '));
      }
      const skipped = result?.transfer?.workspace?.skipped ?? result?.workspace?.skipped ?? [];
      if (skipped.length > 0) {
        pieces.push(
          `${t('skippedTitle')}: ${skipped.map((item) => `${t(`category_${item.category}`)} ${item.count}`).join(' · ')}`,
        );
      }
      return pieces.join('\n');
    }

    function noticeFor(result, t) {
      if (result?.status === 'exists') return { tone: 'success', text: t('alreadyThere') };
      const text = transferSummary(result, t);
      return { tone: 'success', text: text === '' ? t('success') : text };
    }

    function layoutError(error, t) {
      const code = error?.code;
      if (typeof code === 'string') {
        const key = `code_${code.replace(/-/g, '_')}`;
        if (t(key) !== key) return t(key);
      }
      return error?.message ?? String(error);
    }

    function WarningList({ warnings, t }) {
      if (!Array.isArray(warnings) || warnings.length === 0) return null;
      return h(
        'ul',
        { style: { margin: '6px 0 0', paddingLeft: '16px', color: 'var(--dsw-alias-label-secondary)', fontSize: '11px' } },
        warnings.slice(0, 8).map((warning, index) =>
          h('li', { key: `${warning.code ?? 'warning'}-${index}` }, codeText(warning.code ?? warning, t)),
        ),
      );
    }

    /* ---------- shared icon ---------- */

    function PeerIcon({ size = 18, active = false }) {
      const color = active ? 'var(--dsw-alias-brand-primary)' : 'currentColor';
      return h(
        'svg',
        { width: size, height: size, viewBox: '0 0 24 24', 'aria-hidden': true, style: { display: 'block' } },
        h('circle', { cx: 5, cy: 13, r: 2.4, fill: color }),
        h('circle', { cx: 19, cy: 13, r: 2.4, fill: color }),
        h('path', {
          d: 'M7.4 13h9.2',
          stroke: color,
          strokeWidth: 1.6,
          strokeLinecap: 'round',
          strokeDasharray: '1.5 3',
        }),
        h('path', {
          d: 'M12 4.5v4.2M9.8 6.7 12 4.5l2.2 2.2',
          fill: 'none',
          stroke: color,
          strokeWidth: 1.6,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        }),
        h('path', { d: 'M8 18.5h8l-1.4 2.2H9.4z', fill: color, opacity: 0.7 }),
      );
    }

    /* ---------- sidebar panel: peers, incoming root, pull ---------- */

    function FerryPage(props) {
      const t = props.t;
      const [settings, setSettings] = useState(null);
      const [draftPeers, setDraftPeers] = useState([]);
      const [incomingRoot, setIncomingRoot] = useState('');
      const [status, setStatus] = useState(null);
      const [statusError, setStatusError] = useState(null);
      const [checking, setChecking] = useState(false);
      const [saving, setSaving] = useState(false);
      const [notice, setNotice] = useState(null);
      const [pullPeer, setPullPeer] = useState('');
      const [remote, setRemote] = useState({ peer: null, loading: false, sessions: [], error: null });
      const [pullTarget, setPullTarget] = useState('');
      const [pullMerge, setPullMerge] = useState(false);
      const [pullBusy, setPullBusy] = useState(null);

      const applySettings = useCallback((next) => {
        setSettings(next);
        setDraftPeers(
          (next?.peers ?? []).map((peer) => ({
            id: peer.id,
            name: peer.name ?? '',
            url: peer.url ?? '',
            token: '',
            tokenSet: peer.tokenSet === true,
          })),
        );
        setIncomingRoot(next?.incomingRoot ?? '');
        if (next?.peers?.length > 0) setPullPeer((current) => (current === '' ? next.peers[0].id : current));
      }, []);

      const loadSettings = useCallback(async () => {
        try {
          const payload = await rpc({ action: 'settings' });
          applySettings(payload.settings);
        } catch (error) {
          setNotice({ tone: 'error', text: error.message });
        }
      }, [applySettings]);

      const loadStatus = useCallback(async () => {
        setChecking(true);
        try {
          const payload = await rpc({ action: 'status' });
          setStatus(payload);
          setStatusError(null);
        } catch (error) {
          setStatusError(error.message);
        } finally {
          setChecking(false);
        }
      }, []);

      useEffect(() => {
        loadSettings();
        loadStatus();
      }, [loadSettings, loadStatus]);

      const statusById = useMemo(() => {
        const map = new Map();
        for (const peer of status?.peers ?? []) map.set(peer.id, peer);
        return map;
      }, [status]);

      const peerState = (peer) => {
        const live = statusById.get(peer.id);
        if (live === undefined) return { dot: 'idle', text: '' };
        if (live.online === true) {
          return {
            dot: 'on',
            text: `${t('online')}${typeof live.latencyMs === 'number' ? ` · ${live.latencyMs}${t('latency')}` : ''}`,
          };
        }
        return { dot: 'off', text: `${t('offline')}: ${codeText(live.error?.code ?? 'unreachable', t)}` };
      };

      const updatePeer = (index, patch) => {
        setDraftPeers((current) => current.map((peer, position) => (position === index ? { ...peer, ...patch } : peer)));
      };

      const addPeer = () => {
        const suffix = Math.random().toString(36).slice(2, 8);
        setDraftPeers((current) => [
          ...current,
          { id: `peer-${suffix}`, name: '', url: '', token: '', tokenSet: false },
        ]);
      };

      const save = async () => {
        setSaving(true);
        setNotice(null);
        try {
          for (const peer of draftPeers) {
            if (peer.url.trim() === '') throw new Error(t('urlNeeded'));
            if (!peer.tokenSet && peer.token.trim() === '') throw new Error(t('tokenNeeded'));
          }
          const payload = await rpc({
            action: 'saveSettings',
            incomingRoot,
            peers: draftPeers.map((peer) => ({
              id: peer.id,
              name: peer.name.trim() === '' ? peer.id : peer.name.trim(),
              url: peer.url.trim(),
              ...(peer.token.trim() === '' ? {} : { token: peer.token.trim() }),
            })),
          });
          applySettings(payload.settings);
          setNotice({ tone: 'success', text: t('saved') });
          // The host row reloads after the write; give it a moment before the
          // next RPC so the new registration is in place.
          setTimeout(() => loadStatus(), 400);
        } catch (error) {
          setNotice({ tone: 'error', text: `${t('failed')}: ${error.message}` });
        } finally {
          setSaving(false);
        }
      };

      const loadRemote = async () => {
        if (pullPeer === '') {
          setNotice({ tone: 'error', text: t('noPeerSelected') });
          return;
        }
        setRemote({ peer: pullPeer, loading: true, sessions: [], error: null });
        try {
          const payload = await rpc({ action: 'remoteSessions', peerId: pullPeer });
          setRemote({ peer: pullPeer, loading: false, sessions: payload.sessions ?? [], error: null });
        } catch (error) {
          setRemote({ peer: pullPeer, loading: false, sessions: [], error: error.message });
        }
      };

      const pull = async (session) => {
        setPullBusy(session.sessionId);
        try {
          const payload = await rpc({
            action: 'pull',
            peerId: pullPeer,
            sessionId: session.sessionId,
            ...(pullTarget.trim() === '' ? {} : { targetDir: pullTarget.trim() }),
            merge: pullMerge,
          });
          const summary = noticeFor(payload, t);
          setNotice({ tone: 'success', text: summary.text, warnings: payload.warnings });
          toasts.push({ tone: 'success', title: `${t('success')} · ${t('pull')}`, text: summary.text });
        } catch (error) {
          const text = `${t('failed')}: ${layoutError(error, t)}`;
          setNotice({ tone: 'error', text });
          toasts.push({ tone: 'error', title: t('failed'), text: layoutError(error, t) });
        } finally {
          setPullBusy(null);
        }
      };

      if (settings === null) {
        return h('div', { className: 'ferry-root' }, h('style', null, CSS), h('div', { className: 'ferry-empty' }, t('checking')));
      }

      return h(
        'div',
        { className: 'ferry-root' },
        h('style', null, CSS),
        h(
          'div',
          null,
          h('div', { className: 'ferry-title' }, t('title')),
          h('div', { className: 'ferry-desc' }, t('description')),
          h(
            'div',
            { className: 'ferry-meta', style: { marginTop: '8px' } },
            `${t('thisInstance')}: ${settings.instance.name} (${settings.instance.id})`,
          ),
        ),
        h(
          'div',
          { className: 'ferry-card' },
          h(
            'div',
            { className: 'ferry-card-head' },
            h('div', { className: 'ferry-section-title' }, t('instances')),
            h('span', { className: 'ferry-spacer' }),
            h(
              'button',
              { className: 'ferry-btn', type: 'button', onClick: loadStatus, disabled: checking },
              checking ? t('checking') : t('refresh'),
            ),
            h('button', { className: 'ferry-btn', type: 'button', onClick: addPeer }, t('addPeer')),
            h(
              'button',
              {
                className: 'ferry-btn primary',
                type: 'button',
                onClick: save,
                disabled: saving || settings.editable === false,
              },
              saving ? t('saving') : t('save'),
            ),
          ),
          h('div', { className: 'ferry-meta', style: { marginTop: '6px' } }, t('peersHint')),
          statusError ? h('div', { className: 'ferry-meta', style: { marginTop: '6px' } }, statusError) : null,
          settings.editable === false ? h('div', { className: 'ferry-notice error' }, t('settingsUnavailable')) : null,
          draftPeers.length === 0
            ? h('div', { className: 'ferry-empty' }, t('noPeers'))
            : draftPeers.map((peer, index) => {
                const state = peerState(peer);
                return h(
                  'div',
                  { className: 'ferry-peer', key: peer.id },
                  h(
                    'div',
                    { className: 'ferry-peer-row' },
                    h('span', { className: `ferry-dot ${state.dot}` }),
                    h('span', { style: { fontSize: '13px', fontWeight: 600 } }, peer.name || peer.id),
                    h('span', { className: 'ferry-meta' }, state.text),
                    h('span', { className: 'ferry-spacer' }),
                    h(
                      'button',
                      {
                        className: 'ferry-btn danger',
                        type: 'button',
                        onClick: () => setDraftPeers((current) => current.filter((_, position) => position !== index)),
                      },
                      t('remove'),
                    ),
                  ),
                  h(
                    'div',
                    { className: 'ferry-peer-row' },
                    h(
                      'label',
                      { className: 'ferry-field' },
                      h('span', null, t('name')),
                      h('input', {
                        className: 'ferry-input',
                        value: peer.name,
                        placeholder: peer.id,
                        onChange: (event) => updatePeer(index, { name: event.target.value }),
                      }),
                    ),
                    h(
                      'label',
                      { className: 'ferry-field', style: { flex: '1 1 260px' } },
                      h('span', null, t('url')),
                      h('input', {
                        className: 'ferry-input wide',
                        value: peer.url,
                        placeholder: 'http://100.64.0.3:3080',
                        onChange: (event) => updatePeer(index, { url: event.target.value }),
                      }),
                    ),
                    h(
                      'label',
                      { className: 'ferry-field', style: { flex: '1 1 200px' } },
                      h('span', null, t('token')),
                      h('input', {
                        className: 'ferry-input wide',
                        type: 'password',
                        value: peer.token,
                        placeholder: peer.tokenSet ? t('tokenKeep') : t('tokenNeeded'),
                        onChange: (event) => updatePeer(index, { token: event.target.value }),
                      }),
                    ),
                  ),
                );
              }),
          h(
            'div',
            { style: { marginTop: '14px', borderTop: '.5px solid var(--dsw-alias-border-l1)', paddingTop: '12px' } },
            h('div', { className: 'ferry-section-title' }, t('incomingRoot')),
            h('div', { className: 'ferry-meta', style: { margin: '4px 0 8px' } }, t('incomingRootHint')),
            h('input', {
              className: 'ferry-input wide',
              value: incomingRoot,
              placeholder: '/home/user/dsh-ferry/incoming',
              onChange: (event) => setIncomingRoot(event.target.value),
            }),
          ),
          notice
            ? h(
                'div',
                { className: `ferry-notice ${notice.tone === 'error' ? 'error' : 'success'}` },
                h(
                  'div',
                  { style: { display: 'flex', gap: '8px', alignItems: 'flex-start' } },
                  h('div', { style: { flex: '1 1 auto', whiteSpace: 'pre-wrap' } }, notice.text),
                  h('button', { type: 'button', className: 'ferry-btn', onClick: () => setNotice(null) }, t('dismiss')),
                ),
                notice.warnings?.length ? h(WarningList, { warnings: notice.warnings, t }) : null,
              )
            : null,
        ),
        h(
          'div',
          { className: 'ferry-card' },
          h('div', { className: 'ferry-section-title' }, t('pullSection')),
          h('div', { className: 'ferry-meta', style: { margin: '4px 0 10px' } }, t('pullHint')),
          h(
            'div',
            { className: 'ferry-peer-row' },
            h(
              'select',
              {
                className: 'ferry-select',
                value: pullPeer,
                onChange: (event) => {
                  setPullPeer(event.target.value);
                  setRemote({ peer: null, loading: false, sessions: [], error: null });
                },
              },
              draftPeers.map((peer) =>
                h(
                  'option',
                  { key: peer.id, value: peer.id },
                  `${peer.name || peer.id}${statusById.get(peer.id)?.online ? '' : ` (${t('offline')})`}`,
                ),
              ),
            ),
            h(
              'button',
              { className: 'ferry-btn', type: 'button', onClick: loadRemote, disabled: pullPeer === '' || remote.loading },
              remote.loading ? t('checking') : t('loadRemote'),
            ),
            h(
              'label',
              { className: 'ferry-field', style: { flex: '1 1 220px' } },
              h('span', null, t('targetDir')),
              h('input', {
                className: 'ferry-input wide',
                value: pullTarget,
                placeholder: t('targetDirHint'),
                onChange: (event) => setPullTarget(event.target.value),
              }),
            ),
            h(
              'label',
              { className: 'ferry-check' },
              h('input', { type: 'checkbox', checked: pullMerge, onChange: (event) => setPullMerge(event.target.checked) }),
              h('span', null, t('merge')),
            ),
          ),
          remote.error ? h('div', { className: 'ferry-notice error' }, remote.error) : null,
          remote.loading
            ? h('div', { className: 'ferry-empty' }, t('checking'))
            : remote.sessions.length === 0
              ? h('div', { className: 'ferry-empty' }, t('noSessions'))
              : h(
                  'div',
                  { className: 'ferry-list' },
                  remote.sessions.map((session) =>
                    h(
                      'div',
                      { className: 'ferry-item', key: session.sessionId },
                      h(
                        'div',
                        { className: 'ferry-item-main' },
                        h(
                          'div',
                          { className: 'ferry-item-title', title: session.title ?? '' },
                          session.title || t('unnamed'),
                          session.running ? h('span', { className: 'ferry-badge run' }, t('running')) : null,
                        ),
                        h(
                          'div',
                          { className: 'ferry-meta ferry-mono' },
                          `${session.cwd ?? ''}${session.updatedAt ? ` · ${formatTime(session.updatedAt)}` : ''}`,
                        ),
                        h('div', { className: 'ferry-meta' }, session.sessionId),
                      ),
                      h(
                        'button',
                        {
                          className: 'ferry-btn primary',
                          type: 'button',
                          disabled: pullBusy !== null,
                          onClick: () => pull(session),
                        },
                        pullBusy === session.sessionId ? t('pulling') : t('pull'),
                      ),
                    ),
                  ),
                ),
        ),
      );
    }

    /* ---------- Session "..." menu: push to a connected peer ---------- */

    function PushMenuItem(props) {
      const { sessionId, displayTitle, useMenuOpenState, openPanel, t } = props;
      const [, setMenuOpen] = useMenuOpenState();
      const [peers, setPeers] = useState(null);
      const [open, setOpen] = useState(false);
      const [busyPeer, setBusyPeer] = useState(null);
      const [merge, setMerge] = useState(true);
      const [anchor, setAnchor] = useState(null);
      const buttonRef = React.useRef(null);

      useEffect(() => {
        let alive = true;
        rpc({ action: 'status' })
          .then((payload) => {
            if (alive) setPeers(payload.peers ?? []);
          })
          .catch(() => {
            if (alive) setPeers([]);
          });
        return () => {
          alive = false;
        };
      }, []);

      const online = (peers ?? []).filter((peer) => peer.online === true);
      const loading = peers === null;
      const disabled = loading || online.length === 0 || busyPeer !== null;

      const openFlyout = () => {
        if (disabled) return;
        const rect = buttonRef.current?.getBoundingClientRect();
        if (rect !== undefined) {
          const height = 250;
          setAnchor({
            left: Math.min(rect.right + 4, window.innerWidth - 230),
            top: Math.max(8, Math.min(rect.top - 4, window.innerHeight - height)),
          });
        }
        setOpen(true);
      };

      const pushTo = async (peer) => {
        setOpen(false);
        setBusyPeer(peer.id);
        toasts.push({
          tone: 'info',
          title: t('pushing'),
          text: `${displayTitle || sessionId} → ${peer.name || peer.id}`,
          durationMs: 0,
        });
        try {
          const result = await rpc({ action: 'push', peerId: peer.id, sessionId, merge });
          const summary = noticeFor(result, t);
          const warnings = (result.warnings ?? []).map((warning) => codeText(warning.code ?? warning, t));
          toasts.push({
            tone: 'success',
            title: `${t('success')} · ${peer.name || peer.id}`,
            text: `${summary.text}${warnings.length ? `\n${warnings.join('\n')}` : ''}`,
          });
          setMenuOpen(false);
        } catch (error) {
          toasts.push({
            tone: 'error',
            title: `${t('failed')} · ${peer.name || peer.id}`,
            text: layoutError(error, t),
          });
        } finally {
          setBusyPeer(null);
        }
      };

      return h(
        'div',
        { style: { position: 'relative' }, onPointerLeave: () => setOpen(false) },
        h(
          'button',
          {
            ref: buttonRef,
            type: 'button',
            role: 'menuitem',
            className: 'ferry-menu-item',
            disabled,
            'aria-haspopup': online.length > 0 ? 'menu' : undefined,
            'aria-expanded': open,
            title: loading ? t('checking') : online.length === 0 ? t('noOnlinePeer') : undefined,
            onMouseEnter: openFlyout,
            onClick: () => (open ? setOpen(false) : openFlyout()),
          },
          h(PeerIcon, { size: 15 }),
          h('span', null, loading ? t('checking') : online.length === 0 ? t('noOnlinePeer') : t('pushTo')),
          online.length > 0 ? h('span', { className: 'ferry-spacer' }) : null,
          online.length > 0 ? h('span', { style: { opacity: 0.6 } }, '▸') : null,
        ),
        open && anchor !== null
          ? h(
              'div',
              { className: 'ferry-flyout', role: 'menu', style: { left: `${anchor.left}px`, top: `${anchor.top}px` } },
              h('div', { className: 'ferry-flyout-head' }, t('pushTo')),
              online.map((peer) =>
                h(
                  'button',
                  {
                    key: peer.id,
                    type: 'button',
                    role: 'menuitem',
                    className: 'ferry-flyout-row',
                    disabled: busyPeer !== null,
                    onClick: () => pushTo(peer),
                  },
                  h('span', { className: 'ferry-dot on' }),
                  h('span', null, peer.name || peer.id),
                  h('span', { className: 'ferry-spacer' }),
                  typeof peer.latencyMs === 'number'
                    ? h('span', { className: 'ferry-meta' }, `${peer.latencyMs}${t('latency')}`)
                    : null,
                ),
              ),
              h(
                'div',
                { className: 'ferry-flyout-foot' },
                h(
                  'label',
                  { className: 'ferry-check' },
                  h('input', {
                    type: 'checkbox',
                    checked: merge,
                    onChange: (event) => setMerge(event.target.checked),
                  }),
                  h('span', null, t('mergeInMenu')),
                ),
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'ferry-menu-item',
                    style: { fontSize: '11px', padding: '2px 0', opacity: 0.75 },
                    onClick: () => {
                      setOpen(false);
                      setMenuOpen(false);
                      openPanel?.();
                    },
                  },
                  t('managePeers'),
                ),
              ),
            )
          : null,
      );
    }

    /* ---------- overlay toast host ---------- */

    function ToastHost(props) {
      const t = props.t;
      const [items, setItems] = useState(toasts.snapshot());
      useEffect(() => toasts.subscribe(() => setItems(toasts.snapshot())), []);
      if (items.length === 0) return null;
      return h(
        'div',
        { className: 'ferry-toasts' },
        items.map((item) =>
          h(
            'div',
            { key: item.id, className: `ferry-toast ${item.tone}` },
            h(
              'div',
              { style: { display: 'flex', gap: '8px', alignItems: 'flex-start' } },
              h(
                'div',
                { style: { flex: '1 1 auto', whiteSpace: 'pre-wrap' } },
                item.title ? h('div', { className: 'ferry-toast-title' }, item.title) : null,
                item.text ? h('div', null, item.text) : null,
              ),
              h('button', { className: 'ferry-btn', type: 'button', onClick: () => toasts.dismiss(item.id) }, t('dismiss')),
            ),
          ),
        ),
      );
    }

    /* ---------- wiring ---------- */

    const inject = ['slots', 'locale', 'layout'];

    function apply(ctx) {
      const ns = 'dshFerry';
      ctx.effect(() => ctx.locale.register(ns, { en, zh }));
      const t = ctx.locale.bind(ns);
      ctx.slots.inject('sidebar.panellist', () =>
        ctx.slots.register(
          {
            name: 'sidebar.panellist',
            id: 'dsh-ferry',
            order: 20,
            locale: ns,
            label: () => t('title'),
          },
          PeerIcon,
        ),
      );
      ctx.slots.inject('main', () =>
        ctx.slots.register({ name: 'main', key: 'dsh-ferry', locale: ns }, FerryPage),
      );
      ctx.slots.inject('sidebar.workspaces.session.menu.item', () =>
        ctx.slots.register(
          {
            name: 'sidebar.workspaces.session.menu.item',
            id: 'dsh-ferry-push',
            order: 500,
            locale: ns,
            inject: () => ({ openPanel: () => ctx.layout.selectPanel('dsh-ferry') }),
          },
          PushMenuItem,
        ),
      );
      ctx.slots.inject('shell.overlay', () =>
        ctx.slots.register({ name: 'shell.overlay', id: 'dsh-ferry-toast', order: 100, locale: ns }, ToastHost),
      );
    }

    return { inject, apply };
  },
});
