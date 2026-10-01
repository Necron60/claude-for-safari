// Background page: opens claude.ai and queues the prompt for the content script there to pick up.

const PENDING_TTL_MS = 10 * 60 * 1000; // long enough to sign in first
const SIDE_WINDOW_WIDTH = 480;
const sessionStore = ext.storage.session ?? ext.storage.local;

const MENU = {
  explain: 'explain-selection',
  ask: 'ask-selection',
  summarize: 'summarize-page',
  link: 'summarize-link',
};

async function setupMenus() {
  await ext.contextMenus.removeAll();
  ext.contextMenus.create({ id: MENU.explain, title: 'Explain with Claude', contexts: ['selection'] });
  ext.contextMenus.create({ id: MENU.ask, title: 'Ask Claude about “%s”', contexts: ['selection'] });
  ext.contextMenus.create({ id: MENU.summarize, title: 'Summarize Page with Claude', contexts: ['page'] });
  ext.contextMenus.create({ id: MENU.link, title: 'Summarize Link with Claude', contexts: ['link'] });
}

ext.runtime.onInstalled.addListener(setupMenus);
ext.runtime.onStartup?.addListener(setupMenus);

ext.contextMenus.onClicked.addListener(async (info, tab) => {
  const pageUrl = info.pageUrl ?? tab?.url ?? '';

  switch (info.menuItemId) {
    case MENU.explain:
    case MENU.ask: {
      // Prefer the selection read from the page, which keeps line breaks.
      const page = tab ? await readPage(tab.id, 0) : null;
      const selection = page?.selection || info.selectionText || '';
      const context = selectionBlock(selection, pageUrl);
      if (info.menuItemId === MENU.explain) {
        return askClaude({ prompt: QUICK_ACTIONS.explain.prompt, context }, tab);
      }
      return askClaude({ prompt: '', context, autoSend: false }, tab);
    }
    case MENU.summarize:
      return summarizePage(tab);
    case MENU.link:
      return askClaude({ prompt: `Summarize the page at this link: ${info.linkUrl}` }, tab);
  }
});

ext.commands?.onCommand.addListener(async (command, tab) => {
  tab ??= (await ext.tabs.query({ active: true, currentWindow: true }))[0];
  if (command === 'summarize-page') return summarizePage(tab);
  if (command === 'open-claude') return openClaude(null, tab);
});

ext.runtime.onMessage.addListener((message, sender) => {
  switch (message?.type) {
    case 'ask':
      return askClaude(message.job, message.sourceTab).then(() => ({ ok: true }));
    case 'open':
      return openClaude(null, message.sourceTab).then(() => ({ ok: true }));
    case 'peek-pending':
      return takePending(sender.tab?.id, false).then((job) => ({ pending: Boolean(job) }));
    case 'claim-pending':
      return takePending(sender.tab?.id, true).then((job) => ({ pending: job }));
  }
  return undefined;
});

ext.tabs.onRemoved.addListener((tabId) => {
  sessionStore.remove(pendingKey(tabId));
});

ext.windows?.onRemoved?.addListener(async (windowId) => {
  const { sideWindowId } = await sessionStore.get('sideWindowId');
  if (sideWindowId === windowId) await sessionStore.remove('sideWindowId');
});

async function summarizePage(tab) {
  if (!tab) return;
  const { maxPageChars } = await loadSettings();
  const page = (await readPage(tab.id, maxPageChars)) ?? pageFromTab(tab);
  if (!page) return openClaude(null, tab);
  return askClaude({ prompt: QUICK_ACTIONS.summarize.prompt, context: pageBlock(page) }, tab);
}

async function askClaude(job, sourceTab) {
  const settings = await loadSettings();
  const prompt = (job?.prompt ?? '').trim();
  const context = (job?.context ?? '').trim();
  if (!prompt && !context) return openClaude(null, sourceTab);

  return openClaude({
    prompt,
    context,
    autoSend: Boolean(prompt) && (job.autoSend ?? settings.autoSend),
    createdAt: Date.now(),
  }, sourceTab);
}

// Opens Claude according to the user's setting. With a job, Claude starts a new chat and the
// content script on claude.ai fills it in.
async function openClaude(job, sourceTab) {
  const { openMode } = await loadSettings();

  if (openMode === 'reuse') {
    const existing = await findClaudeTab();
    if (existing) return showInTab(existing, job);
  }

  if (openMode === 'window') {
    const sideTab = await findSideWindowTab();
    if (sideTab) return showInTab(sideTab, job);
    return openSideWindow(job, sourceTab);
  }

  const tab = await ext.tabs.create({
    url: NEW_CHAT_URL,
    active: true,
    ...(sourceTab ? { windowId: sourceTab.windowId, index: sourceTab.index + 1 } : {}),
  });
  if (job) await setPending(tab.id, job, true);
}

// Reuses an open claude.ai tab. It is navigated to a fresh chat only when there is a job,
// so the page's own content script picks the job up after the reload.
async function showInTab(tab, job) {
  if (job) {
    await setPending(tab.id, job, false);
    await ext.tabs.update(tab.id, { url: NEW_CHAT_URL, active: true });
  } else {
    await ext.tabs.update(tab.id, { active: true });
  }
  await ext.windows.update(tab.windowId, { focused: true });
}

async function findClaudeTab() {
  let tabs;
  try {
    tabs = await ext.tabs.query({ url: CLAUDE_MATCH });
  } catch {
    tabs = (await ext.tabs.query({})).filter((tab) => tab.url?.startsWith(`${CLAUDE_ORIGIN}/`));
  }
  if (!tabs.length) return null;

  const focused = await ext.windows.getLastFocused().catch(() => null);
  return tabs.find((tab) => tab.windowId === focused?.id && tab.active)
    ?? tabs.find((tab) => tab.windowId === focused?.id)
    ?? tabs[0];
}

async function findSideWindowTab() {
  const { sideWindowId } = await sessionStore.get('sideWindowId');
  if (sideWindowId == null) return null;
  try {
    const win = await ext.windows.get(sideWindowId, { populate: true });
    return win.tabs?.find((tab) => tab.active) ?? win.tabs?.[0] ?? null;
  } catch {
    await sessionStore.remove('sideWindowId');
    return null;
  }
}

// Safari has no sidebar API for extensions, so a narrow window along the right edge of the
// current window stands in for one.
async function openSideWindow(job, sourceTab) {
  const source = sourceTab ? await ext.windows.get(sourceTab.windowId).catch(() => null) : null;
  const bounds = source?.width
    ? {
        width: SIDE_WINDOW_WIDTH,
        height: source.height,
        top: source.top,
        left: Math.max(0, source.left + source.width - SIDE_WINDOW_WIDTH),
      }
    : { width: SIDE_WINDOW_WIDTH };

  let win;
  try {
    win = await ext.windows.create({ url: NEW_CHAT_URL, type: 'popup', focused: true, ...bounds });
  } catch {
    win = await ext.windows.create({ url: NEW_CHAT_URL, focused: true });
  }
  await sessionStore.set({ sideWindowId: win.id });

  const tab = win.tabs?.[0] ?? (await ext.tabs.query({ windowId: win.id }))[0];
  if (job && tab) await setPending(tab.id, job, true);
}

function pendingKey(tabId) {
  return `pending:${tabId}`;
}

// `notify` pings a freshly opened tab in case its content script already asked and found nothing.
// It must stay off for a tab that is about to navigate, or the old page could take the job.
async function setPending(tabId, job, notify) {
  await sessionStore.set({ [pendingKey(tabId)]: job });
  if (notify) ext.tabs.sendMessage(tabId, { type: 'pending-ready' }).catch(() => {});
}

async function takePending(tabId, consume) {
  if (tabId == null) return null;
  const key = pendingKey(tabId);
  const { [key]: job } = await sessionStore.get(key);
  if (!job) return null;
  if (Date.now() - job.createdAt > PENDING_TTL_MS) {
    await sessionStore.remove(key);
    return null;
  }
  if (consume) await sessionStore.remove(key);
  return job;
}
