// Balimda — © 2026 Bandar Altariqi. All rights reserved.
// Licensed under the Balimda License (see LICENSE): non-commercial use only;
// keep the Balimda name and the "Balimda by Bandar Altariqi" credit; no rebranding.

const { app, BrowserWindow, ipcMain, Menu, shell, dialog, safeStorage, nativeTheme, screen } = require('electron');
const fs = require('fs');
const path = require('path');
const { Storage } = require('./src/storage');
const { nodeFsBackend } = require('./src/backends/node-fs');
const { PROVIDERS, normalizeMessages } = require('./src/providers');

// Allow a custom data folder (e.g. a synced folder) via BALIMDA_DATA_DIR.
const dataDir = process.env.BALIMDA_DATA_DIR || path.join(app.getPath('userData'), 'data');

let storage;
let mainWindow;
const activeRequests = new Map();

if (!app.requestSingleInstanceLock()) {
  app.quit();
}

app.on('second-instance', () => {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.focus();
});

// API keys are encrypted with the OS keychain when it is available.
function secrets() {
  const canEncrypt = () => {
    try {
      return safeStorage.isEncryptionAvailable();
    } catch {
      return false;
    }
  };
  return {
    encrypt(s) {
      if (!s || !canEncrypt()) return s;
      return `enc:${safeStorage.encryptString(s).toString('base64')}`;
    },
    decrypt(s) {
      if (!s || !s.startsWith('enc:')) return s;
      try {
        return safeStorage.decryptString(Buffer.from(s.slice(4), 'base64'));
      } catch {
        return '';
      }
    }
  };
}

function boundsAreVisible(bounds) {
  return screen.getAllDisplays().some(({ workArea: a }) =>
    bounds.x < a.x + a.width && bounds.x + bounds.width > a.x &&
    bounds.y < a.y + a.height && bounds.y + bounds.height > a.y);
}

async function createWindow() {
  const state = await storage.getState();
  const saved = state.windowBounds;
  const bounds = saved && boundsAreVisible(saved) ? saved : { width: 1200, height: 800 };

  mainWindow = new BrowserWindow({
    ...bounds,
    minWidth: 720,
    minHeight: 480,
    title: 'Balimda',
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#16171b' : '#ffffff',
    icon: path.join(__dirname, 'build', 'icon.png'),
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: true
    }
  });
  if (state.maximized) mainWindow.maximize();

  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  // Remember window size and position between sessions.
  const saveBounds = () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    const maximized = mainWindow.isMaximized();
    storage.saveState(maximized ? { maximized } : { maximized, windowBounds: mainWindow.getBounds() }).catch(() => {});
  };
  let boundsTimer;
  const scheduleSave = () => {
    clearTimeout(boundsTimer);
    boundsTimer = setTimeout(saveBounds, 500);
  };
  mainWindow.on('resize', scheduleSave);
  mainWindow.on('move', scheduleSave);
  mainWindow.on('close', saveBounds);

  // Open links in the user's browser, never inside the app.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (e, url) => {
    if (url !== mainWindow.webContents.getURL()) {
      e.preventDefault();
      if (/^https?:\/\//.test(url)) shell.openExternal(url);
    }
  });
}

function send(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
}

function buildMenu() {
  const isMac = process.platform === 'darwin';
  const template = [
    ...(isMac ? [{ role: 'appMenu' }] : []),
    {
      label: 'File',
      submenu: [
        { label: 'New Chat', accelerator: 'CmdOrCtrl+N', click: () => send('menu', 'new-chat') },
        { label: 'Search Chats', accelerator: 'CmdOrCtrl+K', click: () => send('menu', 'search') },
        { label: 'Settings', accelerator: 'CmdOrCtrl+,', click: () => send('menu', 'settings') },
        { type: 'separator' },
        { label: 'Export All Chats…', click: () => send('menu', 'export') },
        { label: 'Import Chats…', click: () => send('menu', 'import') },
        { label: 'Open Data Folder', click: () => shell.openPath(dataDir) },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' }
      ]
    },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { label: 'Toggle Sidebar', accelerator: 'CmdOrCtrl+B', click: () => send('menu', 'toggle-sidebar') },
        { type: 'separator' },
        { role: 'reload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    },
    { role: 'windowMenu' }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function registerIpc() {
  ipcMain.handle('chats:list', () => storage.listChats());
  ipcMain.handle('chats:search', (_e, q) => storage.searchChats(q));
  ipcMain.handle('chats:get', (_e, id) => storage.getChat(id));
  ipcMain.handle('chats:create', (_e, init) => storage.createChat(init));
  ipcMain.handle('chats:save', (_e, chat) => storage.saveChat(chat));
  ipcMain.handle('chats:delete', (_e, id) => storage.deleteChat(id));

  ipcMain.handle('settings:get', () => storage.getSettings());
  ipcMain.handle('settings:save', (_e, s) => storage.saveSettings(s));
  ipcMain.handle('state:get', () => storage.getState());
  ipcMain.handle('state:save', (_e, patch) => storage.saveState(patch));

  ipcMain.handle('app:info', () => ({
    version: app.getVersion(),
    dataDir,
    platform: process.platform,
    appName: 'Balimda',
    icon: '../build/icon.png',
    mobile: false,
    providers: Object.fromEntries(Object.entries(PROVIDERS).map(([k, v]) => [k, v.label]))
  }));
  ipcMain.handle('app:openDataDir', () => shell.openPath(dataDir));
  // LICENSE / THIRD-PARTY-NOTICES.md for the About page.
  ipcMain.handle('app:legal', (_e, which) => {
    const file = which === 'notices' ? 'THIRD-PARTY-NOTICES.md' : 'LICENSE';
    return fs.readFileSync(path.join(__dirname, file), 'utf8');
  });

  ipcMain.handle('backup:export', async () => {
    const stamp = new Date().toISOString().slice(0, 10);
    const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
      title: 'Export all chats',
      defaultPath: `balimda-backup-${stamp}.json`,
      filters: [{ name: 'JSON', extensions: ['json'] }]
    });
    if (canceled || !filePath) return null;
    const data = await storage.exportAll();
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
    return { filePath, count: data.chats.length };
  });

  ipcMain.handle('backup:import', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
      title: 'Import chats',
      properties: ['openFile'],
      filters: [{ name: 'JSON', extensions: ['json'] }]
    });
    if (canceled || !filePaths.length) return null;
    const data = JSON.parse(fs.readFileSync(filePaths[0], 'utf8'));
    return { count: await storage.importAll(data) };
  });

  ipcMain.handle('chat:exportMarkdown', async (_e, id) => {
    const chat = await storage.getChat(id);
    if (!chat) return null;
    const safe = chat.title.replace(/[^\w\- ]+/g, '').trim() || 'chat';
    const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
      title: 'Export chat',
      defaultPath: `${safe}.md`,
      filters: [{ name: 'Markdown', extensions: ['md'] }]
    });
    if (canceled || !filePath) return null;
    const lines = [`# ${chat.title}`, ''];
    for (const m of chat.messages) {
      lines.push(`## ${m.role === 'user' ? 'You' : 'Assistant'}`, '', m.content || '', '');
    }
    fs.writeFileSync(filePath, lines.join('\n'));
    return { filePath };
  });

  ipcMain.handle('ai:models', async (_e, providerId) => {
    const provider = PROVIDERS[providerId];
    if (!provider) throw new Error(`Unknown provider: ${providerId}`);
    const cfg = (await storage.getSettings()).providers[providerId] || {};
    return provider.impl.listModels(cfg);
  });

  // Streams a reply. Deltas are pushed to the renderer as 'ai:event' messages.
  ipcMain.handle('ai:chat', async (_e, req) => {
    const { requestId, provider: providerId } = req;
    const provider = PROVIDERS[providerId];
    if (!provider) throw new Error(`Unknown provider: ${providerId}`);
    const cfg = (await storage.getSettings()).providers[providerId] || {};
    const controller = new AbortController();
    activeRequests.set(requestId, controller);
    try {
      const result = await provider.impl.streamChat(
        cfg,
        {
          model: req.model,
          system: req.system,
          messages: normalizeMessages(req.messages),
          temperature: req.temperature,
          maxTokens: req.maxTokens
        },
        (text) => send('ai:event', { requestId, type: 'delta', text }),
        controller.signal
      );
      return { ok: true, ...result };
    } catch (err) {
      if (controller.signal.aborted) return { ok: true, aborted: true };
      return { ok: false, error: err.message || String(err) };
    } finally {
      activeRequests.delete(requestId);
    }
  });

  ipcMain.handle('ai:abort', (_e, requestId) => {
    const c = activeRequests.get(requestId);
    if (c) c.abort();
    return !!c;
  });
}

app.whenReady().then(async () => {
  storage = await Storage.open(nodeFsBackend(dataDir), { secrets: secrets() });
  registerIpc();
  buildMenu();
  await createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  for (const c of activeRequests.values()) c.abort();
  if (process.platform !== 'darwin') app.quit();
});
