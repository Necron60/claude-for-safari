// Runs on claude.ai. Picks up a prompt queued by the extension and puts it into Claude's composer.
// claude.ai is localized and changes often, so nothing here depends on English labels alone, and
// every step has a fallback ending in a "copy prompt" button.

(() => {
  const ext = globalThis.browser ?? globalThis.chrome;
  const WAIT_FOR_COMPOSER_MS = 10 * 60 * 1000; // covers signing in first
  const COMPOSER_SELECTORS = [
    '[data-testid="chat-input"] [contenteditable="true"]',
    '[data-testid="chat-input"][contenteditable="true"]',
    'div.ProseMirror[contenteditable="true"]',
    'fieldset [contenteditable="true"]',
    'div[contenteditable="true"][role="textbox"]',
  ];
  const SEND_LABEL = /send|envoy|enviar|invia|verzend|verstuur|wyślij|odeslat|отправ|送信|发送|傳送|보내|gönder|skicka|lähetä/i;
  const STOP_LABEL = /stop|abbrechen|arrêter|detener|interrompi|停止|중지/i;

  let running = false;

  ext.runtime.onMessage.addListener((message) => {
    if (message?.type === 'pending-ready') run();
  });
  run();

  async function run() {
    if (running) return;
    running = true;
    try {
      const peek = await ext.runtime.sendMessage({ type: 'peek-pending' });
      if (!peek?.pending) return;
      if (!(await waitFor(findComposer, WAIT_FOR_COMPOSER_MS))) return;
      await sleep(400); // let the app finish hydrating so the composer isn't swapped out under us

      const claim = await ext.runtime.sendMessage({ type: 'claim-pending' });
      if (claim?.pending) await deliver(claim.pending);
    } catch (error) {
      console.warn('[Claude for Safari]', error);
    } finally {
      running = false;
    }
  }

  async function deliver(job) {
    const editor = findComposer();
    if (!editor) return offerCopy(job);

    const hadDraft = textOf(editor).length > 0;
    focusEnd(editor);
    if (hadDraft && !(await insert(editor, '\n\n'))) return offerCopy(job);

    if (job.context) {
      const before = textOf(editor);
      // Pasted rather than typed, so claude.ai can turn a long page into an attachment.
      if (!(await insert(editor, job.context, { preferPaste: true }))) return offerCopy(job);
      if (textOf(editor) !== before && !(await insert(editor, '\n\n'))) return offerCopy(job);
    }
    if (job.prompt && !(await insert(editor, job.prompt))) return offerCopy(job);

    if (job.autoSend && !hadDraft) {
      if (await send(editor)) return;
      return toast('Your prompt is ready. Press Return to send it.');
    }
    toast(hadDraft
      ? 'Added to your existing draft. Review it, then press Return to send.'
      : 'Prompt added. Press Return to send it.');
  }

  function findComposer() {
    for (const selector of COMPOSER_SELECTORS) {
      for (const element of document.querySelectorAll(selector)) {
        if (isVisible(element)) return element;
      }
    }
    return null;
  }

  function isVisible(element) {
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function textOf(editor) {
    return (editor?.innerText ?? '').replace(/​/g, '').trim();
  }

  function focusEnd(editor) {
    editor.focus();
    const range = document.createRange();
    range.selectNodeContents(editor.lastElementChild ?? editor);
    range.collapse(false);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  }

  async function insert(editor, text, { preferPaste = false } = {}) {
    editor.focus();
    if (preferPaste && paste(editor, text)) return true;

    const before = editor.innerText;
    if (document.execCommand('insertText', false, text)) {
      await sleep(60);
      if (editor.innerText !== before) return true;
    }
    return !preferPaste && paste(editor, text);
  }

  // A synthetic paste is handled by the editor's own paste logic. It reports success only when
  // the editor actually took the event.
  function paste(editor, text) {
    try {
      const data = new DataTransfer();
      data.setData('text/plain', text);
      const event = new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true });
      if (!event.clipboardData) return false;
      editor.dispatchEvent(event);
      return event.defaultPrevented;
    } catch {
      return false;
    }
  }

  async function send(editor) {
    // The send button stays disabled while a pasted attachment is processed.
    const deadline = Date.now() + 20000;
    let button = findSendButton(editor);
    while (button?.disabled && Date.now() < deadline) {
      await sleep(250);
      button = findSendButton(editor);
    }

    if (button && !button.disabled) {
      button.click();
      if (await wasSent(editor)) return true;
    }

    const current = findComposer() ?? editor;
    if (!textOf(current)) return false;
    pressEnter(current);
    return wasSent(current);
  }

  function findSendButton(editor) {
    let scope = editor.parentElement;
    for (let depth = 0; scope && depth < 8; depth += 1, scope = scope.parentElement) {
      const buttons = [...scope.querySelectorAll('button')].filter(isVisible);
      const labelled = buttons.find((button) => {
        const label = button.getAttribute('aria-label') ?? '';
        return SEND_LABEL.test(label) && !STOP_LABEL.test(label);
      });
      if (labelled) return labelled;
      const submit = buttons.find((button) => button.type === 'submit');
      if (submit) return submit;
    }
    return null;
  }

  function pressEnter(editor) {
    editor.focus();
    const init = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true };
    editor.dispatchEvent(new KeyboardEvent('keydown', init));
    editor.dispatchEvent(new KeyboardEvent('keyup', init));
  }

  // Claude clears the composer, or moves to /chat/…, as soon as a message goes out.
  async function wasSent(editor) {
    const startPath = location.pathname;
    for (let waited = 0; waited < 4000; waited += 200) {
      await sleep(200);
      if (location.pathname !== startPath) return true;
      const current = findComposer();
      if (!editor.isConnected && current && !textOf(current)) return true;
      if (editor.isConnected && !textOf(editor)) return true;
    }
    return false;
  }

  function offerCopy(job) {
    const text = [job.context, job.prompt].filter(Boolean).join('\n\n');
    toast("Couldn't add your prompt automatically.", {
      label: 'Copy prompt',
      run: () => copyText(text),
      done: 'Copied. Paste it with ⌘V.',
    });
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const area = document.createElement('textarea');
      area.value = text;
      area.style.cssText = 'position:fixed;opacity:0;pointer-events:none';
      document.body.append(area);
      area.select();
      document.execCommand('copy');
      area.remove();
    }
  }

  function toast(message, action) {
    document.getElementById('claude-for-safari-toast')?.remove();
    const host = document.createElement('div');
    host.id = 'claude-for-safari-toast';
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = `
      <style>
        .toast {
          position: fixed; right: 20px; bottom: 20px; z-index: 2147483647;
          display: flex; align-items: center; gap: 12px; max-width: 380px;
          padding: 10px 12px 10px 14px; border-radius: 12px;
          font: 13px/1.4 -apple-system, BlinkMacSystemFont, system-ui, sans-serif;
          color: #faf9f5; background: #30302e; box-shadow: 0 8px 30px rgba(0, 0, 0, .25);
          animation: in .18s ease-out;
        }
        button {
          flex: none; font: inherit; font-weight: 600; cursor: pointer;
          color: #1f1e1d; background: #d97757; border: 0; border-radius: 8px; padding: 5px 10px;
        }
        .close { background: transparent; color: #a6a39a; padding: 2px 4px; font-size: 16px; line-height: 1; }
        @keyframes in { from { opacity: 0; transform: translateY(6px); } }
      </style>
      <div class="toast" role="status"><span class="message"></span></div>`;
    const box = root.querySelector('.toast');
    const text = root.querySelector('.message');
    text.textContent = message;

    if (action) {
      const button = document.createElement('button');
      button.textContent = action.label;
      button.addEventListener('click', async () => {
        await action.run();
        text.textContent = action.done;
        button.remove();
        setTimeout(() => host.remove(), 2500);
      });
      const close = document.createElement('button');
      close.className = 'close';
      close.setAttribute('aria-label', 'Dismiss');
      close.textContent = '×';
      close.addEventListener('click', () => host.remove());
      box.append(button, close);
    } else {
      setTimeout(() => host.remove(), 4500);
    }
    document.documentElement.append(host);
  }

  function waitFor(find, timeout) {
    return new Promise((resolve) => {
      let scheduled = false;
      const finish = (value) => {
        observer.disconnect();
        clearInterval(poll);
        clearTimeout(timer);
        resolve(value);
      };
      const check = () => {
        scheduled = false;
        const found = find();
        if (found) finish(found);
      };
      const observer = new MutationObserver(() => {
        if (!scheduled) {
          scheduled = true;
          requestAnimationFrame(check);
        }
      });
      observer.observe(document.documentElement, { childList: true, subtree: true });
      const poll = setInterval(check, 1000);
      const timer = setTimeout(() => finish(null), timeout);
      check();
    });
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
})();
