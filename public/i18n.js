// One dictionary for the whole product. The browser imports this file as
// a static asset; the Worker bundles the same file, so server-rendered
// pages and client-rendered pages can never drift apart.

export const MESSAGES = {
  zh: {
    'nav.archive': '归档',
    'nav.settings': '设置',
    'nav.write': '继续书写',
    'nav.menu': '菜单',
    'common.untitled': '未命名',
    'common.locked': '这台 Writer 已上锁，请先<a href="/unlock">解锁</a>。',
    'common.offline': '暂时无法连接，稍后刷新试试。',

    'editor.placeholder': '开始书写…',
    'editor.finish': '完成',
    'editor.finishHint': '完成并归档（⌘⏎）',
    'editor.hint': 'Tab 采纳建议 · ⌘⏎ 完成归档 · 静置片刻自动归档',
    'editor.ready': '就绪',
    'editor.saving': '保存中…',
    'editor.saved': '已保存 {time}',
    'editor.offline': '离线 · 已本地备份',
    'editor.keyNeeded': '需要密钥',
    'editor.yielded': '已在另一标签页继续',
    'editor.toastArchiving': '已交给 AI 整理 · <a href="/archive">前往归档</a>',
    'editor.toastEmpty': '还没有内容',
    'editor.toastSaveFailed': '保存未完成，暂不归档',
    'editor.toastFailed': '归档失败，稍后再试',
    'editor.toastOtherTab': '这篇草稿已在另一个标签页打开 · 点击纸面接管',

    'archive.title': '归档',
    'archive.sub': '写完的内容由 Agent 自动分类、解析与排版，静静躺在这里。',
    'archive.search': '检索档案…',
    'archive.empty': '还没有归档。去<a href="/">写点什么</a>吧。',
    'archive.noResults': '没有找到相关内容。',
    'archive.results': '检索结果',
    'archive.processing': 'Agent 正在整理这篇内容…',
    'archive.toastDeleted': '已移到回收站 · <button type="button" id="undo">撤销</button>',
    'archive.toastRestoreFailed': '恢复失败，可在设置的回收站里重试',

    'reader.filingTitle': '整理中',
    'reader.filing': 'Agent 正在整理这篇内容，稍候片刻。',
    'reader.notFoundTitle': '未找到',
    'reader.notFound': '没有找到这篇内容。',
    'reader.backToArchive': '回到归档',
    'reader.download': '下载 .md',
    'reader.edit': '修改',
    'reader.delete': '删除',
    'reader.trace': 'Agent 处理轨迹（{n} 轮）',
    'reader.traceTurn': '第 {n} 轮',
    'reader.traceThinking': '思考',
    'reader.traceError': '出错，已用兜底规则归档',
    'reader.confirmDelete': '把这篇移到回收站？可以在设置里恢复。',
    'reader.editBusy': 'Agent 正在整理这篇，稍后再试',
    'reader.editUnavailable': '这篇无法修改',
    'reader.editFailed': '打开失败，稍后再试',
    'reader.deleteFailed': '删除失败，稍后再试',

    'unlock.title': '解锁',
    'unlock.locked': '这台 Writer 已上锁。',
    'unlock.error': '密钥不正确。',
    'unlock.placeholder': '访问密钥',
    'unlock.submit': '解锁',

    'settings.title': '设置',
    'settings.sub': '这些偏好保存在你的 Writer 实例上，换设备打开也一致。',
    'settings.groupWriting': '书写',
    'settings.groupAI': 'AI 辅助',
    'settings.groupArchive': '归档',
    'settings.language': '界面语言',
    'settings.languageDesc': '默认是英文；自动模式跟随浏览器语言',
    'settings.fontSize': '正文字号',
    'settings.fontSizeDesc': '纸面与阅读页的正文大小',
    'settings.theme': '主题',
    'settings.themeDesc': '默认跟随系统的浅色或深色',
    'settings.completion': '输入联想',
    'settings.completionDesc': '停顿时给出灰色的续写建议，Tab 采纳',
    'settings.completionDelay': '联想灵敏度',
    'settings.completionDelayDesc': '停顿多久之后给出建议',
    'settings.agentFormatting': 'Agent 排版',
    'settings.agentFormattingDesc': '归档时整理分段与列表。关闭后只做分类与摘要，原文一字不动',
    'settings.idleArchive': '静置自动归档',
    'settings.idleArchiveDesc': '停笔多久后自动交给 Agent 整理',
    'settings.trash': '回收站',
    'settings.trashNote': '删除的内容会留在这里，随时可以恢复。彻底删除会同时移除已归档的 Markdown 文件，无法撤销。',
    'settings.trashEmpty': '回收站是空的。',
    'settings.restore': '恢复',
    'settings.erase': '彻底删除',
    'settings.deletedAt': '删除于 {date}',
    'settings.confirmErase': '彻底删除「{title}」？无法撤销。',
    'settings.toastRestored': '已恢复到归档',
    'settings.toastErased': '已彻底删除',
    'settings.toastActionFailed': '操作失败，稍后再试',
    'settings.toastSaveFailed': '保存失败，已还原',
    'settings.toastCached': '暂时无法连接，显示的是本地缓存',

    'opt.auto': '自动',
    'opt.small': '小',
    'opt.standard': '标准',
    'opt.large': '大',
    'opt.system': '跟随系统',
    'opt.light': '浅色',
    'opt.dark': '深色',
    'opt.on': '开',
    'opt.off': '关',
    'opt.eager': '灵敏',
    'opt.relaxed': '迟缓',
    'opt.never': '关闭',
    'opt.minutes': '{n} 分钟',
  },

  en: {
    'nav.archive': 'Archive',
    'nav.settings': 'Settings',
    'nav.write': 'Keep writing',
    'nav.menu': 'Menu',
    'common.untitled': 'Untitled',
    'common.locked': 'This Writer is locked. Please <a href="/unlock">unlock</a> it first.',
    'common.offline': 'Cannot reach the server. Try refreshing in a moment.',

    'editor.placeholder': 'Start writing…',
    'editor.finish': 'Finish',
    'editor.finishHint': 'Finish and archive (⌘⏎)',
    'editor.hint': 'Tab accepts · ⌘⏎ archives · idle pieces file themselves',
    'editor.ready': 'Ready',
    'editor.saving': 'Saving…',
    'editor.saved': 'Saved {time}',
    'editor.offline': 'Offline · backed up locally',
    'editor.keyNeeded': 'Key required',
    'editor.yielded': 'Continued in another tab',
    'editor.toastArchiving': 'Handed to the agent · <a href="/archive">go to the archive</a>',
    'editor.toastEmpty': 'Nothing written yet',
    'editor.toastSaveFailed': 'The save did not finish, so nothing was archived',
    'editor.toastFailed': 'Archiving failed, try again in a moment',
    'editor.toastOtherTab': 'This draft is open in another tab · click the page to take over',

    'archive.title': 'Archive',
    'archive.sub': 'Finished pieces, classified, parsed and typeset by the agent.',
    'archive.search': 'Search the archive…',
    'archive.empty': 'Nothing archived yet. Go <a href="/">write something</a>.',
    'archive.noResults': 'Nothing matched.',
    'archive.results': 'Results',
    'archive.processing': 'The agent is filing this piece…',
    'archive.toastDeleted': 'Moved to the trash · <button type="button" id="undo">Undo</button>',
    'archive.toastRestoreFailed': 'Restore failed. Try again from the trash in settings.',

    'reader.filingTitle': 'Filing',
    'reader.filing': 'The agent is filing this piece. One moment.',
    'reader.notFoundTitle': 'Not found',
    'reader.notFound': 'This piece was not found.',
    'reader.backToArchive': 'Back to the archive',
    'reader.download': 'Download .md',
    'reader.edit': 'Modify',
    'reader.delete': 'Delete',
    'reader.trace': 'Agent trace ({n} turns)',
    'reader.traceTurn': 'Turn {n}',
    'reader.traceThinking': 'thinking',
    'reader.traceError': 'failed, filed with fallback rules',
    'reader.confirmDelete': 'Move this piece to the trash? You can restore it in settings.',
    'reader.editBusy': 'The agent is filing this piece, try again shortly',
    'reader.editUnavailable': 'This piece cannot be modified',
    'reader.editFailed': 'Could not open it, try again in a moment',
    'reader.deleteFailed': 'Delete failed, try again in a moment',

    'unlock.title': 'Unlock',
    'unlock.locked': 'This Writer is locked.',
    'unlock.error': 'That key is not right.',
    'unlock.placeholder': 'Access key',
    'unlock.submit': 'Unlock',

    'settings.title': 'Settings',
    'settings.sub': 'These preferences live on your Writer instance, so they follow you to any device.',
    'settings.groupWriting': 'Writing',
    'settings.groupAI': 'AI assistance',
    'settings.groupArchive': 'Archiving',
    'settings.language': 'Interface language',
    'settings.languageDesc': 'English is the default; Auto follows your browser language',
    'settings.fontSize': 'Text size',
    'settings.fontSizeDesc': 'Body text on the page and in the reader',
    'settings.theme': 'Theme',
    'settings.themeDesc': 'Follows your system light or dark setting by default',
    'settings.completion': 'Inline suggestions',
    'settings.completionDesc': 'A grey continuation appears when you pause; Tab accepts it',
    'settings.completionDelay': 'Suggestion timing',
    'settings.completionDelayDesc': 'How long a pause has to be before a suggestion appears',
    'settings.agentFormatting': 'Agent typesetting',
    'settings.agentFormattingDesc': 'Let the agent fix paragraphs and lists. Off means it only classifies and summarizes, leaving your text untouched',
    'settings.idleArchive': 'Idle archiving',
    'settings.idleArchiveDesc': 'How long a pause files the piece automatically',
    'settings.trash': 'Trash',
    'settings.trashNote': 'Deleted pieces wait here and can be restored at any time. Deleting for good also removes the archived Markdown file and cannot be undone.',
    'settings.trashEmpty': 'The trash is empty.',
    'settings.restore': 'Restore',
    'settings.erase': 'Delete for good',
    'settings.deletedAt': 'Deleted {date}',
    'settings.confirmErase': 'Delete “{title}” for good? This cannot be undone.',
    'settings.toastRestored': 'Restored to the archive',
    'settings.toastErased': 'Deleted for good',
    'settings.toastActionFailed': 'That did not work, try again in a moment',
    'settings.toastSaveFailed': 'Could not save, reverted',
    'settings.toastCached': 'Cannot reach the server, showing the local cache',

    'opt.auto': 'Auto',
    'opt.small': 'Small',
    'opt.standard': 'Standard',
    'opt.large': 'Large',
    'opt.system': 'System',
    'opt.light': 'Light',
    'opt.dark': 'Dark',
    'opt.on': 'On',
    'opt.off': 'Off',
    'opt.eager': 'Eager',
    'opt.relaxed': 'Relaxed',
    'opt.never': 'Off',
    'opt.minutes': '{n} min',
  },
};

export const LANGS = ['zh', 'en'];

// `pref` is the stored setting (zh | en | auto); `hint` is whatever the
// environment offers: navigator.language in the browser, Accept-Language
// on the server.
export function resolveLang(pref, hint) {
  if (LANGS.includes(pref)) return pref;
  const h = String(hint || '').toLowerCase();
  if (!h) return 'en';
  return h.includes('zh') ? 'zh' : 'en';
}

export function makeT(lang) {
  const table = MESSAGES[lang] || MESSAGES.en;
  return function t(key, vars) {
    let s = table[key] ?? MESSAGES.en[key] ?? MESSAGES.zh[key] ?? key;
    if (vars) {
      for (const [name, value] of Object.entries(vars)) {
        s = s.replaceAll(`{${name}}`, String(value));
      }
    }
    return s;
  };
}

export function locale(lang) {
  return lang === 'en' ? 'en-US' : 'zh-CN';
}

// Fill a document from data-i18n attributes:
//   data-i18n            -> textContent (data-i18n-html for markup)
//   data-i18n-placeholder / -title / -aria-label -> that attribute
export function applyDom(root, t) {
  for (const el of root.querySelectorAll('[data-i18n]')) {
    el.textContent = t(el.dataset.i18n);
  }
  for (const el of root.querySelectorAll('[data-i18n-html]')) {
    el.innerHTML = t(el.dataset.i18nHtml);
  }
  for (const el of root.querySelectorAll('[data-i18n-placeholder]')) {
    el.placeholder = t(el.dataset.i18nPlaceholder);
  }
  for (const el of root.querySelectorAll('[data-i18n-title]')) {
    el.title = t(el.dataset.i18nTitle);
  }
}
