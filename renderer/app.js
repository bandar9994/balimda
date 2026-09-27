// Balimda — © 2026 Bandar Altariqi. All rights reserved.
// Licensed under the Balimda License (see LICENSE): non-commercial use only;
// keep the Balimda name and the "Balimda by Bandar Altariqi" credit; no rebranding.

/* global marked, DOMPurify */
'use strict';

const api = window.balimda;

const S = {
  settings: null,
  info: null,
  state: {},
  chats: [],            // sidebar list (metadata)
  query: '',
  current: null,        // open chat object, or null for a fresh "new chat" screen
  cache: new Map(),     // chat id -> chat object
  requests: new Map(),  // requestId -> { chat, msg }
  models: {},           // provider id -> [model names]
  modelErrors: {},
  newChatAssistantId: null,
  newChatModel: null,
  sync: null            // sync status from api.sync
};

const $ = (sel) => document.querySelector(sel);
const el = {
  app: $('#app'),
  chatList: $('#chatList'),
  search: $('#searchInput'),
  title: $('#chatTitle'),
  assistantSelect: $('#assistantSelect'),
  modelSelect: $('#modelSelect'),
  messages: $('#messages'),
  input: $('#input'),
  sendBtn: $('#sendBtn'),
  hint: $('#composerHint'),
  chatMenu: $('#chatMenu'),
  modalRoot: $('#modalRoot'),
  toast: $('#toast')
};

marked.setOptions({ gfm: true, breaks: true });

// ---------------------------------------------------------------------------
// helpers

function h(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (k === 'value') node.value = v;
    else if (k === 'checked') node.checked = !!v;
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

function uid() {
  return crypto.randomUUID();
}

function debounce(fn, ms) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

let toastTimer;
function toast(msg, ms = 2600) {
  el.toast.textContent = msg;
  el.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.toast.hidden = true; }, ms);
}

function modelKey(m) {
  return m && m.provider && m.model ? `${m.provider}::${m.model}` : '';
}

function parseModelKey(key) {
  const i = key.indexOf('::');
  return i < 0 ? null : { provider: key.slice(0, i), model: key.slice(i + 2) };
}

function displayModel(name) {
  return String(name).replace(/\.gguf$/i, '');
}

// Ownership and license, shown on the About page. See LICENSE.
const AUTHOR = 'Bandar Altariqi';
const PROJECT_URL = 'https://github.com/bandar9994/balimda';
const COPYRIGHT = `© 2026 ${AUTHOR}. All rights reserved.`;
const COMMERCIAL_URL = `${PROJECT_URL}/issues/new?template=commercial-license.yml`;
const SUPPORT_URL = 'https://ko-fi.com/bandaraltariqi';

function appName() {
  return (S.info && S.info.appName) || 'Balimda';
}

function providerLabel(id) {
  return (S.info && S.info.providers[id]) || id;
}

function splitThinking(text) {
  const m = String(text || '').match(/^\s*<think>([\s\S]*?)(<\/think>|$)/);
  if (!m) return { thinking: null, answer: text || '' };
  return { thinking: m[1].trim(), done: !!m[2], answer: text.slice(m[0].length) };
}

function renderMarkdown(text) {
  const html = DOMPurify.sanitize(marked.parse(text || ''));
  const wrap = h('div');
  wrap.innerHTML = html;
  // Arabic (and other right-to-left) paragraphs read right to left, each on
  // its own, so a mixed reply lays out naturally. Code stays left to right.
  for (const block of wrap.querySelectorAll('p, li, h1, h2, h3, h4, h5, h6, blockquote, td, th')) block.setAttribute('dir', 'auto');
  for (const pre of wrap.querySelectorAll('pre')) {
    pre.setAttribute('dir', 'ltr');
    const btn = h('button', { class: 'copy-code', text: 'Copy' });
    btn.addEventListener('click', () => {
      navigator.clipboard.writeText(pre.querySelector('code')?.innerText ?? pre.innerText.replace(/Copy$/, ''));
      btn.textContent = 'Copied';
      setTimeout(() => { btn.textContent = 'Copy'; }, 1200);
    });
    pre.append(btn);
  }
  return wrap;
}

function getAssistant(id) {
  const list = S.settings.assistants;
  return list.find((p) => p.id === id) || list[0] || { id: 'none', name: 'Assistant', emoji: '🤖', systemPrompt: '' };
}

function isStreaming(chat) {
  if (!chat) return false;
  for (const r of S.requests.values()) if (r.chat === chat) return true;
  return false;
}

// ---------------------------------------------------------------------------
// modal helpers

function openModal({ title, body, buttons = [], wide = false, onClose }) {
  const close = () => {
    backdrop.remove();
    document.removeEventListener('keydown', onKey, true);
    if (onClose) onClose();
  };
  const onKey = (e) => {
    if (e.key === 'Escape' && el.modalRoot.lastElementChild === backdrop) {
      e.stopPropagation();
      close();
    }
  };
  const foot = buttons.length
    ? h('div', { class: 'modal-foot' }, buttons.map((b) =>
      h('button', {
        class: `btn ${b.primary ? 'primary' : ''} ${b.danger ? 'danger' : ''}`,
        text: b.label,
        onclick: async () => {
          const keep = b.onClick ? await b.onClick() : undefined;
          if (keep !== false) close();
        }
      })))
    : null;
  const modal = h('div', { class: `modal ${wide ? 'wide' : ''}`, role: 'dialog' },
    h('div', { class: 'modal-head' },
      h('h3', { text: title }),
      h('button', { class: 'icon-btn', title: 'Close', text: '✕', onclick: close })),
    h('div', { class: 'modal-body' }, body),
    foot);
  const backdrop = h('div', { class: 'modal-backdrop', onmousedown: (e) => { if (e.target === backdrop) close(); } }, modal);
  el.modalRoot.append(backdrop);
  document.addEventListener('keydown', onKey, true);
  const first = modal.querySelector('input, textarea, select');
  if (first) setTimeout(() => first.focus(), 0);
  return close;
}

function askText({ title, label, value = '', multiline = false, placeholder = '' }) {
  return new Promise((resolve) => {
    let result = null;
    const input = multiline
      ? h('textarea', { class: 'input', rows: 8, value, placeholder })
      : h('input', { class: 'input', value, placeholder });
    const submit = () => { result = input.value; close(); };
    if (!multiline) input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
    const close = openModal({
      title,
      body: h('div', { class: 'field' }, label ? h('label', { text: label }) : null, input),
      buttons: [
        { label: 'Cancel' },
        { label: 'Save', primary: true, onClick: () => { result = input.value; } }
      ],
      onClose: () => resolve(result)
    });
    setTimeout(() => { input.focus(); input.select?.(); }, 0);
  });
}

function confirmBox(message, okLabel = 'Delete') {
  return new Promise((resolve) => {
    let ok = false;
    openModal({
      title: 'Are you sure?',
      body: h('p', { text: message }),
      buttons: [
        { label: 'Cancel' },
        { label: okLabel, danger: true, onClick: () => { ok = true; } }
      ],
      onClose: () => resolve(ok)
    });
  });
}

// ---------------------------------------------------------------------------
// persistence

const saveTimers = new Map();

async function saveChatNow(chat) {
  clearTimeout(saveTimers.get(chat.id));
  saveTimers.delete(chat.id);
  await api.chats.save(chat);
  await refreshList();
}

function saveChatSoon(chat, ms = 1200) {
  if (saveTimers.has(chat.id)) return;
  saveTimers.set(chat.id, setTimeout(() => {
    saveTimers.delete(chat.id);
    saveChatNow(chat);
  }, ms));
}

const persistDrafts = debounce(() => api.state.save({ drafts: S.state.drafts }), 400);

// Unsent text is kept per chat, in memory right away and on disk shortly after.
function saveDraft(key, text) {
  const drafts = { ...(S.state.drafts || {}) };
  if (text) drafts[key] = text;
  else delete drafts[key];
  S.state.drafts = drafts;
  persistDrafts();
}

function draftKey() {
  return S.current ? S.current.id : '__new__';
}

const saveSettings = debounce(async () => {
  await api.settings.save(S.settings);
}, 300);

// ---------------------------------------------------------------------------
// sidebar

async function refreshList() {
  S.chats = S.query ? await api.chats.search(S.query) : await api.chats.list();
  renderSidebar();
}

function groupLabel(ts) {
  const day = 86400000;
  const startOfToday = new Date().setHours(0, 0, 0, 0);
  if (ts >= startOfToday) return 'Today';
  if (ts >= startOfToday - day) return 'Yesterday';
  if (ts >= startOfToday - 7 * day) return 'Previous 7 days';
  if (ts >= startOfToday - 30 * day) return 'Previous 30 days';
  return new Date(ts).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
}

function renderSidebar() {
  el.chatList.replaceChildren();
  if (!S.chats.length) {
    el.chatList.append(h('div', { class: 'empty-list', text: S.query ? 'No chats match your search.' : 'No chats yet. Start one!' }));
    return;
  }
  let lastGroup = null;
  for (const c of S.chats) {
    const group = c.pinned ? '📌 Pinned' : groupLabel(c.updatedAt || 0);
    if (group !== lastGroup) {
      el.chatList.append(h('div', { class: 'group-label', text: group }));
      lastGroup = group;
    }
    const cached = S.cache.get(c.id);
    const item = h('div', {
      class: `chat-item ${S.current && S.current.id === c.id ? 'active' : ''}`,
      role: 'button',
      tabindex: 0,
      title: c.title,
      onclick: () => openChat(c.id),
      onkeydown: (e) => { if (e.key === 'Enter') openChat(c.id); }
    },
    h('div', { class: 'ci-body' },
      h('div', { class: 'ci-title', dir: 'auto', text: c.title }),
      c.preview ? h('div', { class: 'ci-preview', dir: 'auto', text: c.preview }) : null),
    cached && isStreaming(cached) ? h('span', { class: 'ci-dot', title: 'Replying…' }) : null,
    h('button', {
      class: 'ci-del',
      title: 'Delete chat',
      text: '🗑',
      onclick: (e) => { e.stopPropagation(); deleteChat(c.id); }
    }));
    el.chatList.append(item);
  }
}

// ---------------------------------------------------------------------------
// models & assistants selectors

function errorText(err) {
  return String(err.message || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
}

// Providers this platform supports, in display order.
function providerIds() {
  return Object.keys(S.info.providers).filter((id) => S.settings.providers[id]);
}

async function loadModels() {
  const providers = S.settings.providers;
  const ids = providerIds().filter((id) => {
    const p = providers[id];
    if (!p.enabled) return false;
    if ((id === 'anthropic' || id === 'openai') && !p.apiKey) return false;
    return true;
  });
  const models = {};
  const errors = {};
  await Promise.all(ids.map(async (id) => {
    try {
      models[id] = await api.ai.models(id);
    } catch (err) {
      errors[id] = errorText(err);
    }
  }));
  S.models = {};
  for (const id of ids) if (models[id]) S.models[id] = models[id];
  S.modelErrors = errors;
  ensureDefaultModel();
  renderSelectors();
  updateComposer();
  if (!S.current) renderChat();
}

function allModels() {
  const out = [];
  for (const [provider, list] of Object.entries(S.models)) for (const model of list) out.push({ provider, model });
  return out;
}

function ensureDefaultModel() {
  const def = S.settings.defaultModel;
  const available = allModels();
  if (def && def.model && (!S.models[def.provider] || S.models[def.provider].includes(def.model))) return;
  const preferred = available.find((m) => m.provider === 'onDevice') ||
    available.find((m) => m.model === 'claude-opus-5') || available[0];
  if (preferred) {
    S.settings.defaultModel = preferred;
    saveSettings();
  }
}

// A phone and a computer rarely have the same models, so each chat remembers
// the model to use on each device (chat.models, keyed by this device's id).
// chat.model is the model of the latest reply, from whichever device.
const LOCAL_PROVIDERS = new Set(['ollama', 'openaiCompatible', 'onDevice', 'computer', 'hermes']);

// Hermes Agent, used directly or through the computer the phone is using.
// It keeps its own memory and runs tools, so it's treated differently.
const isAgent = (m) => !!m && (m.provider === 'hermes' || (m.provider === 'computer' && /, Hermes Agent\)$/.test(m.model || '')));
const shareMemoryWith = (m) => !isAgent(m) || !!(S.settings.providers.hermes && S.settings.providers.hermes.shareMemory);

const sameModel = (a, b) => !!a && !!b && a.provider === b.provider && a.model === b.model;

// Whether this device can use a model right now. Until the model lists have
// loaded, any enabled provider counts.
function modelAvailable(m) {
  if (!m || !m.provider || !m.model) return false;
  if (!S.info.providers[m.provider]) return false;
  const cfg = S.settings.providers[m.provider];
  if (!cfg || cfg.enabled === false) return false;
  if ((m.provider === 'anthropic' || m.provider === 'openai') && !cfg.apiKey) return false;
  if (S.modelErrors[m.provider]) return false;
  const list = S.models[m.provider];
  if (LOCAL_PROVIDERS.has(m.provider) && Array.isArray(list) && list.length) return list.includes(m.model);
  return true;
}

// The model a chat uses on this device: this device's own choice for the
// chat, else the chat's latest model, the assistant's model or this device's
// default -- whichever this device can actually run.
function chatModel(chat) {
  const assistant = getAssistant(chat.assistantId);
  return [(chat.models || {})[S.state.deviceId], chat.model, assistant.model, S.settings.defaultModel].find(modelAvailable) || null;
}

function useModel(chat, model) {
  chat.model = model;
  chat.models = { ...(chat.models || {}), [S.state.deviceId]: model };
}

// Explains why a chat isn't using the model it used last time.
function modelNote(chat, model) {
  if (!chat) return '';
  const mine = (chat.models || {})[S.state.deviceId];
  if (!model) {
    const wanted = mine || chat.model;
    if (!wanted) return '';
    if (wanted.provider === 'computer') return `${displayModel(wanted.model)} isn't available right now. Check that the computer is on with Balimda open and on the same Wi-Fi, or pick another model at the top.`;
    return `${displayModel(wanted.model)} isn't available right now. Check that ${providerLabel(wanted.provider)} is running, or pick another model at the top.`;
  }
  if (mine && !sameModel(mine, model)) {
    return `${displayModel(mine.model)} isn't available right now, so this chat is using ${displayModel(model.model)}.`;
  }
  if (!mine && chat.model && !sameModel(chat.model, model) && chat.messages.length) {
    return `The last reply used ${displayModel(chat.model.model)}, which isn't on this device. Continuing here with ${displayModel(model.model)}.`;
  }
  return '';
}

function currentModel() {
  if (S.current) return chatModel(S.current);
  const assistant = getAssistant(currentAssistantId());
  const candidates = [S.newChatModel, assistant.model, S.settings.defaultModel];
  return candidates.find(modelAvailable) || candidates.find((m) => m && m.model) || null;
}

function currentAssistantId() {
  if (S.current) return S.current.assistantId || 'default';
  return S.newChatAssistantId || S.state.lastAssistantId || S.settings.assistants[0]?.id || 'default';
}

function modelOptions(selected, { includeCustom = true } = {}) {
  const frag = document.createDocumentFragment();
  const selKey = modelKey(selected);
  let found = false;
  for (const [provider, list] of Object.entries(S.models)) {
    if (!list.length) continue;
    const group = h('optgroup', { label: providerLabel(provider) });
    for (const model of list) {
      const key = `${provider}::${model}`;
      if (key === selKey) found = true;
      group.append(h('option', { value: key, text: displayModel(model) }));
    }
    frag.append(group);
  }
  if (selKey && !found) {
    frag.prepend(h('option', { value: selKey, text: `${displayModel(selected.model)} (${providerLabel(selected.provider)})` }));
  }
  if (!selKey) frag.prepend(h('option', { value: '', text: 'Choose a model…' }));
  if (includeCustom) frag.append(h('option', { value: '__custom__', text: '✎ Enter a model name…' }));
  return frag;
}

function renderSelectors() {
  const model = currentModel();
  el.modelSelect.replaceChildren(modelOptions(model));
  el.modelSelect.value = modelKey(model);

  el.assistantSelect.replaceChildren(...S.settings.assistants.map((p) => h('option', { value: p.id, text: `${p.emoji || '🤖'} ${p.name}` })));
  el.assistantSelect.value = currentAssistantId();
}

async function pickCustomModel() {
  return new Promise((resolve) => {
    let result = null;
    const provider = h('select', { class: 'select' },
      Object.keys(S.settings.providers).map((id) => h('option', { value: id, text: providerLabel(id) })));
    const name = h('input', { class: 'input', placeholder: 'e.g. llama3.2, qwen3:8b, claude-opus-5' });
    openModal({
      title: 'Use a model by name',
      body: h('div', {},
        h('div', { class: 'field' }, h('label', { text: 'Provider' }), provider),
        h('div', { class: 'field' }, h('label', { text: 'Model name' }), name,
          h('div', { class: 'help', text: 'Useful when a model is not listed yet, or the server is offline right now.' }))),
      buttons: [
        { label: 'Cancel' },
        {
          label: 'Use model',
          primary: true,
          onClick: () => {
            if (!name.value.trim()) return false;
            result = { provider: provider.value, model: name.value.trim() };
          }
        }
      ],
      onClose: () => resolve(result)
    });
  });
}

async function onModelChange() {
  let chosen;
  if (el.modelSelect.value === '__custom__') {
    chosen = await pickCustomModel();
    if (!chosen) {
      renderSelectors();
      return;
    }
  } else {
    chosen = parseModelKey(el.modelSelect.value);
  }
  if (!chosen) return;
  if (S.current) {
    useModel(S.current, chosen);
    saveChatNow(S.current);
  } else {
    S.newChatModel = chosen;
  }
  // The last model you picked becomes the default for new chats.
  S.settings.defaultModel = chosen;
  saveSettings();
  renderSelectors();
}

function onAssistantChange() {
  const assistantId = el.assistantSelect.value;
  S.state.lastAssistantId = assistantId;
  api.state.save({ lastAssistantId: assistantId });
  if (S.current) {
    S.current.assistantId = assistantId;
    saveChatNow(S.current);
  } else {
    S.newChatAssistantId = assistantId;
    const assistant = getAssistant(assistantId);
    if (assistant.model && assistant.model.model) S.newChatModel = assistant.model;
  }
  renderSelectors();
  renderChat();
}

// ---------------------------------------------------------------------------
// chat view

function renderChat() {
  const chat = S.current;
  el.title.textContent = chat ? chat.title : 'New chat';
  document.title = chat ? `${chat.title} — ${appName()}` : appName();
  renderSelectors();
  updateComposer();
  el.messages.replaceChildren();

  if (!chat || !chat.messages.length) {
    el.messages.append(renderWelcome());
    return;
  }
  const wrap = h('div', { class: 'msg-wrap' });
  chat.messages.forEach((m, i) => wrap.append(renderMessage(chat, m, i)));
  el.messages.append(wrap);
}

function renderWelcome() {
  const assistantId = currentAssistantId();
  const cards = h('div', { class: 'assistant-cards' }, S.settings.assistants.map((p) =>
    h('div', {
      class: `assistant-card ${p.id === assistantId ? 'selected' : ''}`,
      onclick: () => { el.assistantSelect.value = p.id; onAssistantChange(); focusInput(); }
    },
    h('div', { class: 'pc-name', text: `${p.emoji || '🤖'} ${p.name}` }),
    h('div', { class: 'pc-desc', text: p.systemPrompt || 'No instructions' }))));

  const hasModels = allModels().length > 0;
  const errors = Object.entries(S.modelErrors);
  const notice = hasModels ? null : S.info.mobile ? h('div', { class: 'notice' },
    h('strong', { text: 'Get your first model' }),
    h('p', { text: 'Download a small model to chat privately and offline, right on this phone. Or connect to Claude, OpenAI, or Ollama / LM Studio on your computer.' }),
    errors.length ? h('p', { class: 'mono', text: errors.map(([p, e]) => `${providerLabel(p)}: ${e}`).join('\n') }) : null,
    h('div', { class: 'field-row' },
      h('button', { class: 'btn primary', text: 'Download a model', onclick: () => openSettings('providers') }),
      h('button', { class: 'btn', text: 'Retry', onclick: loadModels }))) : h('div', { class: 'notice' },
    h('strong', { text: 'No models found yet.' }),
    h('p', { text: `${appName()} talks to AI models running on your computer or in the cloud:` }),
    h('ul', {},
      h('li', { text: 'Local & private: install Ollama (ollama.com), then run "ollama pull llama3.2" in a terminal.' }),
      h('li', { text: 'Local with a GUI: start LM Studio\'s local server (port 1234).' }),
      h('li', { text: 'Cloud: add an Anthropic (Claude) or OpenAI API key in Settings → Providers.' })),
    errors.length ? h('p', { class: 'mono', text: errors.map(([p, e]) => `${providerLabel(p)}: ${e}`).join('\n') }) : null,
    h('div', { class: 'field-row' },
      h('button', { class: 'btn primary', text: 'Open settings', onclick: () => openSettings('providers') }),
      h('button', { class: 'btn', text: 'Retry', onclick: loadModels })));

  return h('div', { class: 'welcome' },
    h('h2', { text: 'Who would you like to talk to?' }),
    h('p', { text: 'Pick an assistant, choose a model at the top, and start typing. Every chat is saved and remembered.' }),
    cards,
    notice);
}

function renderMessage(chat, msg, index) {
  const isUser = msg.role === 'user';
  const assistant = getAssistant(chat.assistantId);
  const content = h('div', { class: 'content', dir: isUser ? 'auto' : null });
  fillContent(content, msg);

  const actions = h('div', { class: 'actions' });
  actions.append(h('button', {
    text: 'Copy',
    onclick: () => { navigator.clipboard.writeText(splitThinking(msg.content).answer.trim()); toast('Copied'); }
  }));
  if (isUser) {
    actions.append(h('button', { text: 'Edit', onclick: () => startEdit(chat, msg, node) }));
    actions.append(h('button', { text: 'Remember', title: 'Add this to memory', onclick: () => rememberText(msg.content) }));
  } else {
    const isLast = index === chat.messages.length - 1;
    if (isLast) actions.append(h('button', { text: 'Regenerate', onclick: () => regenerate(chat) }));
    actions.append(h('button', { text: 'Delete', onclick: () => deleteMessage(chat, msg) }));
  }

  const when = msg.createdAt ? new Date(msg.createdAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '';
  const node = h('div', { class: `msg ${msg.role}`, 'data-id': msg.id },
    h('div', { class: 'avatar', text: isUser ? 'You' : (assistant.emoji || '🤖') }),
    h('div', { class: 'body' },
      h('div', { class: 'meta' },
        h('span', { text: isUser ? 'You' : assistant.name }),
        !isUser && msg.model ? h('span', { text: `· ${displayModel(msg.model.model)}` }) : null,
        !isUser && msg.stats ? statsBadge(msg.stats) : null,
        !isUser && !msg.stats && msg.pending && msg.runningOn ? liveBadge(msg.runningOn) : null,
        when ? h('span', { text: `· ${when}` }) : null),
      content,
      msg.recalled && msg.recalled.length ? h('div', { class: 'recalled' }, 'Used earlier chats: ',
        ...msg.recalled.flatMap((r, i) => [i ? ', ' : null, h('a', { href: '#', text: r.title, onclick: (e) => { e.preventDefault(); openChat(r.chatId); } })])) : null,
      msg.error ? h('div', { class: 'error', text: msg.error }) : null,
      msg.notice ? h('div', { class: 'msg-notice', text: msg.notice }) : null,
      msg.pending ? null : actions));
  return node;
}

// "GPU…" while an on-device reply is being written.
function liveBadge(device) {
  const onGpu = /^GPU/.test(device || '');
  return h('span', { class: `stats live ${onGpu ? 'gpu' : 'cpu'}`, title: `Running on ${device}`, text: `· ${onGpu ? 'GPU' : 'CPU'}…` });
}

// "GPU · 24 tok/s" under on-device replies, with details on tap/hover.
function statsBadge(st) {
  const speed = st.ms > 0 ? st.tokens / (st.ms / 1000) : 0;
  const onGpu = /^GPU/.test(st.device || '');
  const kind = onGpu ? 'GPU' : /^CPU/.test(st.device || '') ? 'CPU' : '';
  const details = [
    `Ran on: ${st.device}`,
    st.engine && st.engine !== st.device ? `Engine: ${st.engine}` : null,
    st.offload ? `llama.cpp ${st.offload}` : (st.device === 'CPU' && !st.engine ? 'All layers on the CPU' : null),
    st.loadMs > 300 ? `Loading the model: ${(st.loadMs / 1000).toFixed(1)} s` : null,
    `Reply: ${st.tokens} tokens in ${(st.ms / 1000).toFixed(1)} s (${speed.toFixed(1)} tokens/s)`,
    st.promptTokens ? `Reading the chat: ${st.promptTokens} tokens in ${(st.promptMs / 1000).toFixed(1)} s`
      : st.engine === 'WebAssembly' ? `Time before the first word: ${(st.promptMs / 1000).toFixed(1)} s` : 'Reading the chat: reused from memory'
  ].filter(Boolean).join('\n');
  return h('span', {
    class: `stats ${onGpu ? 'gpu' : 'cpu'}`,
    title: details,
    role: 'button',
    tabindex: 0,
    onclick: () => openModal({ title: 'How this reply ran', body: h('div', { style: 'white-space: pre-wrap', text: details }) }),
    text: `·${kind ? ` ${kind}` : ''}${speed ? `${kind ? ' ·' : ''} ${speed.toFixed(1)} tok/s` : ''}`
  });
}

function fillContent(container, msg) {
  container.replaceChildren();
  if (msg.role === 'user') {
    container.textContent = msg.content;
    return;
  }
  const { thinking, done, answer } = splitThinking(msg.content);
  const agentBlock = agentSteps(msg);
  if (agentBlock) container.append(agentBlock);
  if (thinking != null) {
    const words = thinking ? thinking.split(/\s+/).length : 0;
    const details = h('details', { class: 'thinking' },
      h('summary', {
        text: done ? 'Thought process' : `Thinking…${words ? ` (${words} words)` : ''}`,
        // Remember the reader's choice so redraws don't reopen or close it.
        onclick: () => thinkingOpen.set(msg, !details.open)
      }),
      h('div', { style: 'white-space: pre-wrap', text: thinking }));
    // Collapsed unless the reader opens it.
    details.open = thinkingOpen.get(msg) === true;
    container.append(details);
  }
  const body = renderMarkdown(answer);
  if (msg.pending) body.classList.add('typing');
  container.append(...body.childNodes.length ? [body] : []);
  if (msg.pending && !answer && thinking == null && !(msg.tools && msg.tools.length)) {
    container.append(h('span', { class: 'typing' }));
    if (msg.waiting && msg.model) {
      container.append(h('div', { class: 'waiting', text: `Waiting for ${displayModel(msg.model.model)} to start. Large models can take a minute to load the first time.` }));
    }
  }
}

// ---- Hermes Agent: live tool steps and approvals ------------------------------

const APPROVAL_LABELS = { once: 'Allow once', session: 'Allow for this chat', always: 'Always allow', deny: 'Deny' };
const APPROVAL_DONE = { once: 'Allowed once', session: 'Allowed for this chat', always: 'Always allowed', deny: 'Denied', expired: 'Not answered in time' };

function agentEvent(chat, msg, evt) {
  if (evt.kind === 'tool') {
    msg.tools = msg.tools || [];
    const known = evt.id && msg.tools.find((t) => t.id === evt.id);
    if (known) known.status = evt.status || known.status;
    else if (evt.status !== 'completed') msg.tools.push({ id: evt.id || uid(), emoji: evt.emoji || '', label: String(evt.label || evt.tool || 'tool').slice(0, 200), status: evt.status || 'running' });
  } else if (evt.kind === 'approval') {
    msg.approvals = msg.approvals || [];
    msg.approvals.push({ runId: evt.runId, approvalId: evt.approvalId || null, command: String(evt.command || '').slice(0, 2000), description: String(evt.description || '').slice(0, 500), choices: evt.choices, state: 'pending' });
    if (S.current !== chat || document.hidden) toast('Hermes is asking for permission. Open the chat to answer.', 5000);
  } else if (evt.kind === 'status') {
    msg.agentStatus = String(evt.text).slice(0, 200);
  }
  scheduleMessageRender(chat, msg);
  saveChatSoon(chat, S.info.mobile ? 5000 : 1500);
}

async function answerApproval(chat, msg, approval, choice) {
  approval.state = 'sending';
  scheduleMessageRender(chat, msg);
  try {
    await api.ai.approve(msg.model.provider, msg.model.model, { runId: approval.runId, choice, approvalId: approval.approvalId });
    approval.state = choice;
  } catch (err) {
    approval.state = 'pending';
    toast(`Couldn't send your answer: ${errorText(err)}`, 5000);
  }
  scheduleMessageRender(chat, msg);
  saveChatSoon(chat, 500);
}

// What the agent did (tools) and what it asked (approvals), above its answer.
function agentSteps(msg) {
  const tools = msg.tools || [];
  const approvals = msg.approvals || [];
  if (!tools.length && !approvals.length && !msg.agentStatus) return null;
  const chat = [...S.cache.values()].find((c) => c.messages.includes(msg)) || S.current;
  const wrap = h('div', { class: 'agent' });
  const toolLine = (t) => h('div', { class: `agent-step ${t.status}` },
    h('span', { class: 'agent-icon', text: t.emoji || '🔧' }),
    h('span', { class: 'agent-label', text: t.label }),
    h('span', { class: 'agent-state', text: t.status === 'running' ? 'working…' : t.status === 'stopped' ? 'stopped' : '✓' }));
  if (tools.length) {
    if (msg.pending) {
      // While working, show the latest steps.
      if (tools.length > 5) wrap.append(h('div', { class: 'agent-more', text: `${tools.length - 5} earlier steps` }));
      wrap.append(...tools.slice(-5).map(toolLine));
    } else {
      wrap.append(h('details', { class: 'agent-done' },
        h('summary', { text: `Used ${tools.length} tool${tools.length === 1 ? '' : 's'}` }),
        ...tools.map(toolLine)));
    }
  }
  for (const a of approvals) {
    if (a.state === 'pending' || a.state === 'sending') {
      wrap.append(h('div', { class: 'approval' },
        h('div', { class: 'approval-title', text: 'Hermes is asking for permission' }),
        a.description ? h('div', { class: 'approval-why', text: a.description }) : null,
        a.command ? h('pre', { class: 'approval-command', dir: 'ltr', text: a.command }) : null,
        h('div', { class: 'approval-buttons' },
          ...a.choices.filter((c) => APPROVAL_LABELS[c]).map((c) => h('button', {
            class: `btn ${c === 'deny' ? 'danger' : c === 'once' ? 'primary' : ''}`,
            text: APPROVAL_LABELS[c],
            disabled: a.state === 'sending',
            onclick: () => answerApproval(chat, msg, a, c)
          })))));
    } else {
      wrap.append(h('div', { class: `approval-done ${a.state === 'deny' ? 'denied' : ''}` },
        h('span', { class: 'approval-label', text: `${a.state === 'deny' ? '✗' : a.state === 'expired' ? '·' : '✓'} ${APPROVAL_DONE[a.state] || a.state}` }),
        a.command ? h('code', { text: a.command.length > 80 ? `${a.command.slice(0, 80)}…` : a.command }) : null));
    }
  }
  if (msg.pending && msg.agentStatus) wrap.append(h('div', { class: 'agent-status', text: msg.agentStatus }));
  return wrap;
}

function nearBottom() {
  const m = el.messages;
  return m.scrollHeight - m.scrollTop - m.clientHeight < 120;
}

function scrollToBottom() {
  el.messages.scrollTop = el.messages.scrollHeight;
}

const thinkingOpen = new WeakMap();  // message -> thinking box open?
const pendingRender = new Set();
let renderQueued = false;

// Redraw streaming replies in batches. Each redraw re-formats the whole
// reply, so on phones (where the model is also busy with the GPU) redraw a
// few times a second instead of every frame.
function scheduleMessageRender(chat, msg) {
  if (!S.current || S.current !== chat) return;
  pendingRender.add(msg);
  if (renderQueued) return;
  renderQueued = true;
  const run = () => {
    renderQueued = false;
    const stick = nearBottom();
    for (const m of pendingRender) {
      const node = el.messages.querySelector(`.msg[data-id="${m.id}"] .content`);
      if (node) fillContent(node, m);
    }
    pendingRender.clear();
    if (stick) scrollToBottom();
  };
  if (S.info.mobile) setTimeout(() => requestAnimationFrame(run), 250);
  else requestAnimationFrame(run);
}

function updateComposer() {
  const streaming = isStreaming(S.current);
  el.sendBtn.textContent = streaming ? 'Stop' : 'Send';
  el.sendBtn.classList.toggle('danger', streaming);
  const note = S.current ? modelNote(S.current, chatModel(S.current)) : '';
  el.hint.classList.toggle('model-note', !!note);
  if (note) el.hint.textContent = note;
  else if (S.info.mobile) el.hint.textContent = S.sync && S.sync.configured ? 'Every chat is saved on this phone and synced' : 'Every chat is saved on this phone';
  else {
    el.hint.textContent = S.settings.sendOnEnter
      ? 'Enter to send · Shift+Enter for a new line · every chat is saved automatically'
      : 'Ctrl+Enter to send · every chat is saved automatically';
  }
}

function autoGrow() {
  el.input.style.height = 'auto';
  el.input.style.height = `${Math.min(el.input.scrollHeight, 240)}px`;
}

// ---------------------------------------------------------------------------
// actions

// Read a chat from storage into the cache.
async function loadChat(id) {
  const chat = await api.chats.get(id);
  if (!chat) return null;
  // A reply that was cut off when the app closed.
  for (const m of chat.messages) {
    if (m.pending) {
      m.pending = false;
      if (!m.content) m.error = 'This reply was interrupted.';
    }
  }
  S.cache.set(id, chat);
  return chat;
}

async function openChat(id) {
  const chat = S.cache.get(id) || await loadChat(id);
  if (!chat) {
    toast('That chat could not be found.');
    await refreshList();
    return;
  }
  S.current = chat;
  S.state.lastChatId = id;
  api.state.save({ lastChatId: id });
  renderChat();
  renderSidebar();
  el.input.value = (S.state.drafts || {})[id] || '';
  autoGrow();
  scrollToBottom();
  closeDrawer();
  focusInput();
}

function newChat() {
  S.current = null;
  S.newChatModel = null;
  S.newChatAssistantId = null;
  S.state.lastChatId = null;
  api.state.save({ lastChatId: null });
  renderChat();
  renderSidebar();
  el.input.value = (S.state.drafts || {}).__new__ || '';
  autoGrow();
  closeDrawer();
  focusInput();
}

// On phones, don't pop the keyboard up every time a chat opens.
function focusInput() {
  if (!S.info.mobile) el.input.focus();
}

async function deleteChat(id) {
  const meta = S.chats.find((c) => c.id === id);
  if (!(await confirmBox(`Delete "${meta ? meta.title : 'this chat'}"? This cannot be undone.`))) return;
  const cached = S.cache.get(id);
  for (const [rid, r] of S.requests) if (r.chat === cached) api.ai.abort(rid);
  clearTimeout(saveTimers.get(id));
  saveTimers.delete(id);
  await api.chats.remove(id);
  S.cache.delete(id);
  if (S.current && S.current.id === id) newChat();
  await refreshList();
}

async function renameChat() {
  if (!S.current) return;
  const title = await askText({ title: 'Rename chat', label: 'Title', value: S.current.title });
  if (title == null || !title.trim()) return;
  S.current.title = title.trim();
  S.current.titleAuto = false;
  el.title.textContent = S.current.title;
  await saveChatNow(S.current);
}

async function editCustomInstructions() {
  if (!S.current) return;
  const text = await askText({
    title: 'Custom instructions for this chat',
    label: 'Added to the assistant\'s instructions for this chat only',
    value: S.current.systemPrompt || '',
    multiline: true
  });
  if (text == null) return;
  S.current.systemPrompt = text.trim();
  await saveChatNow(S.current);
  toast('Instructions saved');
}

const memoryKey = (line) => line.toLowerCase().replace(/^[-•*\s]+/, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

// Memory is kept small so it doesn't crowd out the conversation, especially
// for the phone's small models. When it grows past this, it's merged.
const MEMORY_LIMIT = 1500;

const memoryLines = () => S.settings.memory.split('\n').map((l) => l.trim().replace(/^[-•*]\s*/, '')).filter(Boolean);
const cleanFact = (raw) => String(raw).trim().replace(/\s+/g, ' ').replace(/^[-•*]\s*/, '').slice(0, 300);

function setMemory(lines) {
  S.settings.memory = lines.map((l) => `- ${l}`).join('\n');
  saveSettings();
  for (const draw of memoryViews) draw();
}

// Adds lines to memory, skipping ones it already has. Returns the new ones.
function addToMemory(lines) {
  const current = memoryLines();
  const known = new Set(current.map(memoryKey));
  const added = [];
  for (const raw of lines) {
    const line = cleanFact(raw);
    const key = memoryKey(line);
    if (!key || known.has(key)) continue;
    known.add(key);
    added.push(line);
  }
  if (added.length) setMemory([...current, ...added]);
  return added;
}

// A model this device can use for background jobs (not the phone's own
// models, which would slow the phone down).
function backgroundModel(preferred) {
  const candidates = [preferred, S.current && chatModel(S.current), S.settings.defaultModel];
  const usable = (m) => modelAvailable(m) && m.provider !== 'onDevice' && !isAgent(m);
  // Chats with an agent: fall back to a local model (never a paid cloud one).
  const local = allModels().filter((m) => ['ollama', 'openaiCompatible', 'computer'].includes(m.provider));
  return candidates.find(usable) || local.find(usable) || null;
}

async function askModel(model, prompt) {
  const res = await api.ai.chat({
    requestId: uid(),
    provider: model.provider,
    model: model.model,
    system: '',
    think: false,
    temperature: 0.1,
    maxTokens: 0,
    messages: [{ role: 'user', content: prompt }]
  });
  return res.ok && res.text ? splitThinking(res.text).answer.trim() : null;
}

// Merges memory down to the size limit when it has grown past it.
async function compactMemory(model) {
  const lines = memoryLines();
  const size = () => lines.join('\n').length + lines.length * 2;
  if (size() <= MEMORY_LIMIT) return false;
  const target = Math.floor(MEMORY_LIMIT * 0.8);
  let merged = null;
  if (model) {
    const answer = await askModel(model, [
      `Here is a list of facts about the user. It is too long: rewrite it in at most ${target} characters.`,
      'Merge related facts, keep the most useful ones (name, family, home, work, languages, strong preferences, long-term goals), drop trivial, outdated or duplicate ones.',
      'Keep the third person. One fact per line, each starting with "- ". Reply with the list only.',
      '',
      lines.map((l) => `- ${l}`).join('\n')
    ].join('\n'));
    const out = (answer || '').split('\n').map((l) => l.trim()).filter((l) => /^[-•*]\s+\S/.test(l)).map(cleanFact);
    if (out.length && out.join('\n').length + out.length * 2 <= MEMORY_LIMIT) merged = out;
  }
  // No model, or its answer didn't fit: drop the oldest facts after the first few.
  if (!merged) {
    merged = [...lines];
    while (merged.length > 3 && merged.join('\n').length + merged.length * 2 > MEMORY_LIMIT) merged.splice(3, 1);
  }
  setMemory(merged);
  return true;
}

function rememberText(text) {
  addToMemory([text]);
  toast('Added to memory');
  compactMemory(backgroundModel()).then((done) => done && toast('Memory was getting long, so it was tidied up.')).catch(() => {});
}

// Messages that state something about the user (English or Arabic), not
// requests like "tell me" or "can I".
const ABOUT_ME = /\b(i am|i'm|im|i was|i live|i work|i study|i have|i've|i like|i love|i prefer|i hate|i don't like|i do not like|i usually|i always|i never|i speak|i moved|i got|i quit|i started|i changed|i no longer|no longer|not anymore|my|mine|call me|we have|we live|our)\b|(أنا|انا|اسمي|عمري|عندي|أحب|احب|أعمل|اعمل|أسكن|اسكن|ساكن|زوجتي|زوجي|بنتي|ابني|أولادي|عائلتي|وظيفتي|شغلي|أفضل|افضل|انتقلت|تزوجت|صرت|ما عدت|لم أعد|تركت)/i;

// After a reply, update memory from what the user said: add new lasting
// facts, correct ones that changed and drop ones that are no longer true.
async function autoRemember(chat, userMsg, model) {
  const text = String(userMsg.content || '').trim();
  if (text.length < 12 || !ABOUT_ME.test(text)) return;
  const lines = memoryLines();
  const answer = await askModel(model, [
    'You keep a short list of lasting facts about the user so future conversations can be personal.',
    '',
    'Known facts:',
    lines.length ? lines.map((l, i) => `${i + 1}. ${l}`).join('\n') : '(none)',
    '',
    "The user's message:",
    text.slice(0, 2000),
    '',
    'Decide what should change. Reply with one operation per line:',
    'ADD: <new fact>            for something new about the user',
    'UPDATE <number>: <fact>    when the message changes or corrects a known fact',
    'REMOVE <number>            when the message says a known fact is no longer true',
    'Only lasting facts: name, family, where they live, work or studies, languages, preferences, dislikes, long-term goals or projects.',
    'Ignore one-off requests, questions and temporary moods. Write facts in the third person, short (e.g. "Prefers short answers"). At most 3 lines.',
    'If nothing should change, reply exactly: NONE'
  ].join('\n'));
  if (!answer || /^none\b/i.test(answer)) return;

  const next = [...lines];
  const changes = [];
  const adds = [];
  for (const raw of answer.split('\n').slice(0, 5)) {
    const line = raw.trim().replace(/^[-•*]\s*/, '');
    let m;
    if ((m = line.match(/^UPDATE\s*#?(\d+)\s*[:.-]\s*(.+)$/i))) {
      const i = Number(m[1]) - 1;
      if (next[i] != null && memoryKey(next[i]) !== memoryKey(m[2])) {
        changes.push(`Updated: ${cleanFact(m[2])} (was: ${next[i]})`);
        next[i] = cleanFact(m[2]);
      }
    } else if ((m = line.match(/^REMOVE\s*#?(\d+)/i))) {
      const i = Number(m[1]) - 1;
      if (next[i] != null) {
        changes.push(`Forgot: ${next[i]}`);
        next[i] = null;
      }
    } else if ((m = line.match(/^ADD\s*[:.-]\s*(.+)$/i))) {
      adds.push(m[1]);
    } else if (raw.trim().match(/^[-•*]\s+\S/) && !/^(update|remove|add)\b/i.test(line)) {
      adds.push(line); // a plain "- fact" line
    }
  }
  const kept = next.filter((l) => l != null);
  const known = new Set(kept.map(memoryKey));
  const remembered = [];
  for (const a of adds) {
    const fact = cleanFact(a);
    if (!memoryKey(fact) || known.has(memoryKey(fact))) continue;
    known.add(memoryKey(fact));
    kept.push(fact);
    remembered.push(`Remembered: ${fact}`);
  }
  const all = [...remembered, ...changes];
  if (!all.length) return;
  setMemory(kept);
  const tidied = await compactMemory(model).catch(() => false);
  const short = (t) => (t.length > 80 ? `${t.slice(0, 79)}…` : t);
  toast(all.map(short).join(' · ') + (tidied ? ' · Memory tidied up to stay short' : ''), 5000);
}

// Earlier chats that match what the user just asked, for the model.
async function recallFor(chat, model) {
  if (!S.settings.recallChats || !api.chats.recall) return [];
  const userTexts = chat.messages.filter((m) => m.role === 'user').slice(-2).map((m) => m.content);
  if (!userTexts.length) return [];
  const small = model.provider === 'onDevice';
  const search = api.chats.recall(userTexts.join('\n'), { excludeId: chat.id, limit: small ? 2 : 3, maxChars: small ? 600 : 1500 }).catch(() => []);
  // Never hold up a reply for long; the search keeps warming its cache.
  return Promise.race([search, new Promise((r) => setTimeout(() => r([]), 1500))]);
}

function buildSystemPrompt(chat, recalled = [], model = null) {
  const parts = [];
  const assistant = getAssistant(chat.assistantId);
  if (assistant.systemPrompt) parts.push(assistant.systemPrompt.trim());
  if (chat.systemPrompt) parts.push(chat.systemPrompt.trim());
  if (S.settings.memoryEnabled && S.settings.memory.trim() && shareMemoryWith(model)) {
    parts.push(`Things to remember about the user (from previous sessions):\n${S.settings.memory.trim()}`);
  }
  if (recalled.length) {
    const when = (t) => (t ? new Date(t).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) : '');
    parts.push([
      'Excerpts from the user\'s earlier chats that may be relevant. Use them only if they help; don\'t mention them otherwise:',
      ...recalled.map((r) => `- [${r.title}${r.updatedAt ? `, ${when(r.updatedAt)}` : ''}] ${r.role === 'user' ? 'User' : 'Assistant'}: ${r.text}`)
    ].join('\n'));
  }
  return parts.join('\n\n');
}

function historyFor(chat, uptoIndex) {
  let msgs = chat.messages.slice(0, uptoIndex)
    .filter((m) => !m.error && m.content)
    .map((m) => ({ role: m.role, content: m.role === 'assistant' ? splitThinking(m.content).answer.trim() : m.content }));
  const limit = Number(S.settings.historyLimit) || 0;
  if (limit > 0 && msgs.length > limit) msgs = msgs.slice(-limit);
  return msgs;
}

async function send() {
  if (isStreaming(S.current)) {
    stopCurrent();
    return;
  }
  const text = el.input.value.trim();
  if (!text) return;
  const model = currentModel();
  if (!model) {
    toast('Choose a model first (top right).');
    return;
  }

  let chat = S.current;
  if (!chat) {
    chat = await api.chats.create({ assistantId: currentAssistantId(), model });
    chat.titleAuto = true;
    S.cache.set(chat.id, chat);
    S.current = chat;
    S.state.lastChatId = chat.id;
    api.state.save({ lastChatId: chat.id });
    saveDraft('__new__', '');
  }

  if (!chat.messages.length) chat.title = text.replace(/\s+/g, ' ').slice(0, 60);
  chat.messages.push({ id: uid(), role: 'user', content: text, createdAt: Date.now() });
  el.input.value = '';
  autoGrow();
  saveDraft(chat.id, '');
  await runCompletion(chat);
}

async function runCompletion(chat) {
  const model = chatModel(chat);
  if (!model) {
    toast('Choose a model first (top right).');
    return;
  }
  useModel(chat, model);
  const msg = { id: uid(), role: 'assistant', content: '', createdAt: Date.now(), model, pending: true };
  const history = historyFor(chat, chat.messages.length);
  chat.messages.push(msg);
  chat.updatedAt = Date.now();
  if (S.current === chat) {
    renderChat();
    scrollToBottom();
  }
  await saveChatNow(chat);

  const recalled = shareMemoryWith(model) ? await recallFor(chat, model) : [];
  if (recalled.length) {
    msg.recalled = [...new Map(recalled.map((r) => [r.chatId, { chatId: r.chatId, title: r.title }])).values()];
    scheduleMessageRender(chat, msg);
  }
  const system = buildSystemPrompt(chat, recalled, model);

  const requestId = uid();
  S.requests.set(requestId, { chat, msg });
  // Say what's happening if the model is slow to start (loading into memory).
  const waitTimer = setTimeout(() => {
    if (msg.pending && !msg.content) {
      msg.waiting = true;
      scheduleMessageRender(chat, msg);
    }
  }, 4000);
  updateComposer();
  renderSidebar();

  const res = await api.ai.chat({
    requestId,
    provider: model.provider,
    model: model.model,
    system,
    messages: history,
    temperature: S.settings.temperature === '' ? undefined : Number(S.settings.temperature),
    maxTokens: Number(S.settings.maxTokens) || 0
  });

  S.requests.delete(requestId);
  clearTimeout(waitTimer);
  msg.pending = false;
  for (const a of msg.approvals || []) if (a.state === 'pending' || a.state === 'sending') a.state = 'expired';
  for (const t of msg.tools || []) if (t.status === 'running') t.status = res.ok && !res.aborted ? 'completed' : 'stopped';
  delete msg.agentStatus;
  delete msg.runningOn;
  delete msg.waiting;
  if (!res.ok) msg.error = `Error: ${res.error}`;
  if (res.stats) msg.stats = res.stats;
  if (res.ok && res.stopReason === 'max_tokens') msg.notice = 'The reply was cut off at the length limit. Ask it to continue, or raise "Max tokens" in Settings.';
  chat.updatedAt = Date.now();
  await saveChatNow(chat);
  if (S.current === chat) {
    const stick = nearBottom();
    renderChat();
    if (stick) scrollToBottom();
  }
  updateComposer();

  // Learn lasting facts from what the user just said. Skipped for on-device
  // phone models, where a second run after every reply would slow the phone.
  if (res.ok && !res.aborted && S.settings.memoryEnabled && S.settings.autoMemory && model.provider !== 'onDevice' && !isAgent(model)) {
    const userMsg = [...chat.messages].reverse().find((m) => m.role === 'user');
    if (userMsg) autoRemember(chat, userMsg, model).catch(() => {});
  }

  if (res.ok && !res.aborted && chat.titleAuto && S.settings.autoTitle && model.provider !== 'onDevice' && chat.messages.filter((m) => m.role === 'assistant').length === 1) {
    // An agent would run a whole agent turn just to name the chat; use another model if there is one.
    const titler = isAgent(model) ? backgroundModel(null) : model;
    if (titler) generateTitle(chat, titler);
  }
}

async function generateTitle(chat, model = chat.model) {
  const first = chat.messages.find((m) => m.role === 'user');
  const provisional = chat.title;
  if (!first) return;
  const res = await api.ai.chat({
    requestId: uid(),
    provider: model.provider,
    model: model.model,
    system: '',
    messages: [{
      role: 'user',
      content: `Write a short title (3 to 6 words) for a conversation that starts with the message below. Reply with only the title, no quotes or punctuation at the end.\n\nMessage:\n${first.content.slice(0, 1500)}`
    }],
    temperature: 0.3,
    maxTokens: 0
  });
  if (!res.ok || !res.text) return;
  const title = splitThinking(res.text).answer
    .split('\n').map((s) => s.trim()).find(Boolean)
    ?.replace(/^(title:\s*)/i, '')
    .replace(/^["'*#\s]+|["'*.\s]+$/g, '')
    .slice(0, 60);
  if (!title || chat.title !== provisional) return;
  chat.title = title;
  await saveChatNow(chat);
  if (S.current === chat) {
    el.title.textContent = title;
    document.title = `${title} — ${appName()}`;
  }
}

function stopCurrent() {
  for (const [rid, r] of S.requests) if (r.chat === S.current) api.ai.abort(rid);
}

async function regenerate(chat) {
  if (isStreaming(chat)) return;
  if (!chatModel(chat)) {
    toast('Choose a model first (top right).');
    return;
  }
  const last = chat.messages[chat.messages.length - 1];
  if (last && last.role === 'assistant') chat.messages.pop();
  if (!chat.messages.length) return;
  await runCompletion(chat);
}

async function deleteMessage(chat, msg) {
  if (isStreaming(chat)) return;
  chat.messages = chat.messages.filter((m) => m !== msg);
  await saveChatNow(chat);
  renderChat();
}

function startEdit(chat, msg, node) {
  if (isStreaming(chat)) return;
  const body = node.querySelector('.body');
  const area = h('textarea', { class: 'input', value: msg.content });
  const box = h('div', { class: 'edit-box' }, area,
    h('div', { class: 'row' },
      h('button', { class: 'btn', text: 'Cancel', onclick: () => renderChat() }),
      h('button', {
        class: 'btn primary',
        text: 'Save & resend',
        onclick: async () => {
          const text = area.value.trim();
          if (!text) return;
          const i = chat.messages.indexOf(msg);
          msg.content = text;
          chat.messages = chat.messages.slice(0, i + 1);
          await runCompletion(chat);
        }
      })));
  body.replaceChildren(box);
  area.style.height = `${Math.min(400, area.scrollHeight + 10)}px`;
  area.focus();
}

// ---------------------------------------------------------------------------
// sync between devices

const syncViews = new Set();
const memoryViews = new Set();  // open Settings > Memory panes to refresh on changes

// The memory text box, with a character count against the size limit.
function memoryBox(onCleanup, field, bind, s) {
  const area = bind(h('textarea', { class: 'input', rows: 12, value: s.memory, placeholder: '- My name is …\n- I work as …\n- I prefer short answers' }), s, 'memory');
  const count = h('div', { class: 'help memory-count' });
  const update = () => {
    const n = s.memory.length;
    count.textContent = `${n.toLocaleString()} / ${MEMORY_LIMIT.toLocaleString()} characters` +
      (n > MEMORY_LIMIT ? ' · longer memory leaves less room for the conversation; it is tidied up the next time something is remembered' : '');
    count.classList.toggle('over', n > MEMORY_LIMIT);
  };
  area.addEventListener('input', update);
  const draw = () => {
    if (document.activeElement !== area) area.value = s.memory;
    update();
  };
  memoryViews.add(draw);
  onCleanup(() => memoryViews.delete(draw));
  update();
  return field('What should your assistants always remember about you?', h('div', {}, area, count),
    'Shared with the model at the start of every chat. Edit or delete anything here. "Remember" under any of your messages adds it by hand.');
}  // open Settings > Sync panes to redraw on changes

function timeAgo(ts) {
  const sec = Math.round((Date.now() - ts) / 1000);
  if (sec < 45) return 'just now';
  const min = Math.round(sec / 60);
  if (min < 60) return `${min} min ago`;
  const hours = Math.round(min / 60);
  if (hours < 24) return `${hours} h ago`;
  return new Date(ts).toLocaleDateString();
}

function syncLabel(st = S.sync) {
  if (!st || !st.configured) return null;
  if (st.running) return { cls: '', text: '⟳ Syncing…' };
  if (st.error && st.offline) return { cls: '', text: '⚠ Offline, will sync later' };
  if (st.error) return { cls: 'bad', text: '⚠ Sync problem' };
  return { cls: 'ok', text: st.lastSync ? `✓ Synced ${timeAgo(st.lastSync)}` : 'Not synced yet' };
}

function renderSyncBadge() {
  const btn = $('#syncBtn');
  const label = syncLabel();
  btn.hidden = !label;
  if (!label) return;
  btn.textContent = label.text;
  btn.className = `sync-status ${label.cls}`;
  btn.title = S.sync.error || `Synced with ${S.sync.label}. Click to sync now.`;
}

// Another device changed chats or settings: show the new versions.
async function onSyncEvent(evt) {
  if (evt.type === 'status') {
    S.sync = evt.status;
    renderSyncBadge();
    for (const draw of syncViews) draw();
    return;
  }
  if (evt.type !== 'changed') return;
  if (evt.settings) {
    const fresh = await api.settings.get();
    const computersChanged = JSON.stringify(fresh.computers) !== JSON.stringify(S.settings.computers);
    for (const k of ['assistants', 'memory', 'memoryEnabled', 'autoMemory', 'recallChats', 'computers', 'sharedModifiedAt']) S.settings[k] = fresh[k];
    renderSelectors();
    if (computersChanged && S.settings.providers.computer) loadModels();
    for (const draw of memoryViews) draw();
  }
  for (const id of evt.deleted) {
    const cached = S.cache.get(id);
    if (cached && isStreaming(cached)) continue;
    S.cache.delete(id);
    if (S.current && S.current.id === id) newChat();
  }
  for (const id of evt.chats) {
    const cached = S.cache.get(id);
    if (cached && isStreaming(cached)) continue;
    S.cache.delete(id);
    if (S.current && S.current.id === id) {
      const stick = nearBottom();
      const chat = await loadChat(id);
      if (chat) {
        S.current = chat;
        renderChat();
        if (stick) scrollToBottom();
      }
    }
  }
  await refreshList();
}

function syncView(onCleanup, field) {
  const box = h('div');
  const link = (text, href) => h('a', { href, target: '_blank', rel: 'noopener', text });
  let shownConfigured = null;

  const connectedView = (st) => {
    const label = syncLabel(st);
    return [
      field('Syncing with', st.provider === 'gdrive'
        ? h('div', {}, st.label, h('div', { class: 'help', text: 'In a hidden Balimda folder in your Drive. It uses a little of your Drive storage.' }))
        : link(st.label, st.link)),
      h('p', { class: `status ${label.cls}`, text: label.text }),
      st.error ? h('p', { class: 'help', text: st.error }) : null,
      h('div', { class: 'field-row' },
        h('button', { class: 'btn primary', text: 'Sync now', disabled: st.running, onclick: () => api.sync.now() }),
        h('button', {
          class: 'btn danger',
          text: 'Stop syncing',
          onclick: async () => {
            if (!(await confirmBox('Stop syncing on this device? Your chats stay here and in the repository.', 'Stop syncing'))) return;
            S.sync = await api.sync.disconnect();
            renderSyncBadge();
            draw();
          }
        })),
      h('p', { class: 'help', text: 'Chats, assistants and memory sync by themselves: a few seconds after each change, when you open the app and every minute while it is open. API keys and server addresses stay on each device.' })
    ];
  };

  // Which destination the setup form shows. Google Drive is the easy one,
  // when this build can sign in to Google.
  let choice = (S.sync && S.sync.providers && S.sync.providers.gdrive) ? 'gdrive' : 'github';

  const passField = () => {
    const pass = h('input', { class: 'input', type: 'password', placeholder: 'At least 8 characters', autocomplete: 'new-password' });
    return {
      pass,
      node: field('Sync passphrase', pass, 'Encrypts your chats. Use the same one on every device. It cannot be recovered, so keep it somewhere safe.')
    };
  };

  const connectButton = (label, busyText, getOptions) => {
    const msg = h('p', { class: 'status' });
    const btn = h('button', { class: 'btn primary', text: label });
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      msg.className = 'status';
      msg.textContent = busyText;
      try {
        S.sync = await api.sync.connect(getOptions());
        renderSyncBadge();
        shownConfigured = null;
        draw();
        toast(S.sync.error ? 'Sync is on, but the first sync had a problem' : 'Sync is on');
      } catch (err) {
        msg.className = 'status bad';
        msg.textContent = errorText(err);
        btn.disabled = false;
      }
    });
    return [h('div', { class: 'field-row' }, btn), msg];
  };

  const driveForm = () => {
    const { pass, node } = passField();
    return [
      h('p', { text: 'Your chats are kept in a hidden Balimda folder in your Google Drive. Balimda cannot see anything else in your Drive, and your chats are encrypted on this device first, so not even Google can read them.' }),
      h('ol', { class: 'steps' },
        h('li', {}, 'Choose a sync passphrase below.'),
        h('li', {}, S.info.mobile ? 'Tap the button and pick your Google account.' : 'Click the button, then sign in to Google in your browser.'),
        h('li', {}, 'On your other devices, sign in to the same Google account with the same passphrase.')),
      node,
      ...connectButton('Sign in with Google', S.info.mobile ? 'Signing in…' : 'Finish signing in in your browser…',
        () => ({ provider: 'gdrive', passphrase: pass.value }))
    ];
  };

  const githubForm = () => {
    const repo = h('input', { class: 'input', placeholder: 'your-name/balimda-sync', autocapitalize: 'off', spellcheck: 'false' });
    const token = h('input', { class: 'input', type: 'password', placeholder: 'github_pat_…', autocomplete: 'off' });
    const { pass, node } = passField();
    return [
      h('p', { text: 'Your chats are kept in a private GitHub repository that only you can access. They are encrypted on this device with your sync passphrase first, so not even GitHub can read them.' }),
      h('ol', { class: 'steps' },
        h('li', {}, 'Create a private repository, for example "balimda-sync": ', link('github.com/new', 'https://github.com/new'), '. Set it to Private.'),
        h('li', {}, 'Create an access token: ', link('new fine-grained token', 'https://github.com/settings/personal-access-tokens/new'),
          '. Under Repository access choose "Only select repositories" and pick that repository. Under Permissions set Contents to "Read and write".'),
        h('li', {}, 'Enter them here with a sync passphrase. On your other devices use the same repository and passphrase (a token made on that device works too).')),
      field('Repository', repo),
      field('Access token', token),
      node,
      ...connectButton('Turn on sync', 'Connecting… (the first sync can take a minute)',
        () => ({ provider: 'github', repo: repo.value, token: token.value, passphrase: pass.value }))
    ];
  };

  const setupView = () => {
    const providers = (S.sync && S.sync.providers) || {};
    const intro = h('p', { class: 'help', text: 'Start a chat on one device and continue it on another. Chats, assistants and memory stay the same everywhere.' });
    if (!providers.gdrive) return [intro, ...githubForm()];
    const option = (id, title, sub) => h('button', {
      class: `choice ${choice === id ? 'active' : ''}`,
      onclick: () => {
        choice = id;
        shownConfigured = null;
        draw();
      }
    }, h('strong', { text: title }), h('span', { text: sub }));
    return [
      intro,
      h('div', { class: 'choices' },
        option('gdrive', 'Google Drive', 'Recommended. Just sign in.'),
        option('github', 'GitHub', 'For developers. Uses a private repository.')),
      ...(choice === 'gdrive' ? driveForm() : githubForm())
    ];
  };

  // Redraw on status changes, but never while the setup form is being filled in.
  const draw = () => {
    const st = S.sync || {};
    if (!st.configured && shownConfigured === false) return;
    shownConfigured = !!st.configured;
    box.replaceChildren(...(st.configured ? connectedView(st) : setupView()).filter(Boolean));
  };
  syncViews.add(draw);
  onCleanup(() => syncViews.delete(draw));
  draw();
  return [box];
}

// ---------------------------------------------------------------------------
// settings

// Desktop: let the phone chat with this computer's models (src/remote.js).
function shareWithPhoneCard(s, check, onCleanup) {
  const status = h('div', { class: 'help', style: 'margin-bottom:8px' });
  const draw = (st) => {
    if (!st) return;
    if (st.error) status.textContent = st.error;
    else if (!s.shareWithPhone) status.textContent = '';
    else if (!st.syncReady) status.textContent = 'Set up sync (Settings → Sync) on this computer and your phone first. Sharing starts as soon as sync is on.';
    else if (st.sharing) {
      status.textContent = `Sharing as "${st.name}" on ${st.addrs.join(', ') || 'this computer'} (port ${st.port}). Your phone finds it through sync: on the phone, pick a model under "On your computer". If your system asks, allow Balimda to accept incoming network connections.`;
    } else status.textContent = 'Starting…';
  };
  api.remote.status().then(draw);
  onCleanup(api.remote.onStatus(draw));
  const box = check('Let my phone use this computer\'s models', s, 'shareWithPhone');
  box.querySelector('input').addEventListener('change', () => {
    status.textContent = s.shareWithPhone ? 'Starting…' : '';
  });
  return h('div', { class: 'provider-card' },
    h('h4', { text: 'Use from your phone' }),
    box,
    status,
    h('div', { class: 'help', text: 'Your phone sends chats here and this computer answers with its models (Ollama, LM Studio, and your API keys, which never leave this computer). The connection is encrypted with your sync passphrase, so only your own devices can use it. Balimda needs to stay open.' }));
}

function openSettings(tab = 'general') {
  const s = S.settings;
  const changed = () => { saveSettings(); };
  const pane = h('div', { class: 'settings-pane' });
  const tabs = [
    ['general', 'General'],
    ['providers', 'Models & providers'],
    ['assistants', 'Assistants'],
    ['memory', 'Memory'],
    ...(api.sync ? [['sync', 'Sync']] : []),
    ['data', 'Data & backup'],
    ['about', 'About']
  ];
  const tabBar = h('div', { class: 'settings-tabs' });
  let cleanups = [];
  const onCleanup = (fn) => cleanups.push(fn);
  const runCleanups = () => {
    for (const fn of cleanups) fn();
    cleanups = [];
  };

  const bind = (input, obj, key, transform = (v) => v) => {
    const evt = input.type === 'checkbox' || input.tagName === 'SELECT' ? 'change' : 'input';
    input.addEventListener(evt, () => {
      obj[key] = transform(input.type === 'checkbox' ? input.checked : input.value);
      changed();
      if (key === 'theme') applyTheme();
      if (key === 'sendOnEnter') updateComposer();
    });
    return input;
  };

  const field = (label, control, help) =>
    h('div', { class: 'field' }, h('label', { text: label }), control, help ? h('div', { class: 'help', text: help }) : null);
  const check = (label, obj, key) =>
    h('label', { class: 'check' }, bind(h('input', { type: 'checkbox', checked: obj[key] }), obj, key), label);

  const views = {
    general() {
      const theme = bind(h('select', { class: 'select' },
        h('option', { value: 'system', text: 'Match system' }),
        h('option', { value: 'light', text: 'Light' }),
        h('option', { value: 'dark', text: 'Dark' })), s, 'theme');
      theme.value = s.theme;
      return [
        field('Theme', theme),
        check('Press Enter to send (Shift+Enter for a new line)', s, 'sendOnEnter'),
        check('Name new chats automatically with AI', s, 'autoTitle'),
        field('Temperature', bind(h('input', { class: 'input', type: 'number', step: '0.1', min: '0', max: '2', value: s.temperature }), s, 'temperature'),
          'Creativity for local models (0 = focused, 1+ = creative). Leave empty to use the model default.'),
        field('Max tokens per reply', bind(h('input', { class: 'input', type: 'number', min: '0', value: s.maxTokens }), s, 'maxTokens', Number),
          '0 = automatic.'),
        field('History sent to the model', bind(h('input', { class: 'input', type: 'number', min: '0', value: s.historyLimit }), s, 'historyLimit', Number),
          'How many previous messages to include. 0 = the whole chat. Lower this for small local models with short context.')
      ];
    },

    providers() {
      const cards = [];
      const help = S.info.mobile ? {
        ollama: 'Use Ollama running on your computer over Wi-Fi. On the computer, set OLLAMA_HOST=0.0.0.0 and OLLAMA_ORIGINS=*, restart Ollama, then enter http://<computer IP>:11434 here.',
        openaiCompatible: 'LM Studio (or llama.cpp, Jan…) on your computer. In LM Studio turn on "Serve on local network" and "Enable CORS", then enter http://<computer IP>:1234/v1 here.'
      } : {
        ollama: 'Runs models on your own computer, offline. Install from ollama.com, then run e.g. "ollama pull llama3.2".',
        openaiCompatible: 'LM Studio, llama.cpp server, Jan, vLLM or any OpenAI-compatible server. LM Studio default: http://127.0.0.1:1234/v1'
      };
      help.hermes = S.info.mobile
        ? 'Chat with your Hermes Agent. Easiest: set up Hermes in Balimda on your computer and pick "hermes-agent" under "On your computer" here, so Hermes stays private on the computer. To connect this phone directly instead, in ~/.hermes/.env set API_SERVER_ENABLED=true, API_SERVER_KEY, API_SERVER_HOST=0.0.0.0 and API_SERVER_CORS_ORIGINS=https://localhost, run "hermes gateway", then enter http://<computer IP>:8642/v1 and the key here.'
        : 'Chat with your Hermes Agent (Nous Research). In ~/.hermes/.env set API_SERVER_ENABLED=true and API_SERVER_KEY=<a long secret>, run "hermes gateway", then enter the key here. Hermes runs its tools on its own machine; Balimda shows each step and asks you before anything risky. Your phone can use it too through "Let my phone use this computer\'s models".';
      Object.assign(help, {
        computer: 'Chat with the models on your computer (Ollama, LM Studio, and Claude or OpenAI with the computer\'s API keys) while the computer does the work. In Balimda on the computer, turn on "Let my phone use this computer\'s models" in Settings → Models & providers. Both need sync set up with the same passphrase; that\'s how they find each other and keep the connection private. Works on the same Wi-Fi, or anywhere when both are on Tailscale.',
        anthropic: 'Claude models. Create an API key at console.anthropic.com.',
        openai: 'OpenAI models. Create an API key at platform.openai.com.'
      });
      for (const id of providerIds()) {
        const p = s.providers[id];
        if (id === 'onDevice') {
          cards.push(onDeviceCard(p, changed, bind, field, onCleanup));
          continue;
        }
        const status = h('span', { class: 'status' });
        const models = S.models[id];
        if (models) { status.textContent = `${models.length} models`; status.className = 'status ok'; }
        else if (S.modelErrors[id]) { status.textContent = 'not connected'; status.className = 'status bad'; }
        const test = h('button', {
          class: 'btn',
          text: 'Test connection',
          onclick: async () => {
            status.textContent = 'Testing…';
            status.className = 'status';
            await api.settings.save(S.settings);
            try {
              const list = await api.ai.models(id);
              status.textContent = `Connected · ${list.length} models`;
              status.className = 'status ok';
            } catch (err) {
              status.textContent = errorText(err);
              status.className = 'status bad';
            }
            loadModels();
          }
        });
        const shared = id === 'computer'
          ? Object.values(s.computers || {}).filter((c) => c.enabled).map((c) => c.name)
          : null;
        cards.push(h('div', { class: 'provider-card' },
          h('h4', {}, providerLabel(id), status),
          check('Enabled', p, 'enabled'),
          shared ? h('div', { class: 'help', text: shared.length ? `Sharing: ${shared.join(', ')}` : 'No computer is sharing its models yet.' }) : null,
          'baseUrl' in p ? field('Server URL', bind(h('input', { class: 'input', value: p.baseUrl }), p, 'baseUrl')) : null,
          id === 'ollama' ? h('label', { class: 'check' },
            bind(h('input', { type: 'checkbox', checked: p.think !== false }), p, 'think'),
            'Let thinking models think first (better answers; turn off for faster replies)') : null,
          'apiKey' in p ? field('API key', bind(h('input', { class: 'input', type: 'password', value: p.apiKey, placeholder: id === 'openaiCompatible' ? 'Optional' : 'Paste your key' }), p, 'apiKey', (v) => v.trim())) : null,
          id === 'hermes' ? h('label', { class: 'check' },
            bind(h('input', { type: 'checkbox', checked: !!p.shareMemory }), p, 'shareMemory'),
            'Also give Hermes my Balimda memory and earlier chats (Hermes has its own memory, so this is off by default)') : null,
          h('div', { class: 'help', text: help[id] || '' }),
          h('div', { style: 'margin-top:8px' }, test)));
      }
      if (api.remote) cards.push(shareWithPhoneCard(s, check, onCleanup));
      cards.push(h('p', {
        class: 'help',
        text: S.info.mobile
          ? 'API keys are stored only in this app\'s private storage on your phone.'
          : 'API keys are stored on this computer only, encrypted with your system keychain when available.'
      }));
      return cards;
    },

    assistants() {
      const list = h('div');
      const draw = () => {
        list.replaceChildren(...s.assistants.map((p, i) => h('div', { class: 'assistant-row' },
          h('div', { style: 'font-size:20px', text: p.emoji || '🤖' }),
          h('div', { class: 'grow' },
            h('div', { text: p.name }),
            h('div', { class: 'sub', text: p.systemPrompt || 'No instructions' })),
          h('button', { class: 'btn', text: 'Edit', onclick: () => editAssistant(p, draw) }),
          s.assistants.length > 1 ? h('button', {
            class: 'btn danger',
            text: 'Delete',
            onclick: async () => {
              if (!(await confirmBox(`Delete the assistant "${p.name}"? Existing chats keep their messages.`))) return;
              s.assistants.splice(i, 1);
              changed();
              draw();
              renderSelectors();
            }
          }) : null)));
      };
      draw();
      return [
        h('p', { class: 'help', text: 'Assistants are personalities with their own instructions (and optionally their own model). Pick one when starting a chat.' }),
        list,
        h('button', {
          class: 'btn primary',
          text: '＋ Add an assistant',
          onclick: () => {
            const assistant = { id: uid(), name: 'New assistant', emoji: '🙂', systemPrompt: '' };
            editAssistant(assistant, () => {
              if (!s.assistants.includes(assistant)) s.assistants.push(assistant);
              changed();
              draw();
            });
          }
        })
      ];
    },

    memory() {
      return [
        check('Use memory in every chat', s, 'memoryEnabled'),
        check('Remember things about me automatically', s, 'autoMemory'),
        h('div', { class: 'help', style: 'margin: -4px 0 14px 26px', text: S.info.mobile
          ? 'After a reply, lasting facts you mention (your name, work, family, preferences…) are added below. This uses Ollama and cloud models; the models on this phone are skipped so replies stay fast. Memory syncs between your devices.'
          : 'After a reply, lasting facts you mention (your name, work, family, preferences…) are added below, using the chat\'s model. On-device phone models skip this to stay fast.' }),
        memoryBox(onCleanup, field, bind, s),
        check('Look through my earlier chats for relevant details', s, 'recallChats'),
        h('div', { class: 'help', style: 'margin: -4px 0 14px 26px', text: 'Before each reply, the best-matching bits of your other chats are given to the model (a little less for phone models, to stay fast). Replies that used them say so underneath, with links to those chats.' })
      ];
    },

    sync() {
      return syncView(onCleanup, field);
    },

    data() {
      return [
        field('Where your chats are stored', h('div', {},
          h('div', { class: 'mono', text: S.info.dataDir }),
          S.info.mobile ? null : h('button', { class: 'btn', style: 'margin-top:8px', text: 'Open data folder', onclick: () => api.app.openDataDir() }))),
        field('Backup', h('div', { class: 'field-row' },
          h('button', { class: 'btn', text: 'Export all chats…', onclick: exportAll }),
          h('button', { class: 'btn', text: 'Import chats…', onclick: importAll })),
        'Export makes a single JSON file with every chat. Importing merges chats into this app.'),
        h('p', { class: 'help', text: `${appName()} ${S.info.version} · ${S.chats.length} chats` })
      ];
    },

    about() {
      const showLegal = async (which, title) => {
        let text;
        try {
          text = await api.app.legal(which);
        } catch (err) {
          text = `Couldn't open this file: ${errorText(err)}`;
        }
        openModal({ title, wide: true, body: h('pre', { class: 'legal', text }) });
      };
      return [
        h('div', { class: 'about-head' },
          S.info.icon ? h('img', { class: 'about-icon', src: S.info.icon, alt: '' }) : null,
          h('div', {},
            h('div', { class: 'about-name', text: appName() }),
            h('div', { class: 'help', text: `Version ${S.info.version}` }))),
        h('p', { class: 'about-by' }, 'Created by ', h('strong', { text: AUTHOR })),
        h('p', { class: 'help', text: COPYRIGHT }),
        h('p', { text: 'Balimda is a private AI chat app that remembers every chat. It runs models on your device, on your own computer, or in the cloud. Your chats stay on your device.' }),
        field('Support Balimda', h('div', {},
          h('p', { class: 'help', text: 'Balimda is made by one person, with no ads, no tracking and no subscriptions. If it helps you, you can support its development.' }),
          h('a', { class: 'btn primary', href: SUPPORT_URL, target: '_blank', rel: 'noopener', text: '☕ Support on Ko-fi' }))),
        field('License', h('div', {},
          h('p', { class: 'help', text: 'Free for personal, non-commercial use under the Balimda License. You may share or change it only if it keeps the Balimda name and the "Balimda by Bandar Altariqi" credit. It may not be rebranded. Use by or for a company or organisation, or any commercial use, needs a commercial license from Bandar Altariqi.' }),
          h('p', { class: 'help' }, h('a', { href: COMMERCIAL_URL, target: '_blank', rel: 'noopener', text: 'Request a commercial license for your company' })),
          h('div', { class: 'field-row' },
            h('button', { class: 'btn', text: 'Read the license', onclick: () => showLegal('license', 'Balimda License') }),
            h('button', { class: 'btn', text: 'Open-source credits', onclick: () => showLegal('notices', 'Third-party notices') })))),
        field('Project', h('a', { href: PROJECT_URL, target: '_blank', rel: 'noopener', text: PROJECT_URL })),
        h('p', { class: 'help', text: 'Built with llama.cpp, wllama, Electron, Capacitor, marked and DOMPurify. AI models belong to their creators and have their own licenses.' })
      ];
    }
  };

  const show = (name) => {
    runCleanups();
    for (const b of tabBar.children) b.classList.toggle('active', b.dataset.tab === name);
    pane.replaceChildren(...views[name]().filter(Boolean));
  };
  for (const [id, label] of tabs) tabBar.append(h('button', { 'data-tab': id, text: label, onclick: () => show(id) }));

  openModal({
    title: 'Settings',
    wide: true,
    body: h('div', { class: 'settings' }, tabBar, pane),
    onClose: async () => {
      runCleanups();
      await api.settings.save(S.settings);
      renderSelectors();
      loadModels();
      renderChat();
    }
  });
  const body = el.modalRoot.lastElementChild.querySelector('.modal-body');
  body.style.padding = '0';
  show(tab);
}

function formatBytes(n) {
  if (!n) return '';
  return n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : `${Math.round(n / 1e6)} MB`;
}

// Settings card for models that run on the phone itself.
function onDeviceCard(p, changed, bind, field, onCleanup) {
  const od = api.onDevice;
  const list = h('div', { class: 'od-list' });
  const legacyBox = h('div');
  const engineLine = h('p', { class: 'help' });
  const gpuBox = h('div');
  const customHelp = h('div', { class: 'help' });
  const custom = h('input', { class: 'input', placeholder: 'https://huggingface.co/…/model-Q4_0.gguf' });

  // Which engine runs the models, and the matching GPU switch.
  od.engine().then((eng) => {
    if (eng.kind === 'native') {
      engineLine.textContent = eng.gpu
        ? `Engine: llama.cpp (native) · GPU: ${eng.gpu}`
        : 'Engine: llama.cpp (native) · no supported GPU found, using the CPU';
      customHelp.textContent = 'Q4_0 files run fastest on the GPU. Q4_K_M files work too (partly on the CPU).';
      gpuBox.replaceChildren(
        h('label', { class: 'check' }, bind(h('input', { type: 'checkbox', checked: p.nativeGpu !== false, disabled: !eng.gpu }), p, 'nativeGpu'),
          'Use the GPU'),
        h('div', { class: 'help', text: 'Runs the model on the phone\'s graphics chip (Adreno) for faster replies. Turn off to use the CPU only.' }));
    } else {
      engineLine.textContent = S.info.platform === 'android' && eng.error
        ? `Engine: WebAssembly (slower). The faster native engine couldn't start on this phone: ${eng.error}`
        : 'Engine: WebAssembly (works everywhere, slower)';
      customHelp.textContent = 'Q4_K_M files between 0.3 and 2 GB work best.';
      gpuBox.replaceChildren(
        h('label', { class: 'check' }, bind(h('input', { type: 'checkbox', checked: !!p.useGpu }), p, 'useGpu'),
          'Use the phone\'s GPU (experimental)'),
        h('div', { class: 'help', text: 'Can be much faster, but on many phones the GPU gives garbled answers. If replies look like random words, turn this off.' }));
    }
  });

  const draw = async () => {
    const [catalog, downloaded, downloads, legacy] = await Promise.all([od.catalog(), od.list(), od.downloads(), od.legacy ? od.legacy() : []]);
    legacyBox.replaceChildren(...(legacy.length ? [
      h('p', { class: 'help', text: 'Downloaded by the previous engine. The new engine can\'t use these files, so you can delete them to free space.' }),
      ...legacy.map((m) => h('div', { class: 'od-row' },
        h('div', { class: 'grow' },
          h('div', { class: 'od-name', text: displayModel(m.name) }),
          h('div', { class: 'sub', text: `Old download · ${formatBytes(m.size)}` })),
        h('div', { class: 'od-actions' },
          h('button', {
            class: 'btn danger',
            text: 'Delete',
            onclick: async () => {
              await od.removeLegacy(m.url);
              draw();
            }
          }))))
    ] : []));
    const have = new Map(downloaded.map((m) => [m.url, m]));
    const rows = [...catalog];
    for (const m of downloaded) if (!catalog.some((c) => c.url === m.url)) rows.push({ name: displayModel(m.name), note: 'Custom model', url: m.url, size: m.size });
    for (const url of Object.keys(downloads)) if (!rows.some((r) => r.url === url)) rows.push({ name: displayModel(url.split('/').pop()), note: 'Custom model', url });

    list.replaceChildren(...rows.map((m) => {
      const dl = downloads[m.url];
      const got = have.get(m.url);
      let right;
      if (got) {
        right = h('div', { class: 'od-actions' },
          h('span', { class: 'status ok', text: '✓ Ready' }),
          h('button', {
            class: 'btn danger',
            text: 'Delete',
            onclick: async () => {
              if (!(await confirmBox(`Delete ${m.name} from this phone? You can download it again later.`))) return;
              await od.remove(m.url);
              await draw();
              loadModels();
            }
          }));
      } else if (dl && !dl.error) {
        const pct = dl.total ? Math.floor((dl.loaded / dl.total) * 100) : 0;
        right = h('div', { class: 'od-actions' },
          h('div', { class: 'progress' }, h('div', { class: 'bar', style: `width:${pct}%` })),
          h('span', { class: 'status', text: dl.total ? `${pct}%` : 'Starting…' }),
          h('button', { class: 'btn', text: 'Cancel', onclick: () => od.cancel(m.url) }));
      } else {
        right = h('div', { class: 'od-actions' },
          dl && dl.error ? h('span', { class: 'status bad', title: dl.error, text: 'Failed' }) : null,
          h('button', { class: 'btn primary', text: dl && dl.error ? 'Retry' : 'Download', onclick: () => od.download(m.url) }));
      }
      return h('div', { class: 'od-row' },
        h('div', { class: 'grow' },
          h('div', { class: 'od-name', text: m.name }),
          h('div', { class: 'sub', text: [m.note, formatBytes(got ? got.size : m.size)].filter(Boolean).join(' · ') }),
          dl && dl.error ? h('div', { class: 'sub bad', text: dl.error }) : null),
        right);
    }));
  };

  // Progress events arrive many times a second; redraw at most ~3 times a second.
  let wasDownloading = 0;
  let redraw = null;
  onCleanup(od.onProgress((state) => {
    const n = Object.keys(state).length;
    if (n < wasDownloading) loadModels(); // a download finished
    wasDownloading = n;
    if (!redraw) redraw = setTimeout(() => { redraw = null; draw(); }, 300);
  }));
  onCleanup(() => clearTimeout(redraw));
  draw();

  const ctx = h('select', { class: 'select' },
    [2048, 4096, 8192].map((n) => h('option', { value: n, text: `${n} tokens${n === 4096 ? ' (recommended)' : ''}` })));
  ctx.value = String(p.contextSize || 4096);

  return h('div', { class: 'provider-card' },
    h('h4', {}, providerLabel('onDevice')),
    h('p', { class: 'help', text: 'These models run entirely on your phone: private, free and offline. Download one once over Wi-Fi. Smaller models answer faster; bigger ones are smarter.' }),
    engineLine,
    list,
    legacyBox,
    field('Add any GGUF model by link', h('div', { class: 'field-row' },
      custom,
      h('button', {
        class: 'btn',
        text: 'Download',
        onclick: () => {
          od.download(custom.value.trim()).catch((err) => toast(errorText(err)));
          custom.value = '';
        }
      })), null),
    customHelp,
    field('Memory for the conversation (context)', bind(ctx, p, 'contextSize', Number),
      'Larger remembers more of a long chat but uses more RAM and is slower.'),
    gpuBox);
}

function editAssistant(assistant, onSaved) {
  const name = h('input', { class: 'input', value: assistant.name });
  const emoji = h('input', { class: 'input', value: assistant.emoji || '', style: 'width:70px' });
  const prompt = h('textarea', { class: 'input', rows: 8, value: assistant.systemPrompt || '', placeholder: 'e.g. You are a patient math tutor who explains step by step.' });
  const model = h('select', { class: 'select' },
    h('option', { value: '', text: 'Use the model picked at the top' }),
    modelOptions(assistant.model, { includeCustom: false }));
  model.value = modelKey(assistant.model);
  if (!assistant.model) model.value = '';
  openModal({
    title: 'Edit assistant',
    body: h('div', {},
      h('div', { class: 'field' }, h('label', { text: 'Name' }), h('div', { class: 'field-row' }, emoji, name)),
      h('div', { class: 'field' }, h('label', { text: 'Instructions (system prompt)' }), prompt),
      h('div', { class: 'field' }, h('label', { text: 'Preferred model' }), model)),
    buttons: [
      { label: 'Cancel' },
      {
        label: 'Save',
        primary: true,
        onClick: () => {
          assistant.name = name.value.trim() || 'Assistant';
          assistant.emoji = emoji.value.trim() || '🤖';
          assistant.systemPrompt = prompt.value.trim();
          assistant.model = model.value ? parseModelKey(model.value) : null;
          onSaved();
          renderSelectors();
        }
      }
    ]
  });
}

async function exportAll() {
  const r = await api.backup.exportAll();
  if (r) toast(`Exported ${r.count} chats`);
}

async function importAll() {
  try {
    const r = await api.backup.importAll();
    if (r) {
      S.cache.clear();
      if (S.current) S.current = await api.chats.get(S.current.id);
      if (S.current) S.cache.set(S.current.id, S.current);
      await refreshList();
      renderChat();
      toast(`Imported ${r.count} chats`);
    }
  } catch (err) {
    toast(`Import failed: ${err.message}`);
  }
}

function exportCurrent() {
  if (S.current) api.chats.exportMarkdown(S.current.id).then((r) => r && toast('Chat exported'));
}

function applyTheme() {
  const t = S.settings.theme;
  if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t;
  else delete document.documentElement.dataset.theme;
}

// Narrow screens (phones) show the chat list as a slide-over drawer.
const narrow = window.matchMedia('(max-width: 700px)');

function toggleSidebar() {
  if (narrow.matches) {
    el.app.classList.toggle('drawer-open');
    return;
  }
  const collapsed = !el.app.classList.contains('sidebar-collapsed');
  el.app.classList.toggle('sidebar-collapsed', collapsed);
  api.state.save({ sidebarCollapsed: collapsed });
}

function closeDrawer() {
  el.app.classList.remove('drawer-open');
}

// Android back button: close whatever is on top, else leave the app.
function goBack() {
  const top = el.modalRoot.lastElementChild;
  if (top) {
    top.querySelector('.modal-head .icon-btn').click();
    return;
  }
  if (!el.chatMenu.hidden) {
    el.chatMenu.hidden = true;
    return;
  }
  if (el.app.classList.contains('drawer-open')) {
    closeDrawer();
    return;
  }
  if (api.app.exit) api.app.exit();
}

// ---------------------------------------------------------------------------
// events

function bindEvents() {
  $('#newChatBtn').addEventListener('click', newChat);
  $('#settingsBtn').addEventListener('click', () => openSettings());
  $('#creditBtn').addEventListener('click', () => openSettings('about'));
  $('#syncBtn').addEventListener('click', () => {
    if (S.sync && S.sync.error && !S.sync.offline) openSettings('sync');
    else api.sync.now();
  });
  $('#toggleSidebarBtn').addEventListener('click', toggleSidebar);
  $('#refreshModelsBtn').addEventListener('click', async () => { await loadModels(); toast('Model list refreshed'); });
  el.title.addEventListener('click', renameChat);
  el.modelSelect.addEventListener('change', onModelChange);
  el.assistantSelect.addEventListener('change', onAssistantChange);
  el.sendBtn.addEventListener('click', send);

  el.search.addEventListener('input', debounce(() => {
    S.query = el.search.value;
    refreshList();
  }, 200));

  el.input.addEventListener('input', () => {
    autoGrow();
    saveDraft(draftKey(), el.input.value);
  });
  el.input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.isComposing) {
      const wantsSend = S.settings.sendOnEnter ? !e.shiftKey : (e.ctrlKey || e.metaKey);
      if (wantsSend) {
        e.preventDefault();
        if (!isStreaming(S.current)) send();
      }
    }
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !el.modalRoot.children.length && isStreaming(S.current)) stopCurrent();
  });

  $('#chatMenuBtn').addEventListener('click', (e) => {
    e.stopPropagation();
    if (!S.current) {
      toast('Send a message first to create the chat.');
      return;
    }
    el.chatMenu.querySelector('[data-action="pin"]').textContent = S.current.pinned ? 'Unpin' : 'Pin to top';
    el.chatMenu.hidden = !el.chatMenu.hidden;
  });
  document.addEventListener('click', () => { el.chatMenu.hidden = true; });
  el.chatMenu.addEventListener('click', async (e) => {
    const action = e.target.dataset.action;
    el.chatMenu.hidden = true;
    if (!S.current) return;
    if (action === 'rename') renameChat();
    if (action === 'pin') { S.current.pinned = !S.current.pinned; await saveChatNow(S.current); }
    if (action === 'system') editCustomInstructions();
    if (action === 'export') exportCurrent();
    if (action === 'delete') deleteChat(S.current.id);
  });

  api.ai.onEvent((evt) => {
    const r = S.requests.get(evt.requestId);
    if (!r) return;
    if (evt.type === 'info' && evt.kind) {
      agentEvent(r.chat, r.msg, evt);
      return;
    }
    if (evt.type === 'info' && evt.device) {
      // Show GPU/CPU as soon as the model is ready, not only at the end.
      r.msg.runningOn = evt.device;
      const meta = el.messages.querySelector(`.msg[data-id="${r.msg.id}"] .meta`);
      if (meta && !meta.querySelector('.stats')) meta.children[1]?.after(liveBadge(evt.device));
      return;
    }
    if (evt.type !== 'delta') return;
    r.msg.content += evt.text;
    scheduleMessageRender(r.chat, r.msg);
    // Saving rewrites the whole chat, so phones save a streaming reply less often.
    saveChatSoon(r.chat, S.info.mobile ? 5000 : 1500);
  });

  api.onMenu((action) => {
    if (action === 'new-chat') newChat();
    if (action === 'search') { if (el.app.classList.contains('sidebar-collapsed')) toggleSidebar(); el.search.focus(); el.search.select(); }
    if (action === 'settings') openSettings();
    if (action === 'export') exportAll();
    if (action === 'import') importAll();
    if (action === 'toggle-sidebar') toggleSidebar();
    if (action === 'back') goBack();
  });
  $('#drawerBackdrop').addEventListener('click', closeDrawer);

  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);

  if (api.sync) {
    api.sync.onEvent(onSyncEvent);
    setInterval(renderSyncBadge, 30 * 1000);
  }
}

// ---------------------------------------------------------------------------
// start

async function init() {
  [S.settings, S.info, S.state, S.sync] = await Promise.all([
    api.settings.get(), api.app.info(), api.state.get(), api.sync ? api.sync.status() : null
  ]);
  // Identifies this device in chats' per-device model choices (not synced).
  if (!S.state.deviceId) {
    S.state.deviceId = uid();
    api.state.save({ deviceId: S.state.deviceId });
  }
  $('#brandName').textContent = appName();
  if (S.info.mobile) el.search.placeholder = 'Search all chats';
  document.body.classList.toggle('is-mobile', !!S.info.mobile);
  applyTheme();
  if (S.state.sidebarCollapsed) el.app.classList.add('sidebar-collapsed');
  bindEvents();
  renderSyncBadge();
  await refreshList();

  const last = S.state.lastChatId && S.chats.find((c) => c.id === S.state.lastChatId);
  if (last) await openChat(last.id);
  else newChat();

  loadModels();
}

init();
