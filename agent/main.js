// BridgeDesk — десктоп агент (Electron)
const { app, BrowserWindow, ipcMain, desktopCapturer, session, screen, clipboard, Tray, Menu, nativeImage, systemPreferences, shell, powerMonitor } = require('electron');
const path = require('path');
const os = require('os');
const input = require('./input');
// Windows: hide the system cursor during a session (the viewer draws its own, smooth cursor).
// All cursor work runs in a small helper process (cursor-helper.js) so it can never crash the app.
const { fork } = require('child_process');
let cursorProc = null;
let cursorHidden = false;
function spawnCursorHelper() {
  if (process.platform !== 'win32') return null;
  try {
    const p = fork(path.join(__dirname, 'cursor-helper.js'), [], {
      execPath: process.execPath,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      windowsHide: true,
    });
    p.on('message', (m) => {
      if (m && m.shape && win && !win.isDestroyed()) win.webContents.send('cursor-shape', m.shape);
    });
    p.on('exit', () => {
      if (cursorProc === p) cursorProc = null;
      // crashed while the cursor was hidden -> restore with a fresh helper, viewer falls back to the video cursor
      if (cursorHidden) {
        cursorHidden = false;
        const r = spawnCursorHelper(); if (r) r.send({ cmd: 'restore', exit: true });
        if (win && !win.isDestroyed()) win.webContents.send('cursor-shape', 'none');
      }
    });
    return p;
  } catch (e) { console.error('[cursor]', e.message); return null; }
}
function cursorRestore() {
  if (!cursorProc) return;
  cursorHidden = false;
  try { cursorProc.send({ cmd: 'restore', exit: true }); } catch { /* */ }
  cursorProc = null;
}
// on every start: make sure the cursor is visible (e.g. after a power loss during a session)
if (process.platform === 'win32' && app.isPackaged) {
  const p = spawnCursorHelper(); if (p) p.send({ cmd: 'restore', exit: true });
}
let autoUpdater = null;
try { ({ autoUpdater } = require('electron-updater')); } catch { /* */ }

const fs = require('fs');
const { execFile } = require('child_process');

app.setName('BridgeDesk');

// ---------- настройки на приложението (файл, четим се още преди старта) ----------
const settingsFile = path.join(app.getPath('userData'), 'bridgedesk-settings.json');
function readSettings() { try { return JSON.parse(fs.readFileSync(settingsFile, 'utf8')); } catch { return {}; } }
function writeSettings(patch) {
  const s = { ...readSettings(), ...patch };
  try { fs.mkdirSync(path.dirname(settingsFile), { recursive: true }); fs.writeFileSync(settingsFile, JSON.stringify(s)); } catch { /* */ }
  return s;
}

// ---------- Windows: стартиране като администратор (по подразбиране включено) ----------
let elevate = null;
let isAdmin = false;
if (process.platform === 'win32') {
  try { elevate = require('./elevate'); isAdmin = elevate.isAdmin(); } catch { /* */ }
  const wantAdmin = readSettings().admin === true; // по подразбиране ИЗКЛЮЧЕНО (пречи на заснемането на някои компютри)
  if (elevate && app.isPackaged && wantAdmin && !isAdmin && !process.argv.includes('--no-elevate')) {
    const ok = elevate.relaunchAsAdmin(process.execPath, [...process.argv.slice(1), '--no-elevate']);
    if (ok) { app.exit(0); process.exit(0); }
    // отказано в UAC — продължаваме без администраторски права
  }
}

// Lightweight: no HTTP disk cache (everything is loaded from local files anyway)
app.commandLine.appendSwitch('disable-http-cache');
app.commandLine.appendSwitch('disk-cache-size', '1');

// Съвместим режим на заснемане: без Windows Graphics Capture (ползва DXGI/GDI)
const captureCompat = readSettings().captureCompat === true;
if (process.platform === 'win32' && captureCompat) {
  app.commandLine.appendSwitch('disable-features', 'AllowWgcScreenCapturer,AllowWgcWindowCapturer,AllowWgcZeroHz');
}

if (!app.requestSingleInstanceLock()) { app.quit(); process.exit(0); }

let win = null;
let tray = null;
let keepInTray = true;
let quitting = false;
let selectedSourceId = null;
let inSession = false;

function createWindow() {
  win = new BrowserWindow({
    width: 1100,
    height: 720,
    minWidth: 760,
    minHeight: 560,
    backgroundColor: '#000000',
    title: 'BridgeDesk',
    icon: path.join(__dirname, 'assets', 'icon.png'),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false, // да не се бави картината, когато прозорецът е скрит
    },
  });
  // Без меню: иначе натискане на Alt (напр. Alt+Tab за отсрещния компютър) активира менюто на Electron
  // и то „краде“ клавиатурата и мишката.
  win.removeMenu();
  // MOST_PEER=host:port — само за разработка (локален сигнален сървър)
  win.loadFile(path.join(__dirname, 'web', 'index.html'), process.env.MOST_PEER ? { query: { peer: process.env.MOST_PEER } } : undefined);

  // външни връзки — в браузъра
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });

  // if the page crashes or reloads, never leave the cursor invisible
  win.webContents.on('render-process-gone', () => cursorRestore());
  win.webContents.on('did-start-navigation', () => cursorRestore());
  win.on('close', (e) => {
    if (!quitting && keepInTray) { e.preventDefault(); win.hide(); }
  });
}

function createTray() {
  if (tray) return;
  tray = new Tray(nativeImage.createFromPath(path.join(__dirname, 'assets', 'tray.png')).resize({ width: 18, height: 18 }));
  tray.setToolTip('BridgeDesk — ready to connect');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Show BridgeDesk', click: () => { win.show(); win.focus(); } },
    { type: 'separator' },
    { label: 'Quit', click: () => { quitting = true; app.quit(); } },
  ]));
  tray.on('click', () => { win.show(); win.focus(); });
}

// macOS: нужно е меню „Edit“, за да работят Cmd+C / Cmd+V в полетата за ID и парола.
// По време на сесия го махаме, за да отиват всички клавиши към отсрещния компютър.
const macMenu = process.platform === 'darwin' ? Menu.buildFromTemplate([
  { role: 'appMenu', label: 'BridgeDesk' },
  { role: 'editMenu', label: 'Edit' },
  { role: 'windowMenu', label: 'Window' },
]) : null;
function setMenuForSession(active) {
  Menu.setApplicationMenu(process.platform === 'darwin' && !active ? macMenu : null);
}

app.whenReady().then(() => {
  setMenuForSession(false);
  // clear any cache left from earlier runs
  session.defaultSession.clearCache().catch(() => {});
  session.defaultSession.clearCodeCaches({}).catch(() => {});
  // Разрешения за медия и клипборд само за нашата страница
  session.defaultSession.setPermissionRequestHandler((wc, permission, cb) => {
    cb(['media', 'display-capture', 'clipboard-read', 'clipboard-sanitized-write', 'fullscreen', 'keyboardLock'].includes(permission));
  });

  // getDisplayMedia() в страницата -> даваме избрания екран без системен диалог
  session.defaultSession.setDisplayMediaRequestHandler(async (request, callback) => {
    try {
      const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } });
      const src = sources.find((s) => s.id === selectedSourceId) || sources[0];
      if (!src) return callback({});
      input.setDisplay(src.display_id);
      callback({ video: src });
    } catch (e) {
      console.error('[capture]', e);
      callback({});
    }
  }, { useSystemPicker: false });

  // заключен ли е екранът (Windows/macOS) — тогава не може да се заснема
  powerMonitor.on('lock-screen', () => { screenLocked = true; });
  powerMonitor.on('unlock-screen', () => { screenLocked = false; });

  // macOS: искаме разрешения за „Достъпност“ (управление) и „Запис на екрана“
  if (process.platform === 'darwin') {
    try { systemPreferences.isTrustedAccessibilityClient(true); } catch { /* */ }
    try { systemPreferences.getMediaAccessStatus('screen'); } catch { /* */ }
    // кара macOS да добави BridgeDesk в списъка „Запис на екрана“ и да попита веднага
    desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1, height: 1 } }).catch(() => {});
  }

  createWindow();
  createTray();
  setupUpdates();
});

// ---------- Автоматично обновяване (от GitHub Releases) ----------
let updateState = { state: 'idle' };
function sendUpdate(st) {
  updateState = { ...updateState, ...st };
  if (win && !win.isDestroyed()) win.webContents.send('update', updateState);
}
function checkUpdates() {
  if (!autoUpdater || !app.isPackaged) return sendUpdate({ state: 'none', dev: true });
  sendUpdate({ state: 'checking' });
  autoUpdater.checkForUpdates().catch((e) => sendUpdate({ state: 'error', message: String(e && e.message || e) }));
}
function setupUpdates() {
  if (!autoUpdater || !app.isPackaged) return;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on('update-available', (i) => sendUpdate({ state: 'downloading', version: i.version, percent: 0 }));
  autoUpdater.on('download-progress', (p) => sendUpdate({ state: 'downloading', percent: Math.round(p.percent) }));
  autoUpdater.on('update-downloaded', (i) => {
    sendUpdate({ state: 'ready', version: i.version });
    if (tray) tray.setToolTip('BridgeDesk — new version ' + i.version);
  });
  autoUpdater.on('update-not-available', () => sendUpdate({ state: 'none' }));
  autoUpdater.on('error', (e) => sendUpdate({ state: 'error', message: String(e && e.message || e) }));
  setTimeout(checkUpdates, 5000);
  setInterval(() => { if (!inSession) checkUpdates(); }, 4 * 60 * 60 * 1000);
}
ipcMain.on('update-check', () => checkUpdates());
ipcMain.handle('update-state', () => updateState);
ipcMain.on('update-install', () => {
  if (!autoUpdater || updateState.state !== 'ready') return;
  quitting = true;
  autoUpdater.quitAndInstall(true, true); // тихо инсталиране и стартиране отново
});

app.on('second-instance', () => { if (win) { win.show(); win.focus(); } });
app.on('before-quit', () => { quitting = true; });
app.on('window-all-closed', () => { if (!keepInTray) app.quit(); });
app.on('activate', () => { if (win) win.show(); });

// ---------- IPC ----------
let screenLocked = false;
ipcMain.handle('screen-state', () => ({ locked: screenLocked }));
ipcMain.handle('screens', async () => {
  const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } });
  return sources.map((s, i) => ({ id: s.id, name: s.name || 'Screen ' + (i + 1), displayId: s.display_id }));
});
ipcMain.handle('select-screen', (_e, id) => {
  selectedSourceId = id;
  // за резервния начин на заснемане (getUserMedia) също задаваме дисплея
  desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } })
    .then((src) => { const s = src.find((x) => x.id === id); if (s) input.setDisplay(s.display_id); }).catch(() => {});
  return true;
});
ipcMain.on('input', (_e, msg) => input.handle(msg));
ipcMain.handle('cursor-hide', () => new Promise((resolve) => {
  if (process.platform !== 'win32') return resolve(false);
  if (!cursorProc) cursorProc = spawnCursorHelper();
  if (!cursorProc) return resolve(false);
  const p = cursorProc;
  const t = setTimeout(() => resolve(false), 2000);
  const onMsg = (m) => {
    if (m && 'hidden' in m) { clearTimeout(t); p.off('message', onMsg); cursorHidden = !!m.hidden; resolve(!!m.hidden); }
  };
  p.on('message', onMsg);
  p.send({ cmd: 'hide' });
}));
ipcMain.on('cursor-restore', () => cursorRestore());
ipcMain.handle('input-diag', () => ({ ...input.diag(), isAdmin }));
// ---------- Клипборд: синхронизация в двете посоки по време на сесия ----------
let lastClip = '';
ipcMain.on('set-clipboard', (_e, text) => { lastClip = String(text); clipboard.writeText(lastClip); });
setInterval(() => {
  if (!inSession || !win || win.isDestroyed()) return;
  let t = '';
  try { t = clipboard.readText(); } catch { return; }
  if (t && t !== lastClip) { lastClip = t; win.webContents.send('clip-changed', t.slice(0, 200000)); }
}, 400);
ipcMain.handle('get-clipboard', () => clipboard.readText());
// Автоматичен старт. Windows + администратор -> „Планирана задача“ с най-високи права (иначе Windows не го пуска).
const TASK = 'BridgeDeskAutostart';
function taskExists() {
  return new Promise((res) => execFile('schtasks', ['/Query', '/TN', TASK], { windowsHide: true }, (err) => res(!err)));
}
ipcMain.handle('get-autostart', async () => {
  if (process.platform === 'win32' && isAdmin && await taskExists()) return true;
  return app.getLoginItemSettings().openAtLogin;
});
ipcMain.on('set-autostart', (_e, on) => {
  if (process.platform === 'win32' && isAdmin) {
    app.setLoginItemSettings({ openAtLogin: false });
    if (on) execFile('schtasks', ['/Create', '/TN', TASK, '/TR', `"${process.execPath}" --hidden`, '/SC', 'ONLOGON', '/RL', 'HIGHEST', '/F'], { windowsHide: true }, () => {});
    else execFile('schtasks', ['/Delete', '/TN', TASK, '/F'], { windowsHide: true }, () => {});
    return;
  }
  app.setLoginItemSettings({ openAtLogin: !!on, openAsHidden: true, args: ['--hidden'] });
});
// macOS: състояние на разрешенията и отваряне на правилния екран в Настройки
ipcMain.handle('mac-perms', () => {
  if (process.platform !== 'darwin') return null;
  let screenSt = 'unknown', access = false;
  try { screenSt = systemPreferences.getMediaAccessStatus('screen'); } catch { /* */ }
  try { access = systemPreferences.isTrustedAccessibilityClient(false); } catch { /* */ }
  return { screen: screenSt === 'granted', access };
});
ipcMain.on('mac-open-settings', (_e, which) => {
  const pane = which === 'screen' ? 'Privacy_ScreenCapture' : 'Privacy_Accessibility';
  if (which !== 'screen') { try { systemPreferences.isTrustedAccessibilityClient(true); } catch { /* */ } }
  shell.openExternal('x-apple.systempreferences:com.apple.preference.security?' + pane);
});
ipcMain.on('relaunch', () => { quitting = true; app.relaunch(); app.exit(0); });
ipcMain.handle('get-admin', () => ({ supported: process.platform === 'win32', isAdmin, want: readSettings().admin === true }));
ipcMain.on('set-admin', (_e, on) => { writeSettings({ admin: !!on }); });
// Самопоправка при неуспешно заснемане: сменяме режима и стартираме отново (без администратор)
ipcMain.on('recover', (_e, kind) => {
  if (kind === 'admin') writeSettings({ admin: false });
  if (kind === 'compat') writeSettings({ captureCompat: true });
  quitting = true;
  app.releaseSingleInstanceLock();
  if (process.platform === 'win32' && isAdmin && app.isPackaged) {
    // explorer.exe стартира програмата с правата на потребителя (не като администратор)
    execFile('explorer.exe', [process.execPath], { windowsHide: true }, () => {});
  } else {
    app.relaunch({ args: process.argv.slice(1).filter((a) => a !== '--hidden') });
  }
  setTimeout(() => app.exit(0), 300);
});
ipcMain.on('relaunch-admin', () => {
  if (!elevate) return;
  app.releaseSingleInstanceLock();
  const ok = elevate.relaunchAsAdmin(process.execPath, [...process.argv.slice(1).filter((a) => a !== '--no-elevate'), '--no-elevate']);
  if (ok) { quitting = true; app.exit(0); } else app.requestSingleInstanceLock();
});
ipcMain.on('set-tray', (_e, on) => { keepInTray = !!on; });
ipcMain.on('focus', () => { if (win) { win.show(); win.focus(); win.flashFrame(true); } });
ipcMain.on('session-state', (_e, active, name) => {
  if (!active) cursorRestore();
  if (active && !inSession) { try { lastClip = clipboard.readText(); } catch { /* */ } }
  inSession = !!active;
  setMenuForSession(inSession);
  if (!tray) return;
  tray.setToolTip(active ? (name === 'view' ? 'BridgeDesk — connected to another computer' : 'BridgeDesk — ' + name + ' is connected') : 'BridgeDesk — ready to connect');
  if (!active && win) win.flashFrame(false);
});
ipcMain.on('info-sync', (e) => { e.returnValue = { hostname: os.hostname(), platform: process.platform, version: app.getVersion(), input: input.mode(), isAdmin, captureCompat }; });

// стартиране скрито при автоматичен старт
if (process.argv.includes('--hidden')) {
  app.whenReady().then(() => setTimeout(() => win && win.hide(), 50));
}

// при изход пускаме всички натиснати клавиши
app.on('will-quit', () => { input.handle({ t: 'ka' }); cursorRestore(); });

// излагаме screen за input.js (налично чак след ready)
app.whenReady().then(() => {
  input.init(screen);
  let lastWarn = 0;
  input.setOnBlocked(() => {
    const now = Date.now();
    if (now - lastWarn < 8000 || !win || win.isDestroyed()) return;
    lastWarn = now;
    win.webContents.send('input-blocked', { isAdmin });
  });
});
