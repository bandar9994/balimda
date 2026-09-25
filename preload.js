// Balimda — © 2026 Bandar Altariqi. All rights reserved.
// Licensed under the Balimda License (see LICENSE): non-commercial use only;
// keep the Balimda name and the "Balimda by Bandar Altariqi" credit; no rebranding.

const { contextBridge, ipcRenderer } = require('electron');

const invoke = (channel) => (...args) => ipcRenderer.invoke(channel, ...args);

contextBridge.exposeInMainWorld('balimda', {
  chats: {
    list: invoke('chats:list'),
    search: invoke('chats:search'),
    get: invoke('chats:get'),
    create: invoke('chats:create'),
    save: invoke('chats:save'),
    remove: invoke('chats:delete'),
    exportMarkdown: invoke('chat:exportMarkdown')
  },
  settings: {
    get: invoke('settings:get'),
    save: invoke('settings:save')
  },
  state: {
    get: invoke('state:get'),
    save: invoke('state:save')
  },
  backup: {
    exportAll: invoke('backup:export'),
    importAll: invoke('backup:import')
  },
  app: {
    info: invoke('app:info'),
    openDataDir: invoke('app:openDataDir'),
    legal: invoke('app:legal')
  },
  ai: {
    models: invoke('ai:models'),
    chat: invoke('ai:chat'),
    abort: invoke('ai:abort'),
    onEvent(cb) {
      const listener = (_e, evt) => cb(evt);
      ipcRenderer.on('ai:event', listener);
      return () => ipcRenderer.removeListener('ai:event', listener);
    }
  },
  onMenu(cb) {
    ipcRenderer.on('menu', (_e, action) => cb(action));
  }
});
