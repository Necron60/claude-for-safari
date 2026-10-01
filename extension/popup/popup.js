// Toolbar popup: write a question, optionally attach the current page or selection, and hand it to Claude.

const $ = (id) => document.getElementById(id);
const els = {
  form: $('ask-form'),
  prompt: $('prompt'),
  send: $('send'),
  includePage: $('include-page'),
  includeSelection: $('include-selection'),
  pageLabel: $('page-label'),
  pageChip: $('page-chip'),
  selectionChip: $('selection-chip'),
  selectionLabel: $('selection-label'),
  autoSend: $('auto-send'),
  banner: $('access-banner'),
};

let page = null;
let sourceTab = null;

init().catch((error) => console.error('[Claude for Safari]', error));

async function init() {
  const settings = await loadSettings();
  els.autoSend.checked = settings.autoSend;
  wireEvents();
  renderContext(); // everything page-related stays disabled until the tab has been read

  [sourceTab] = await ext.tabs.query({ active: true, currentWindow: true });
  if (sourceTab) page = (await readPage(sourceTab.id, settings.maxPageChars)) ?? pageFromTab(sourceTab);
  renderContext();
  if (!els.includePage.disabled) els.includePage.checked = settings.includePage;
  updateSendState();
  checkClaudeAccess();
}

function wireEvents() {
  els.form.addEventListener('submit', (event) => {
    event.preventDefault();
    const prompt = els.prompt.value.trim();
    ask({
      prompt,
      includePage: isOn(els.includePage),
      includeSelection: isOn(els.includeSelection),
      autoSend: els.autoSend.checked,
    });
  });

  els.prompt.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      if (!els.send.disabled) els.form.requestSubmit();
    }
  });

  els.prompt.addEventListener('input', () => {
    els.prompt.style.height = 'auto';
    els.prompt.style.height = `${els.prompt.scrollHeight}px`;
    updateSendState();
  });

  els.includePage.addEventListener('change', updateSendState);
  els.includeSelection.addEventListener('change', updateSendState);
  els.autoSend.addEventListener('change', () => saveSettings({ autoSend: els.autoSend.checked }));

  for (const button of document.querySelectorAll('[data-action]')) {
    button.addEventListener('click', () => runQuickAction(button.dataset.action));
  }

  $('open-claude').addEventListener('click', async () => {
    await ext.runtime.sendMessage({ type: 'open', sourceTab: tabRef(sourceTab) });
    window.close();
  });

  $('open-settings').addEventListener('click', () => {
    ext.runtime.openOptionsPage();
    window.close();
  });
}

function runQuickAction(name) {
  const action = QUICK_ACTIONS[name];
  if (!action) return;
  // Anything typed in the box is passed along as extra instructions.
  const extra = els.prompt.value.trim();
  ask({
    prompt: extra ? `${action.prompt}\n\n${extra}` : action.prompt,
    includePage: action.needs === 'page',
    includeSelection: action.needs === 'selection',
    autoSend: els.autoSend.checked,
  });
}

async function ask({ prompt, includePage, includeSelection, autoSend }) {
  const context = buildContext(page, { includePage, includeSelection });
  if (!prompt && !context) return;
  await ext.runtime.sendMessage({
    type: 'ask',
    job: { prompt, context, autoSend },
    sourceTab: tabRef(sourceTab),
  });
  window.close();
}

function renderContext() {
  const hasPage = Boolean(page?.url) && !page.url.startsWith(CLAUDE_ORIGIN);
  els.includePage.disabled = !hasPage;
  if (!hasPage) els.includePage.checked = false;
  els.pageChip.title = hasPage ? page.title : 'Nothing to share from this tab';
  els.pageLabel.textContent = page?.unreadable ? 'This page (link only)' : 'This page';

  const selection = page?.selection ?? '';
  els.selectionChip.hidden = !selection;
  els.includeSelection.checked = Boolean(selection);
  els.selectionLabel.textContent = `Selection · ${formatCount(selection.length)}`;
  els.selectionChip.title = selection.slice(0, 300);

  for (const button of document.querySelectorAll('[data-action]')) {
    const needs = QUICK_ACTIONS[button.dataset.action]?.needs;
    const available = needs === 'page' ? hasPage : Boolean(selection);
    button.disabled = !available;
    button.title = available ? '' : needs === 'page' ? 'Not available on this tab' : 'Select some text on the page first';
  }
  updateSendState();
}

function updateSendState() {
  const hasPrompt = els.prompt.value.trim().length > 0;
  els.send.disabled = !(hasPrompt || isOn(els.includePage) || isOn(els.includeSelection));
}

async function checkClaudeAccess() {
  let granted = true;
  try {
    granted = await ext.permissions.contains({ origins: [CLAUDE_MATCH] });
  } catch {
    // Some Safari versions don't report per-site access; assume it's fine.
  }
  if (granted) return;

  els.banner.hidden = false;
  $('grant-access').addEventListener('click', async () => {
    try {
      if (await ext.permissions.request({ origins: [CLAUDE_MATCH] })) els.banner.hidden = true;
    } catch (error) {
      console.warn('[Claude for Safari]', error);
    }
  });
}

function isOn(checkbox) {
  return checkbox.checked && !checkbox.disabled && !checkbox.closest('[hidden]');
}

function tabRef(tab) {
  return tab ? { id: tab.id, index: tab.index, windowId: tab.windowId } : null;
}

function formatCount(chars) {
  return chars < 1000 ? `${chars} chars` : `${(chars / 1000).toFixed(1).replace(/\.0$/, '')}k chars`;
}
