const { contextBridge, ipcRenderer } = require('electron');

const invoke = (channel) => (...args) => ipcRenderer.invoke(channel, ...args);

contextBridge.exposeInMainWorld('pal', {
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
    openDataDir: invoke('app:openDataDir')
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
