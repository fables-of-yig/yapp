const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const http = require('http');
const https = require('https');
const Server = require('./src/server');
const { encode, decode } = require('./src/codec');
const Store = require('./src/store');
const os = require('os');
const natUpnp = require('nat-upnp');

let mainWindow;
let server = null;
let upnpClient = null;
let mappedPort = null;
const store = new Store();

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 900,
    height: 650,
    minWidth: 700,
    minHeight: 500,
    title: 'Yakk',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'src', 'index.html'));
  mainWindow.setMenuBarVisibility(false);

  if (process.argv.includes('--dev')) {
    mainWindow.webContents.openDevTools();
  }
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => {
  cleanupServer();
  app.quit();
});

// ── Fetch public IP ────────────────────────────────────────────────────
function fetchPublicIp() {
  return new Promise((resolve) => {
    const req = https.get('https://api.ipify.org', { timeout: 5000 }, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => resolve(data.trim()));
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

// ── UPnP port mapping ──────────────────────────────────────────────────
function mapPort(port) {
  return new Promise((resolve) => {
    upnpClient = natUpnp.createClient();
    upnpClient.portMapping({
      public: port,
      private: port,
      ttl: 0,
      description: 'Yakk Server',
    }, (err) => {
      if (err) {
        resolve(false);
      } else {
        mappedPort = port;
        resolve(true);
      }
    });
  });
}

function unmapPort() {
  return new Promise((resolve) => {
    if (!upnpClient || !mappedPort) { resolve(); return; }
    upnpClient.portUnmapping({ public: mappedPort }, () => {
      mappedPort = null;
      resolve();
    });
  });
}

function cleanupServer() {
  if (server) {
    server.stop();
    server = null;
  }
  unmapPort();
}

// ── Host a server ──────────────────────────────────────────────────────
ipcMain.handle('host-server', async (_e, { name, password, port }) => {
  try {
    cleanupServer();
    server = new Server({ name, password, port: port || 0 });
    const info = await server.start();

    // Try UPnP + public IP in parallel
    const [upnpOk, publicIp] = await Promise.all([
      mapPort(info.port),
      fetchPublicIp(),
    ]);

    const ip = publicIp || info.ip;
    const code = encode(ip, info.port, info.id);

    return {
      ok: true,
      code,
      publicIp: publicIp || null,
      localIp: info.ip,
      port: info.port,
      upnp: upnpOk,
      name: info.name,
      id: info.id,
    };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('stop-server', async () => {
  cleanupServer();
  return { ok: true };
});

ipcMain.handle('get-server-status', () => {
  if (!server) return { running: false };
  return { running: true, ...server.getInfo() };
});

// ── Connection code helpers ────────────────────────────────────────────
ipcMain.handle('decode-code', (_e, code) => {
  try {
    return { ok: true, ...decode(code) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// ── Saved servers ──────────────────────────────────────────────────────
ipcMain.handle('get-saved-servers', () => store.getServers());
ipcMain.handle('save-server', (_e, entry) => {
  store.saveServer(entry);
  return { ok: true };
});
ipcMain.handle('remove-server', (_e, code) => {
  store.removeServer(code);
  return { ok: true };
});

// ── File picker ────────────────────────────────────────────────────────
ipcMain.handle('pick-file', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile'],
    filters: [{ name: 'All Files', extensions: ['*'] }],
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  const filePath = result.filePaths[0];
  const fs = require('fs');
  const stats = fs.statSync(filePath);
  if (stats.size > 100 * 1024 * 1024) {
    return { error: 'File too large (max 100MB)' };
  }
  const data = fs.readFileSync(filePath);
  return {
    name: path.basename(filePath),
    size: stats.size,
    data: data.toString('base64'),
  };
});

// ── Save file ──────────────────────────────────────────────────────────
ipcMain.handle('save-file', async (_e, { name, data }) => {
  const result = await dialog.showSaveDialog(mainWindow, {
    defaultPath: name,
  });
  if (result.canceled) return { ok: false };
  const fs = require('fs');
  fs.writeFileSync(result.filePath, Buffer.from(data, 'base64'));
  return { ok: true };
});
