// Settings page. Every change is saved as soon as it's made.

const form = document.getElementById('settings');
const saved = document.getElementById('saved');
let savedTimer;

init().catch((error) => console.error('[Claude for Safari]', error));

async function init() {
  const settings = await loadSettings();
  form.elements.openMode.value = settings.openMode;
  form.elements.autoSend.checked = settings.autoSend;
  form.elements.includePage.checked = settings.includePage;
  form.elements.maxPageChars.value = String(settings.maxPageChars);

  form.addEventListener('change', save);
  renderAccess();
}

async function save() {
  await saveSettings({
    openMode: form.elements.openMode.value,
    autoSend: form.elements.autoSend.checked,
    includePage: form.elements.includePage.checked,
    maxPageChars: Number(form.elements.maxPageChars.value),
  });
  saved.textContent = 'Saved';
  saved.style.opacity = '1';
  clearTimeout(savedTimer);
  savedTimer = setTimeout(() => { saved.style.opacity = '0'; }, 1500);
}

async function renderAccess() {
  const status = document.getElementById('access-status');
  const button = document.getElementById('grant-access');

  let granted = true;
  try {
    granted = await ext.permissions.contains({ origins: [CLAUDE_MATCH] });
  } catch {
    // Some Safari versions don't report per-site access; assume it's fine.
  }

  status.innerHTML = granted
    ? '<strong>Allowed</strong><small>The extension can fill in prompts on claude.ai.</small>'
    : '<strong>Not allowed yet</strong><small>Needed to put your prompt into Claude. Nothing else on claude.ai is read.</small>';
  button.hidden = granted;

  button.onclick = async () => {
    try {
      await ext.permissions.request({ origins: [CLAUDE_MATCH] });
    } catch (error) {
      console.warn('[Claude for Safari]', error);
    }
    renderAccess();
  };
}
