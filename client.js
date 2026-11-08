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
.ferry-modal-backdrop{position:fixed;inset:0;z-index:85;pointer-events:auto;background:rgba(0,0,0,.45)}
.ferry-modal{position:fixed;z-index:86;left:50%;top:50%;transform:translate(-50%,-50%);width:min(460px,calc(100vw - 32px));max-height:calc(100vh - 32px);overflow:auto;box-sizing:border-box;padding:18px;border:.5px solid var(--dsw-alias-border-l2);border-radius:12px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);box-shadow:0 18px 48px rgba(0,0,0,.4);display:flex;flex-direction:column;gap:10px;outline:none;pointer-events:auto}
.ferry-modal-head{display:flex;flex-direction:column;gap:3px}
.ferry-modal-title{font-size:15px;font-weight:600;line-height:22px}
.ferry-modal-session{font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ferry-modal-hint{font-size:11px;line-height:17px;color:var(--dsw-alias-label-secondary)}
.ferry-modal-toolbar{display:flex;align-items:flex-start;gap:10px}
.ferry-modal-toolbar .ferry-modal-hint{flex:1 1 auto}
.ferry-choice-list{display:flex;flex-direction:column;gap:2px;max-height:240px;overflow:auto;margin:2px 0}
.ferry-choice{display:flex;align-items:center;gap:10px;padding:8px 10px;border:.5px solid transparent;border-radius:7px;font-size:13px;line-height:19px;cursor:pointer}
.ferry-choice:hover{background:var(--dsw-alias-bg-layer-2)}
.ferry-choice.selected{border-color:var(--dsw-alias-brand-primary);background:var(--dsw-alias-bg-layer-2)}
.ferry-choice input[type=radio]{flex:none;margin:0;width:14px;height:14px;cursor:inherit}
.ferry-choice.offline{opacity:.5;cursor:default}
.ferry-choice.offline:hover{background:transparent}
.ferry-status{display:inline-flex;align-items:center;gap:6px;flex:none;font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary)}
.ferry-choice-body{flex:1 1 auto;min-width:0}
.ferry-state{font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary);margin-top:2px;white-space:normal}
.ferry-mode{display:flex;flex-direction:column;gap:2px;padding-top:6px}
.ferry-mode-title{font-size:12px;line-height:18px;font-weight:500;color:var(--dsw-alias-label-primary);padding:0 10px;margin-bottom:2px}
.ferry-mode-label{display:flex;align-items:flex-start;gap:10px;padding:5px 10px;border-radius:7px;font-size:12px;line-height:18px;cursor:pointer}
.ferry-mode-label:hover:not(.disabled){background:var(--dsw-alias-bg-layer-2)}
.ferry-mode-label input[type=radio]{flex:none;margin:2px 0 0;width:14px;height:14px;cursor:inherit}
.ferry-mode-label.disabled{cursor:default;color:var(--dsw-alias-label-secondary)}
.ferry-mode-text{display:flex;flex-direction:column;min-width:0;gap:1px}
.ferry-mode-hint{font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary)}
.ferry-stack{display:flex;flex-direction:column;gap:4px}
.ferry-choice-name{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ferry-modal-error{font-size:11px;line-height:16px;color:var(--dsw-alias-state-error-primary)}
.ferry-modal-foot{display:flex;align-items:center;gap:8px;border-top:.5px solid var(--dsw-alias-border-l1);padding-top:12px;margin-top:2px}
.ferry-check{display:flex;align-items:center;gap:6px;font-size:12px;color:var(--dsw-alias-label-secondary);cursor:pointer}
.ferry-toasts{position:fixed;right:20px;bottom:20px;z-index:90;display:flex;flex-direction:column;gap:8px;max-width:380px;pointer-events:none}
.ferry-toast{pointer-events:auto;border:.5px solid var(--dsw-alias-border-l2);border-left-width:3px;border-radius:8px;background:var(--dsw-alias-bg-overlay);padding:10px 12px;font-size:12px;line-height:18px;box-shadow:0 8px 24px rgba(0,0,0,.24)}
.ferry-toast.success{border-left-color:var(--dsw-alias-state-success-primary)}
.ferry-toast.error{border-left-color:var(--dsw-alias-state-error-primary)}
.ferry-toast.info{border-left-color:var(--dsw-alias-brand-primary)}
.ferry-toast-title{font-weight:600;margin-bottom:2px}
`;

    /**
     * Install the plugin stylesheet once for every slot surface. The sidebar
     * panel, the Session menu flyout and the toasts live in different render
     * trees, so a component-local <style> would leave the menu unstyled.
     * @returns {() => void} disposer removing this generation's tag.
     */
    function installStyles() {
      if (typeof document === 'undefined') return () => {};
      const tag = document.createElement('style');
      tag.setAttribute('data-dsh-ferry', String(Date.now()) + Math.random().toString(36).slice(2));
      tag.textContent = CSS;
      document.head.appendChild(tag);
      return () => {
        tag.remove();
      };
    }

    const en = {
      title: 'dsh-ferry',
      description:
        'Push a Session (and the files it needs) to a connected DSH instance, or pull one back. Instances must be able to reach each other; configure peers below.',
      instances: 'Peers',
      thisInstance: 'This instance',
      noPeers: 'No peers yet. Add one with its DSH web URL. Receiving pushes only needs the same token and incoming directory.',
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
      peersHint:
        'One shared token covers every instance. Only the side that can reach the other needs a peer entry; the receiving side just needs the same token and an incoming directory. The token never leaves this machine.',
      tokenHint: 'Fleet-wide shared token. Leave blank to keep the current one.',
      pullSection: 'Pull a session',
      pullHint: 'Choose a peer, load its sessions, then pick one to pull and confirm how the local copy is treated.',
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
      pushDialogTitle: 'Push to another instance',
      pushDialogHint:
        'Choose a target. When that instance has no local directory for this workspace, the files land in its incoming directory.',
      pushDialogChecking: 'Checking instances…',
      cancel: 'Cancel',
      confirmPush: 'Push',
      noOnlinePeer: 'No peer is connected right now',
      managePeers: 'Manage peers…',
      mergeInMenu: 'Merge into an existing directory (backs up)',
      modeTitle: 'How to send it',
      modeNew: 'New session',
      modeNewHint: 'Create a separate copy; the peer keeps what it already has.',
      modeUpdate: 'Append update',
      modeUpdateHint: 'Append only the missing events and merge the workspace.',
      modeUpdateUnavailable: 'Not available for this peer',
      blocked_state_open: 'The peer has it open',
      blocked_state_ahead: "The peer's copy is longer",
      blocked_state_diverged: 'The two copies differ',
      blocked_state_absent: 'The peer has no copy yet',
      blocked_local_open: 'It is open here',
      blocked_local_ahead: 'The local copy is longer',
      blocked_local_diverged: 'The two copies differ',
      blocked_local_absent: 'No local copy here yet',
      state_absent: 'No copy there yet; it will be created',
      state_behind: 'The peer has {have} events; {add} will be appended',
      state_same: 'The peer has {have} events and matches; only workspace files are synced',
      state_ahead: 'The peer has {have} events, more than here; only a new copy is possible',
      state_diverged: 'The peer copy has diverged; only a new copy is possible',
      state_active: 'The peer has this session open; close it or restart that instance to append',
      state_unknown: 'Cannot tell what the peer has (offline, or its plugin is older; append updates need the same version on both sides)',
      local_absent: 'No local copy yet; it will be created',
      local_behind: 'This instance has {have} events; {add} will be appended',
      local_same: 'This instance has {have} events and matches; only workspace files are synced',
      local_ahead: 'This instance has {have} events, more than the peer; only a new copy is possible',
      local_diverged: 'The local copy has diverged; only a new copy is possible',
      local_active: 'This session is open here; close it or restart this instance to append',
      local_unknown: 'Cannot tell what this instance has',
      pullDialogTitle: 'Pull from another instance',
      pullDialogChecking: 'Checking the local copy…',
      pullDialogHint: 'Choose how the local copy should be treated.',
      confirmPull: 'Pull',
      appended: 'events appended',
      code_session_ahead: 'The peer has a longer copy of this session; send it as a new session.',
      code_session_diverged: 'The peer has a different copy of this session; send it as a new session.',
      code_session_active: 'The session is open there; close it or restart that instance before updating it.',
      code_session_unreadable: 'The stored session log could not be read, so the peer copy cannot be compared.',
      code_plugin_version_mismatch: 'Both instances must run the same dsh-ferry version; update them and retry.',
      code_sessionForked: 'The two copies had diverged, so the push created a separate session on the peer.',
      files: 'files',
      overwritten: 'overwritten',
      skippedTitle: 'Left behind',
      warningsTitle: 'Notes',
      dismiss: 'Dismiss',
      success: 'Done',
      failed: 'Failed',
      alreadyThere: 'Already present with the same content; nothing was overwritten.',
      queuedNotice: 'Delivered. That instance has the session open, so the update is applied when it next starts.',
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
      code_workspaceUnarchiveFailed: 'The session was updated but could not be unarchived.',
      code_sourceArchiveFailed: 'The transfer succeeded but the source session could not be archived.',
      code_sourceArchiveSkippedQueued: 'The update is queued on the peer, so the source session was left unarchived.',
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
      code_no_token: 'No shared token is configured; set one in the dsh-ferry panel.',
    };

    const zh = {
      title: 'dsh-ferry',
      description:
        '把会话以及它需要的工作区文件推送到另一个可达的 DSH 实例，或从对端拉取。实例之间必须网络可达；在下方配置对端。',
      instances: '实例',
      thisInstance: '本实例',
      noPeers: '还没有对端。填写对端的 DSH Web 地址即可添加；只被动接收推送的一侧，只需要相同令牌和接收目录。',
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
      peersHint:
        '同一个令牌适用于所有实例。只有能主动访问对方的一侧需要添加对端；接收侧只需相同令牌和接收目录。令牌不会离开本机。',
      tokenHint: '全局共享令牌，所有实例一致；留空保持不变。',
      pullSection: '拉取会话',
      pullHint: '选择对端，加载它的会话列表，点“拉取”后确认本地副本怎么处理。',
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
      pushDialogTitle: '推送到其他实例',
      pushDialogHint: '选择目标实例。对端没有该工作区的本机目录时，文件会落到对端的接收目录。',
      pushDialogChecking: '正在检查实例状态…',
      cancel: '取消',
      confirmPush: '推送',
      noOnlinePeer: '当前没有已连接的对端',
      managePeers: '管理实例…',
      mergeInMenu: '合并已有目录（自动备份）',
      modeTitle: '推送方式',
      modeNew: '新建会话',
      modeNewHint: '在对方创建独立副本，不动已有内容。',
      modeUpdate: '追加更新',
      modeUpdateHint: '只补上对方缺少的事件，并合并工作区。',
      modeUpdateUnavailable: '当前对端不可追加',
      blocked_state_open: '对方已打开该会话',
      blocked_state_ahead: '对方副本更长',
      blocked_state_diverged: '两边内容已不同',
      blocked_state_absent: '对方没有此会话',
      blocked_local_open: '本地已打开该会话',
      blocked_local_ahead: '本地副本更长',
      blocked_local_diverged: '两边内容已不同',
      blocked_local_absent: '本地还没有此会话',
      state_absent: '对方没有此会话，将新建',
      state_behind: '对方已有 {have} 条，本次追加 {add} 条',
      state_same: '对方已有 {have} 条且内容一致，只同步工作区文件',
      state_ahead: '对方已有 {have} 条，比本地多，只能新建副本',
      state_diverged: '对方内容与本地不同，只能新建副本',
      state_active: '对方已打开该会话；在那边关闭或重启实例后即可追加',
      state_unknown: '无法判断对方状态（离线，或对方插件较旧；追加更新需要两端同版本）',
      local_absent: '本地没有此会话，将新建',
      local_behind: '本地已有 {have} 条，本次追加 {add} 条',
      local_same: '本地已有 {have} 条且内容一致，只同步工作区文件',
      local_ahead: '本地已有 {have} 条，比远端多，只能新建副本',
      local_diverged: '本地内容与远端不同，只能新建副本',
      local_active: '本地已打开该会话；关闭或重启本实例后即可追加',
      local_unknown: '无法判断本地状态',
      pullDialogTitle: '从其他实例拉取',
      pullDialogChecking: '正在检查本地副本…',
      pullDialogHint: '选择本次拉取如何处理本地已有副本。',
      confirmPull: '拉取',
      appended: '条事件已追加',
      code_session_ahead: '对方有比本地更长的副本，请改为新建会话推送。',
      code_session_diverged: '对方已有内容不同的同名会话，请改为新建会话推送。',
      code_session_active: '该会话在对端/本地处于打开状态，请先关闭或重启实例后再更新。',
      code_session_unreadable: '会话日志无法读取，无法比较对方副本。',
      code_plugin_version_mismatch: '两端的 dsh-ferry 版本不一致，请升级到同一版本后重试。',
      code_sessionForked: '两边内容已分叉，已在对方新建独立会话。',
      files: '文件',
      overwritten: '覆盖',
      skippedTitle: '未传输',
      warningsTitle: '提示',
      dismiss: '知道了',
      success: '完成',
      failed: '失败',
      alreadyThere: '目标已有内容相同的会话，没有覆盖任何内容。',
      queuedNotice: '已送达。对方正打开着该会话，更新会在它下次启动时自动应用。',
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
      code_workspaceUnarchiveFailed: '会话已更新，但没能从归档中恢复。',
      code_sourceArchiveFailed: '传输成功，但源会话归档失败。',
      code_sourceArchiveSkippedQueued: '更新已排队到对端，因此源会话没有归档。',
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
      code_no_token: '还没有配置共享令牌；请在 dsh-ferry 面板里设置。',
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
      if (result?.status === 'updated' && typeof result.appended === 'number') {
        pieces.push(`${result.appended} ${t('appended')}`);
      }
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
      if (result?.status === 'queued') return { tone: 'success', text: t('queuedNotice') };
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
      const [token, setToken] = useState('');
      const [tokenSet, setTokenSet] = useState(false);
      const [notice, setNotice] = useState(null);
      const [pullPeer, setPullPeer] = useState('');
      const [remote, setRemote] = useState({ peer: null, loading: false, sessions: [], error: null });

      const applySettings = useCallback((next) => {
        setSettings(next);
        setDraftPeers(
          (next?.peers ?? []).map((peer) => ({
            id: peer.id,
            name: peer.name ?? '',
            url: peer.url ?? '',
          })),
        );
        setToken('');
        setTokenSet(next?.tokenSet === true);
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
          { id: `peer-${suffix}`, name: '', url: '' },
        ]);
      };

      const save = async () => {
        setSaving(true);
        setNotice(null);
        try {
          for (const peer of draftPeers) {
            if (peer.url.trim() === '') throw new Error(t('urlNeeded'));
          }
          if (draftPeers.length > 0 && !tokenSet && token.trim() === '') throw new Error(t('tokenNeeded'));
          const payload = await rpc({
            action: 'saveSettings',
            incomingRoot,
            ...(token.trim() === '' ? {} : { token: token.trim() }),
            peers: draftPeers.map((peer) => ({
              id: peer.id,
              name: peer.name.trim() === '' ? peer.id : peer.name.trim(),
              url: peer.url.trim(),
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

      const openPull = (session) => {
        pullDialog.open({
          peerId: pullPeer,
          sessionId: session.sessionId,
          title: session.title ?? '',
        });
      };

      if (settings === null) {
        return h('div', { className: 'ferry-root' }, h('div', { className: 'ferry-empty' }, t('checking')));
      }

      return h(
        'div',
        { className: 'ferry-root' },
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
          h(
            'div',
            { style: { marginTop: '12px' } },
            h(
              'label',
              { className: 'ferry-field' },
              h('span', null, t('token')),
              h('input', {
                className: 'ferry-input',
                style: { minWidth: '320px' },
                type: 'password',
                value: token,
                placeholder: tokenSet ? t('tokenKeep') : t('tokenNeeded'),
                onChange: (event) => setToken(event.target.value),
              }),
            ),
            h('div', { className: 'ferry-meta', style: { marginTop: '4px' } }, t('tokenHint')),
          ),
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
                          disabled: pullPeer === '',
                          onClick: () => openPull(session),
                        },
                        t('pull'),
                      ),
                    ),
                  ),
                ),
        ),
      );
    }

    /** Module-scoped push dialog shared by the Session menu and the overlay. */
    const pushDialog = (() => {
      let state = null;
      const listeners = new Set();
      const emit = () => {
        for (const listener of listeners) listener();
      };
      return {
        open(next) {
          state = next;
          emit();
        },
        close() {
          state = null;
          emit();
        },
        subscribe(listener) {
          listeners.add(listener);
          return () => {
            listeners.delete(listener);
          };
        },
        snapshot() {
          return state;
        },
      };
    })();

    /* ---------- Session "..." menu: open the push dialog ---------- */

    function PushMenuItem(props) {
      const { sessionId, displayTitle, useMenuOpenState, openPanel, t } = props;
      const [, setMenuOpen] = useMenuOpenState();
      return h(
        'button',
        {
          type: 'button',
          role: 'menuitem',
          className: 'ferry-menu-item',
          onClick: () => {
            setMenuOpen(false);
            pushDialog.open({ sessionId, displayTitle, openPanel });
          },
        },
        h(PeerIcon, { size: 15 }),
        h('span', null, t('pushTo')),
      );
    }

    /* ---------- transfer planning: peer state shown before anything moves ---------- */

    /**
     * Substitute `{name}` placeholders in one locale string.
     * @param {string} template - locale template.
     * @param {Record<string, string|number>} values - replacements.
     * @returns {string} text.
     */
    function fill(template, values) {
      return String(template).replace(/\{(\w+)\}/g, (match, key) =>
        values[key] === undefined ? match : String(values[key]),
      );
    }

    /**
     * Whether the receiving side can append to its own copy in place.
     * @param {object | undefined} row - peer or local plan row.
     * @returns {boolean} true when an append update is possible.
     */
    function appendAvailable(row) {
      if (row === undefined || row === null) return false;
      if (row.active === true) return false;
      return row.state === 'behind' || row.state === 'same';
    }

    /**
     * Why an in-place append is unavailable, phrased for the row it belongs to.
     * @param {'state'|'local'} side - whose copy the row describes.
     * @param {object | undefined} row - plan row.
     * @param {(key: string) => string} t - translator.
     * @returns {string} short reason.
     */
    function blockedReason(side, row, t) {
      const reason = row?.active === true ? 'open' : (row?.state ?? 'unknown');
      const key = `blocked_${side}_${reason}`;
      const text = t(key);
      return text === key ? t('modeUpdateUnavailable') : text;
    }

    /**
     * Render one state line for a peer row (`state_*`) or a local plan row
     * (`local_*`).
     * @param {'state'|'local'} side - whose copy the row describes.
     * @param {object} row - plan row.
     * @param {number | undefined} total - event count on the sending side.
     * @param {(key: string) => string} t - translator.
     * @returns {string} localized line.
     */
    function stateLine(side, row, total, t) {
      const have = typeof row?.eventCount === 'number' ? row.eventCount : 0;
      const add = typeof total === 'number' ? Math.max(0, total - have) : 0;
      const key = row?.active === true ? `${side}_active` : `${side}_${row?.state ?? 'unknown'}`;
      const template = t(key);
      if (template === key) return t(`${side}_unknown`);
      return fill(template, { have, add });
    }

    /* ---------- push dialog: reachability is checked here, not in the menu ---------- */

    function PushDialogHost(props) {
      const t = props.t;
      const [state, setState] = useState(pushDialog.snapshot());
      const [peers, setPeers] = useState(null);
      const [plan, setPlan] = useState(null);
      const [statusError, setStatusError] = useState(null);
      const [checking, setChecking] = useState(false);
      const [selected, setSelected] = useState('');
      const [mode, setMode] = useState('new');
      const [merge, setMerge] = useState(true);
      const [busy, setBusy] = useState(false);
      const [error, setError] = useState(null);
      const dialogRef = React.useRef(null);

      const refreshPeers = useCallback(async () => {
        const current = pushDialog.snapshot();
        if (current === null) return;
        setChecking(true);
        setStatusError(null);
        try {
          const payload = await rpc({ action: 'pushPlan', sessionId: current.sessionId });
          const rows = Array.isArray(payload.peers) ? payload.peers : [];
          setPlan(payload.session ?? null);
          setPeers(rows);
          setSelected((currentId) => {
            if (rows.some((row) => row.id === currentId && row.online === true)) return currentId;
            return rows.find((row) => row.online === true)?.id ?? '';
          });
        } catch (failure) {
          setPeers([]);
          setPlan(null);
          setStatusError(layoutError(failure, t));
        } finally {
          setChecking(false);
        }
      }, [t]);

      useEffect(
        () =>
          pushDialog.subscribe(() => {
            const next = pushDialog.snapshot();
            setState(next);
            setBusy(false);
            setError(null);
            setMerge(true);
            setPeers(null);
            setPlan(null);
            setMode('new');
            setStatusError(null);
            setSelected('');
            if (next !== null) refreshPeers();
          }),
        [refreshPeers],
      );

      const selectedPeer = (peers ?? []).find((row) => row.id === selected && row.online === true);
      const canAppend = appendAvailable(selectedPeer);

      // Default to whatever the peer state allows; the operator can override
      // until the selected peer or the peer list changes.
      useEffect(() => {
        setMode(canAppend ? 'update' : 'new');
      }, [selected, peers]);

      useEffect(() => {
        if (state === null) return;
        dialogRef.current?.focus();
        const onKey = (event) => {
          if (event.key === 'Escape' && !busy) pushDialog.close();
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
      }, [state, busy]);

      if (state === null) return null;
      const online = (peers ?? []).filter((row) => row.online === true);
      const peer = selectedPeer;
      const total = plan !== null && typeof plan.eventCount === 'number' ? plan.eventCount : undefined;
      const listPending = peers === null;

      const submit = async () => {
        if (peer === undefined) return;
        setBusy(true);
        setError(null);
        toasts.push({
          tone: 'info',
          title: t('pushing'),
          text: `${state.displayTitle || state.sessionId} → ${peer.name || peer.id}`,
          durationMs: 0,
        });
        try {
          const result = await rpc({ action: 'push', peerId: peer.id, sessionId: state.sessionId, mode, merge });
          const summary = noticeFor(result, t);
          const warnings = (result.warnings ?? []).map((warning) => codeText(warning.code ?? warning, t));
          toasts.push({
            tone: 'success',
            title: `${t('success')} · ${peer.name || peer.id}`,
            text: `${summary.text}${warnings.length ? `\n${warnings.join('\n')}` : ''}`,
          });
          pushDialog.close();
        } catch (failure) {
          setError(layoutError(failure, t));
          toasts.push({
            tone: 'error',
            title: `${t('failed')} · ${peer.name || peer.id}`,
            text: layoutError(failure, t),
          });
        } finally {
          setBusy(false);
        }
      };

      const modeOption = (value, label, hint, enabled, reason) =>
        h(
          'label',
          { key: value, className: `ferry-mode-label ${enabled ? '' : 'disabled'}` },
          h('input', {
            type: 'radio',
            name: 'dsh-ferry-push-mode',
            value,
            checked: mode === value,
            disabled: busy || !enabled,
            onChange: () => setMode(value),
          }),
          h(
            'span',
            { className: 'ferry-mode-text' },
            h('span', null, label),
            h('span', { className: 'ferry-mode-hint' }, enabled ? hint : reason ?? t('modeUpdateUnavailable')),
          ),
        );

      let body;
      if (listPending) {
        body = h('div', { className: 'ferry-modal-hint' }, t('pushDialogChecking'));
      } else if (statusError !== null) {
        body = h('div', { className: 'ferry-modal-error' }, statusError);
      } else if (peers.length === 0) {
        body = h('div', { className: 'ferry-modal-hint' }, t('noPeers'));
      } else {
        body = h(
          React.Fragment,
          null,
          online.length === 0 ? h('div', { className: 'ferry-modal-hint' }, t('noOnlinePeer')) : null,
          h(
            'div',
            { className: 'ferry-choice-list', role: 'radiogroup' },
            peers.map((candidate) =>
              h(
                'label',
                {
                  key: candidate.id,
                  className: `ferry-choice ${selected === candidate.id ? 'selected' : ''}${
                    candidate.online === true ? '' : ' offline'
                  }`,
                },
                h('input', {
                  type: 'radio',
                  name: 'dsh-ferry-peer',
                  value: candidate.id,
                  checked: selected === candidate.id,
                  disabled: busy || candidate.online !== true,
                  onChange: () => setSelected(candidate.id),
                }),
                h(
                  'div',
                  { className: 'ferry-choice-body' },
                  h(
                    'div',
                    { className: 'ferry-choice-name', title: candidate.name || candidate.id },
                    candidate.name || candidate.id,
                  ),
                  candidate.online === true
                    ? h('div', { className: 'ferry-state' }, stateLine('state', candidate, total, t))
                    : null,
                ),
                h(
                  'span',
                  { className: 'ferry-status' },
                  h('span', { className: `ferry-dot ${candidate.online === true ? 'on' : 'off'}` }),
                  h(
                    'span',
                    null,
                    candidate.online === true && typeof candidate.latencyMs === 'number'
                      ? `${candidate.latencyMs}${t('latency')}`
                      : t('offline'),
                  ),
                ),
              ),
            ),
          ),
        );
      }

      return h(
        React.Fragment,
        null,
        h('div', {
          className: 'ferry-modal-backdrop',
          onMouseDown: () => {
            if (!busy) pushDialog.close();
          },
        }),
        h(
          'div',
          {
            className: 'ferry-modal',
            role: 'dialog',
            'aria-modal': 'true',
            'aria-labelledby': 'dsh-ferry-push-title',
            tabIndex: -1,
            ref: dialogRef,
          },
          h(
            'div',
            { className: 'ferry-modal-head' },
            h('div', { className: 'ferry-modal-title', id: 'dsh-ferry-push-title' }, t('pushDialogTitle')),
            h(
              'div',
              { className: 'ferry-modal-session', title: state.displayTitle || state.sessionId },
              state.displayTitle || state.sessionId,
            ),
          ),
          h(
            'div',
            { className: 'ferry-modal-toolbar' },
            h('span', { className: 'ferry-modal-hint' }, t('pushDialogHint')),
            h(
              'button',
              {
                type: 'button',
                className: 'ferry-btn',
                disabled: checking || busy,
                onClick: refreshPeers,
              },
              checking ? t('checking') : t('refresh'),
            ),
          ),
          body,
          peer === undefined
            ? null
            : h(
                'div',
                { className: 'ferry-mode' },
                h('div', { className: 'ferry-mode-title' }, t('modeTitle')),
                modeOption('new', t('modeNew'), t('modeNewHint'), true),
                modeOption(
                  'update',
                  t('modeUpdate'),
                  t('modeUpdateHint'),
                  canAppend,
                  blockedReason('state', selectedPeer, t),
                ),
              ),
          mode === 'new'
            ? h(
                'label',
                { className: 'ferry-check' },
                h('input', {
                  type: 'checkbox',
                  checked: merge,
                  disabled: busy,
                  onChange: (event) => setMerge(event.target.checked),
                }),
                h('span', null, t('mergeInMenu')),
              )
            : null,
          error !== null ? h('div', { className: 'ferry-modal-error' }, error) : null,
          h(
            'div',
            { className: 'ferry-modal-foot' },
            h(
              'button',
              {
                type: 'button',
                className: 'ferry-menu-item',
                style: { width: 'auto', fontSize: '11px', padding: '2px 0', opacity: 0.75 },
                onClick: () => {
                  pushDialog.close();
                  state.openPanel?.();
                },
              },
              t('managePeers'),
            ),
            h('span', { className: 'ferry-spacer' }),
            h(
              'button',
              { type: 'button', className: 'ferry-btn', disabled: busy, onClick: () => pushDialog.close() },
              t('cancel'),
            ),
            h(
              'button',
              { type: 'button', className: 'ferry-btn primary', disabled: busy || peer === undefined, onClick: submit },
              busy ? t('pushing') : t('confirmPush'),
            ),
          ),
        ),
      );
    }

    /** Module-scoped pull dialog shared by the sidebar panel and the overlay. */
    const pullDialog = (() => {
      let state = null;
      const listeners = new Set();
      const emit = () => {
        for (const listener of listeners) listener();
      };
      return {
        open(next) {
          state = next;
          emit();
        },
        close() {
          state = null;
          emit();
        },
        subscribe(listener) {
          listeners.add(listener);
          return () => {
            listeners.delete(listener);
          };
        },
        snapshot() {
          return state;
        },
      };
    })();

    /* ---------- pull dialog: inspect the local copy before downloading ---------- */

    function PullDialogHost(props) {
      const t = props.t;
      const [state, setState] = useState(pullDialog.snapshot());
      const [plan, setPlan] = useState(null);
      const [checking, setChecking] = useState(false);
      const [statusError, setStatusError] = useState(null);
      const [mode, setMode] = useState('new');
      const [targetDir, setTargetDir] = useState('');
      const [merge, setMerge] = useState(false);
      const [busy, setBusy] = useState(false);
      const [error, setError] = useState(null);
      const dialogRef = React.useRef(null);

      const loadPlan = useCallback(async () => {
        const current = pullDialog.snapshot();
        if (current === null) return;
        setChecking(true);
        setStatusError(null);
        try {
          const payload = await rpc({ action: 'pullPlan', peerId: current.peerId, sessionId: current.sessionId });
          setPlan(payload);
        } catch (failure) {
          setPlan(null);
          setStatusError(layoutError(failure, t));
        } finally {
          setChecking(false);
        }
      }, [t]);

      useEffect(
        () =>
          pullDialog.subscribe(() => {
            const next = pullDialog.snapshot();
            setState(next);
            setPlan(null);
            setChecking(false);
            setError(null);
            setMode('new');
            setTargetDir('');
            setMerge(false);
            setStatusError(null);
            if (next !== null) loadPlan();
          }),
        [loadPlan],
      );

      const canAppend = appendAvailable(plan);
      useEffect(() => {
        setMode(canAppend ? 'update' : 'new');
      }, [plan]);

      useEffect(() => {
        if (state === null) return;
        dialogRef.current?.focus();
        const onKey = (event) => {
          if (event.key === 'Escape' && !busy) pullDialog.close();
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
      }, [state, busy]);

      if (state === null) return null;
      const title = state.title || state.sessionId;

      const submit = async () => {
        setBusy(true);
        setError(null);
        toasts.push({ tone: 'info', title: t('pulling'), text: title, durationMs: 0 });
        try {
          const result = await rpc({
            action: 'pull',
            peerId: state.peerId,
            sessionId: state.sessionId,
            mode,
            ...(targetDir.trim() === '' ? {} : { targetDir: targetDir.trim() }),
            merge,
          });
          const summary = noticeFor(result, t);
          const warnings = (result.warnings ?? []).map((warning) => codeText(warning.code ?? warning, t));
          toasts.push({
            tone: 'success',
            title: `${t('success')} · ${t('pull')}`,
            text: `${summary.text}${warnings.length ? `\n${warnings.join('\n')}` : ''}`,
          });
          pullDialog.close();
        } catch (failure) {
          setError(layoutError(failure, t));
          toasts.push({ tone: 'error', title: `${t('failed')} · ${t('pull')}`, text: layoutError(failure, t) });
        } finally {
          setBusy(false);
        }
      };

      const modeOption = (value, label, hint, enabled, reason) =>
        h(
          'label',
          { key: value, className: `ferry-mode-label ${enabled ? '' : 'disabled'}` },
          h('input', {
            type: 'radio',
            name: 'dsh-ferry-pull-mode',
            value,
            checked: mode === value,
            disabled: busy || !enabled,
            onChange: () => setMode(value),
          }),
          h(
            'span',
            { className: 'ferry-mode-text' },
            h('span', null, label),
            h('span', { className: 'ferry-mode-hint' }, enabled ? hint : reason ?? t('modeUpdateUnavailable')),
          ),
        );

      const blocked = plan !== null && plan.ok === false;
      let body;
      if (plan === null) {
        body =
          statusError !== null
            ? h('div', { className: 'ferry-modal-error' }, statusError)
            : h('div', { className: 'ferry-modal-hint' }, t('pullDialogChecking'));
      } else if (blocked) {
        body = h(
          'div',
          { className: 'ferry-modal-error' },
          plan.message ?? codeText(plan.code ?? 'preflight-failed', t),
        );
      } else {
        body = h(
          React.Fragment,
          null,
          h('div', { className: 'ferry-state' }, stateLine('local', plan, plan.session?.eventCount, t)),
          h(
            'div',
            { className: 'ferry-mode' },
            h('div', { className: 'ferry-mode-title' }, t('modeTitle')),
            modeOption('new', t('modeNew'), t('modeNewHint'), true),
            modeOption(
              'update',
              t('modeUpdate'),
              t('modeUpdateHint'),
              canAppend,
              blockedReason('local', plan, t),
            ),
          ),
          h(
            'label',
            { className: 'ferry-stack' },
            h('span', { className: 'ferry-modal-hint' }, t('targetDir')),
            h('input', {
              className: 'ferry-input wide',
              value: targetDir,
              placeholder: t('targetDirHint'),
              disabled: busy,
              onChange: (event) => setTargetDir(event.target.value),
            }),
          ),
          mode === 'new'
            ? h(
                'label',
                { className: 'ferry-check' },
                h('input', {
                  type: 'checkbox',
                  checked: merge,
                  disabled: busy,
                  onChange: (event) => setMerge(event.target.checked),
                }),
                h('span', null, t('mergeInMenu')),
              )
            : null,
        );
      }

      return h(
        React.Fragment,
        null,
        h('div', {
          className: 'ferry-modal-backdrop',
          onMouseDown: () => {
            if (!busy) pullDialog.close();
          },
        }),
        h(
          'div',
          {
            className: 'ferry-modal',
            role: 'dialog',
            'aria-modal': 'true',
            'aria-labelledby': 'dsh-ferry-pull-title',
            tabIndex: -1,
            ref: dialogRef,
          },
          h(
            'div',
            { className: 'ferry-modal-head' },
            h('div', { className: 'ferry-modal-title', id: 'dsh-ferry-pull-title' }, t('pullDialogTitle')),
            h('div', { className: 'ferry-modal-session', title }, title),
          ),
          h('div', { className: 'ferry-modal-hint' }, t('pullDialogHint')),
          body,
          error !== null ? h('div', { className: 'ferry-modal-error' }, error) : null,
          h(
            'div',
            { className: 'ferry-modal-foot' },
            h('span', { className: 'ferry-spacer' }),
            h(
              'button',
              { type: 'button', className: 'ferry-btn', disabled: busy, onClick: () => pullDialog.close() },
              t('cancel'),
            ),
            h(
              'button',
              {
                type: 'button',
                className: 'ferry-btn primary',
                disabled: busy || plan === null || blocked || (mode === 'update' && !canAppend),
                onClick: submit,
              },
              busy ? t('pulling') : t('confirmPull'),
            ),
          ),
        ),
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
      ctx.effect(() => installStyles());
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
        ctx.slots.register({ name: 'shell.overlay', id: 'dsh-ferry-push-dialog', order: 90, locale: ns }, PushDialogHost),
      );
      ctx.slots.inject('shell.overlay', () =>
        ctx.slots.register({ name: 'shell.overlay', id: 'dsh-ferry-pull-dialog', order: 91, locale: ns }, PullDialogHost),
      );
      ctx.slots.inject('shell.overlay', () =>
        ctx.slots.register({ name: 'shell.overlay', id: 'dsh-ferry-toast', order: 100, locale: ns }, ToastHost),
      );
    }

    return { inject, apply };
  },
});
