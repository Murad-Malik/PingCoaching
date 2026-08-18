const { contextBridge, ipcRenderer } = require('electron');

// A small, explicit API surface exposed to every renderer window (launcher, host,
// viewer, overlay). Nothing beyond this is reachable from page JS, so a compromised
// or buggy renderer can't reach arbitrary Node/Electron APIs.
contextBridge.exposeInMainWorld('pingcoach', {
  getScreenSources: () => ipcRenderer.invoke('get-screen-sources'),

  startOverlay: () => ipcRenderer.send('overlay:start'),
  stopOverlay: () => ipcRenderer.send('overlay:stop'),
  sendPing: (payload) => ipcRenderer.send('overlay:ping', payload),
  sendDrawPoint: (payload) => ipcRenderer.send('overlay:draw-point', payload),
  sendDrawEnd: (payload) => ipcRenderer.send('overlay:draw-end', payload),

  onShowPing: (callback) => {
    ipcRenderer.on('show-ping', (_event, payload) => callback(payload));
  },
  onDrawPoint: (callback) => {
    ipcRenderer.on('draw-point', (_event, payload) => callback(payload));
  },
  onDrawEnd: (callback) => {
    ipcRenderer.on('draw-end', (_event, payload) => callback(payload));
  },

  setFullScreen: (flag) => ipcRenderer.send('window:set-fullscreen', flag),
  onFullscreenChange: (callback) => {
    ipcRenderer.on('window:fullscreen-changed', (_event, flag) => callback(flag));
  },

  maximize: () => ipcRenderer.send('window:maximize'),
  unmaximize: () => ipcRenderer.send('window:unmaximize')
});
