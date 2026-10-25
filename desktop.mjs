import { app, BrowserWindow, dialog, shell } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const APP_DIR = path.dirname(fileURLToPath(import.meta.url));
let engineServer;
let mainWindow;
let quitting = false;

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  async function openWindow() {
    mainWindow = new BrowserWindow({
      title: 'Xovra',
      icon: path.join(APP_DIR, 'assets', process.platform === 'win32' ? 'xovra-icon.ico' : 'xovra-icon.png'),
      width: 1440,
      height: 960,
      minWidth: 920,
      minHeight: 680,
      show: false,
      backgroundColor: '#f4f1e6',
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true
      }
    });

    const appOrigin = `http://127.0.0.1:${engineServer.port}`;
    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
      if (url.startsWith('https://') || url.startsWith('http://')) void shell.openExternal(url);
      return { action: 'deny' };
    });
    mainWindow.webContents.on('will-navigate', (event, url) => {
      if (!url.startsWith(`${appOrigin}/`)) {
        event.preventDefault();
        if (url.startsWith('https://') || url.startsWith('http://')) void shell.openExternal(url);
      }
    });
    mainWindow.once('ready-to-show', () => mainWindow?.show());
    mainWindow.on('closed', () => { mainWindow = null; });
    await mainWindow.loadURL(appOrigin);
  }

  app.whenReady().then(async () => {
    process.env.XOVRA_APP_VERSION = app.getVersion();
    process.env.XOVRA_DESKTOP = '1';
    process.env.XOVRA_ENGINE_DIR = app.isPackaged
      ? path.join(process.resourcesPath, 'engine', 'bin')
      : path.join(APP_DIR, 'engine', 'bin');
    process.env.XOVRA_WORK_DIR = app.getPath('userData');

    try {
      const { startServer } = await import('./server.mjs');
      engineServer = await startServer({ port: 0 });
      await openWindow();
    } catch (error) {
      dialog.showErrorBox('Xovra could not start', error.message || 'The local media engine could not start.');
      app.quit();
    }
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0 && engineServer) void openWindow();
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('before-quit', event => {
    if (!engineServer || quitting) return;
    event.preventDefault();
    quitting = true;
    void engineServer.close().finally(() => app.quit());
  });
}
