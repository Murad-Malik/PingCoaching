const { app, BrowserWindow, ipcMain, desktopCapturer, screen, Menu } = require('electron');
const path = require('path');

// This app has no File/Edit/View/Window/Help menu of its own - that's just
// Electron's unused default template eating a row at the top of the window.
Menu.setApplicationMenu(null);

let launcherWindow = null;
let overlayWindow = null;

function createLauncherWindow() {
  launcherWindow = new BrowserWindow({
    width: 560,
    height: 1100,
    minWidth: 460,
    minHeight: 520,
    resizable: true,
    title: 'PointCue',
    icon: path.join(__dirname, 'assets', 'icon.png'),
    backgroundColor: '#0d0f13',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  launcherWindow.loadFile(path.join(__dirname, 'windows', 'launcher.html'));
  launcherWindow.on('closed', () => {
    launcherWindow = null;
    destroyOverlayWindow();
  });

  // Let the renderer know when OS-level fullscreen changes, including when it
  // happens outside our own toggle (e.g. the user hits the OS fullscreen shortcut).
  launcherWindow.on('enter-full-screen', () => {
    launcherWindow.webContents.send('window:fullscreen-changed', true);
  });
  launcherWindow.on('leave-full-screen', () => {
    launcherWindow.webContents.send('window:fullscreen-changed', false);
  });

  // If the page navigates away (e.g. the coach hits "Back" mid-fullscreen), don't
  // strand the whole app in a borderless fullscreen window with no way out.
  launcherWindow.webContents.on('did-navigate', () => {
    if (launcherWindow.isFullScreen()) launcherWindow.setFullScreen(false);
  });
}

// The overlay is a full-screen, transparent, click-through window that sits on top
// of everything else (including a fullscreen game) and draws the ping markers.
// It never receives focus and never intercepts mouse/keyboard input, so it can't
// interfere with whatever the person being coached is doing.
function createOverlayWindow() {
  if (overlayWindow) return overlayWindow;

  const primaryDisplay = screen.getPrimaryDisplay();
  const { x, y, width, height } = primaryDisplay.bounds;

  overlayWindow = new BrowserWindow({
    x,
    y,
    width,
    height,
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    resizable: false,
    movable: false,
    focusable: false,
    fullscreenable: false,
    show: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  // Keep the overlay above fullscreen/exclusive content where the OS supports it.
  overlayWindow.setAlwaysOnTop(true, 'screen-saver');
  overlayWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  overlayWindow.setIgnoreMouseEvents(true, { forward: true });

  overlayWindow.loadFile(path.join(__dirname, 'windows', 'overlay.html'));
  overlayWindow.on('closed', () => {
    overlayWindow = null;
  });

  return overlayWindow;
}

function destroyOverlayWindow() {
  if (overlayWindow) {
    overlayWindow.close();
    overlayWindow = null;
  }
}

app.whenReady().then(() => {
  createLauncherWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createLauncherWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// ---- IPC handlers ----

// Renderer (host.html) asks for the list of capturable screens/windows so it can
// pick one. desktopCapturer only exists on the main process, so we relay it
// through IPC. 'window' sources let the streamer share just one application
// (a game, a browser tab's window, etc.) instead of their whole desktop.
ipcMain.handle('get-screen-sources', async () => {
  const sources = await desktopCapturer.getSources({
    types: ['screen', 'window'],
    thumbnailSize: { width: 300, height: 180 }
  });
  return sources.map((s) => ({
    id: s.id,
    name: s.name,
    type: s.id.startsWith('screen:') ? 'screen' : 'window',
    thumbnailDataUrl: s.thumbnail.toDataURL()
  }));
});

// Host renderer reports it has started sharing -> spin up the click-through overlay.
ipcMain.on('overlay:start', () => {
  createOverlayWindow();
});

ipcMain.on('overlay:stop', () => {
  destroyOverlayWindow();
});

// A ping arrived over the WebRTC data channel in host.js; forward the normalized
// (0..1, 0..1) coordinate straight to the overlay window, which maps it onto its
// own full-screen bounds. No pixel math needed here - percentages are resolution
// independent.
ipcMain.on('overlay:ping', (_event, payload) => {
  if (overlayWindow) {
    overlayWindow.webContents.send('show-ping', payload);
  }
});

// Free-draw line: same relay pattern as pings, just two message types instead of
// one - a point as the coach drags, and an end marker when they let go of the
// mouse button so the overlay knows to start fading that stroke out.
ipcMain.on('overlay:draw-point', (_event, payload) => {
  if (overlayWindow) {
    overlayWindow.webContents.send('draw-point', payload);
  }
});

ipcMain.on('overlay:draw-end', (_event, payload) => {
  if (overlayWindow) {
    overlayWindow.webContents.send('draw-end', payload);
  }
});

// Window-level fullscreen for the viewer's video, instead of the browser's element
// Fullscreen API. Chromium auto-adds its own minimal playback controls (including
// an elapsed-time readout) over any <video> in element fullscreen as an accessibility
// safety net, and that same API hides the rest of the page - including our own ping
// color picker - since only the fullscreened element renders. Going fullscreen at
// the OS window level instead avoids both: no browser-injected controls, and our
// own UI stays live to float on top of the video.
ipcMain.on('window:set-fullscreen', (event, flag) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win) win.setFullScreen(!!flag);
});

// The app window defaults to a comfortable size for the setup/join forms, which
// is too small for actually watching a stream. Maximize (not fullscreen - that's
// the separate explicit toggle above) once a session connects so the video is the
// dominant thing on screen without the coach having to resize the window by hand.
ipcMain.on('window:maximize', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win) win.maximize();
});

ipcMain.on('window:unmaximize', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win) win.unmaximize();
});
