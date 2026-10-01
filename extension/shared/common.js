// Shared by the background page, popup and settings page (loaded as classic scripts).

const ext = globalThis.browser ?? globalThis.chrome;

const CLAUDE_ORIGIN = 'https://claude.ai';
const CLAUDE_MATCH = 'https://claude.ai/*';
const NEW_CHAT_URL = `${CLAUDE_ORIGIN}/new`;

const DEFAULT_SETTINGS = {
  openMode: 'tab', // 'tab' | 'reuse' | 'window'
  autoSend: true,
  includePage: false,
  maxPageChars: 60000,
};

const QUICK_ACTIONS = {
  summarize: {
    needs: 'page',
    prompt: 'Summarize this page. Start with a one-sentence overview, then list the key points.',
  },
  takeaways: {
    needs: 'page',
    prompt: 'What are the most important takeaways from this page? Point out anything that seems questionable, one-sided or missing.',
  },
  explain: {
    needs: 'selection',
    prompt: 'Explain this in plain language, and define any jargon.',
  },
  rewrite: {
    needs: 'selection',
    prompt: 'Improve this text so it is clearer and more concise, keeping its meaning and tone. Give the revised text first, then briefly list what you changed.',
  },
};

async function loadSettings() {
  const { settings } = await ext.storage.local.get('settings');
  return { ...DEFAULT_SETTINGS, ...(settings ?? {}) };
}

async function saveSettings(patch) {
  const settings = { ...(await loadSettings()), ...patch };
  await ext.storage.local.set({ settings });
  return settings;
}

// Injected into the web page with scripting.executeScript, so it must not use anything from this file.
function extractPageInfo(maxChars) {
  const clean = (s) => (s || '')
    .replace(/ /g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  let selection = clean(String(window.getSelection?.() ?? ''));
  const active = document.activeElement;
  if (!selection && active && typeof active.selectionStart === 'number' && typeof active.value === 'string') {
    selection = clean(active.value.slice(active.selectionStart, active.selectionEnd));
  }

  let text = '';
  if (maxChars > 0) {
    const articles = document.querySelectorAll('article');
    const root = (articles.length === 1 && articles[0])
      || document.querySelector('main, [role="main"]')
      || document.body;
    text = clean(root?.innerText);
    if (root !== document.body && text.length < 400) text = clean(document.body?.innerText);
  }

  const description = document
    .querySelector('meta[name="description"], meta[property="og:description"]')
    ?.getAttribute('content')?.trim() ?? '';

  return {
    title: document.title || location.hostname,
    url: location.href,
    description,
    selection,
    text: text.slice(0, maxChars),
    truncated: text.length > maxChars,
  };
}

// Returns null when Safari won't let the extension read the tab (Safari pages, PDFs, no permission).
async function readPage(tabId, maxChars) {
  try {
    const [injection] = await ext.scripting.executeScript({
      target: { tabId },
      func: extractPageInfo,
      args: [maxChars],
    });
    return injection?.result ?? null;
  } catch {
    return null;
  }
}

function pageFromTab(tab) {
  if (!tab?.url) return null;
  return { title: tab.title || tab.url, url: tab.url, description: '', selection: '', text: '', unreadable: true };
}

function escapeAttr(value) {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

function selectionBlock(selection, url) {
  return `<selected_text source="${escapeAttr(url)}">\n${selection}\n</selected_text>`;
}

function pageBlock(page) {
  const attrs = `title="${escapeAttr(page.title)}" url="${escapeAttr(page.url)}"${page.truncated ? ' truncated="true"' : ''}`;
  const body = page.text
    || page.description
    || '(The page text could not be read. Open the URL if you can browse the web.)';
  return `<webpage ${attrs}>\n${body}\n</webpage>`;
}

function buildContext(page, { includePage = false, includeSelection = false } = {}) {
  if (!page) return '';
  const blocks = [];
  if (includeSelection && page.selection) blocks.push(selectionBlock(page.selection, page.url));
  if (includePage) blocks.push(pageBlock(page));
  return blocks.join('\n\n');
}
