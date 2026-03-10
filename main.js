const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const http = require('http');
const https = require('https');
const Server = require('./src/server');
const { encode, decode } = require('./src/codec');
const Store = require('./src/store');
const os = require('os');
const natUpnp = require('nat-upnp');

// ── Logging ──────────────────────────────────────────────────────────
function log(tag, ...args) {
  const ts = new Date().toISOString();
  console.log(`[${ts}] [${tag}]`, ...args);
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('log', `[${tag}] ${args.map(a => typeof a === 'object' ? JSON.stringify(a) : a).join(' ')}`);
  }
}

// ── GitHub update config ──────────────────────────────────────────────
const GITHUB_OWNER = 'fables-of-yig';
const GITHUB_REPO = 'yapp';
const CURRENT_VERSION = require('./package.json').version;

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
    title: 'Yapp',
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

  log('app', `Yapp v${CURRENT_VERSION} started`);
  log('app', `Platform: ${process.platform}, Arch: ${process.arch}, Electron: ${process.versions.electron}`);
  log('app', `Node: ${process.versions.node}`);
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => {
  log('app', 'All windows closed, shutting down');
  cleanupServer();
  app.quit();
});

// ── NAT / CGNAT detection ─────────────────────────────────────────────
function isCgnatAddress(ip) {
  const parts = ip.split('.').map(Number);
  // RFC 6598: 100.64.0.0/10 = 100.64.0.0 - 100.127.255.255
  return parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127;
}

function isPrivateAddress(ip) {
  const parts = ip.split('.').map(Number);
  if (parts[0] === 10) return true;
  if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
  if (parts[0] === 192 && parts[1] === 168) return true;
  return false;
}

// ── Fetch public IP ────────────────────────────────────────────────────
function fetchPublicIp() {
  log('net', 'Fetching public IP from api.ipify.org...');
  return new Promise((resolve) => {
    const req = https.get('https://api.ipify.org', { timeout: 5000 }, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        const ip = data.trim();
        log('net', `Public IP response: "${ip}" (status ${res.statusCode})`);
        resolve(ip);
      });
    });
    req.on('error', (err) => {
      log('net', `Public IP fetch failed: ${err.message}`);
      resolve(null);
    });
    req.on('timeout', () => {
      log('net', 'Public IP fetch timed out (5s)');
      req.destroy();
      resolve(null);
    });
  });
}

// ── UPnP port mapping ──────────────────────────────────────────────────
function mapPort(port) {
  log('upnp', `Attempting UPnP port mapping for port ${port}...`);
  return new Promise((resolve) => {
    upnpClient = natUpnp.createClient();
    upnpClient.portMapping({
      public: port,
      private: port,
      ttl: 0,
      description: 'Yapp Server',
    }, (err) => {
      if (err) {
        log('upnp', `UPnP mapping failed: ${err.message}`);
        resolve(false);
      } else {
        log('upnp', `UPnP mapping succeeded: public ${port} -> private ${port}`);
        mappedPort = port;
        resolve(true);
      }
    });
  });
}

function unmapPort() {
  return new Promise((resolve) => {
    if (!upnpClient || !mappedPort) { resolve(); return; }
    log('upnp', `Removing UPnP mapping for port ${mappedPort}`);
    upnpClient.portUnmapping({ public: mappedPort }, (err) => {
      if (err) log('upnp', `UPnP unmap error (non-critical): ${err.message}`);
      else log('upnp', 'UPnP mapping removed');
      mappedPort = null;
      resolve();
    });
  });
}

function cleanupServer() {
  log('server', 'Cleaning up server...');
  if (server) {
    server.stop();
    server = null;
    log('server', 'Server stopped');
  }
  unmapPort();
}

// ── Host a server ──────────────────────────────────────────────────────
ipcMain.handle('host-server', async (_e, { name, password, port }) => {
  log('host', `Host requested: name="${name}", password=${password ? 'yes' : 'none'}, port=${port || 'auto'}`);
  try {
    cleanupServer();
    server = new Server({ name, password, port: port || 0 });
    const info = await server.start();
    log('host', `Server listening: ${info.ip}:${info.port}, id=${info.id}`);

    // Try UPnP + public IP in parallel
    log('host', 'Starting UPnP mapping and public IP fetch in parallel...');
    const [upnpOk, publicIp] = await Promise.all([
      mapPort(info.port),
      fetchPublicIp(),
    ]);

    // Network diagnosis
    const cgnat = isCgnatAddress(info.ip);
    const localIsPrivate = isPrivateAddress(info.ip);
    const behindNat = publicIp && publicIp !== info.ip;

    log('host', `Results: publicIp=${publicIp || 'none'}, localIp=${info.ip}, upnp=${upnpOk}`);
    log('host', `NAT analysis: cgnat=${cgnat}, localIsPrivate=${localIsPrivate}, behindNat=${behindNat}`);

    if (cgnat) {
      log('host', 'WARNING: Local IP is in RFC 6598 range (100.64.x.x) — CGNAT detected! Hosting will NOT work from the internet.');
    } else if (behindNat && !upnpOk) {
      log('host', 'WARNING: Behind NAT and UPnP failed. Port may not be forwarded.');
    } else if (!behindNat && publicIp) {
      log('host', 'Public IP matches expectations — direct connection or properly forwarded');
    }
    if (!publicIp) {
      log('host', 'WARNING: Could not determine public IP. Server may only be reachable on LAN.');
    }

    const ip = publicIp || info.ip;
    const code = encode(ip, info.port, info.id);
    log('host', `Generated connection code: ${code} (for ${ip}:${info.port})`);

    return {
      ok: true,
      code,
      publicIp: publicIp || null,
      localIp: info.ip,
      port: info.port,
      upnp: upnpOk,
      cgnat,
      name: info.name,
      id: info.id,
    };
  } catch (err) {
    log('host', `ERRROR: Failed to start server: ${err.message}`);
    log('host', err.stack);
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('stop-server', async () => {
  log('host', 'Stop server requested');
  cleanupServer();
  return { ok: true };
});

ipcMain.handle('get-server-status', () => {
  if (!server) return { running: false };
  return { running: true, ...server.getInfo() };
});

// ── Connection code helpers ────────────────────────────────────────────
ipcMain.handle('decode-code', (_e, code) => {
  log('codec', `Decoding connection code: ${code}`);
  try {
    const result = decode(code);
    log('codec', `Decoded: ip=${result.ip}, port=${result.port}, serverId=${result.serverId}`);
    return { ok: true, ...result };
  } catch (err) {
    log('codec', `Decode failed: ${err.message}`);
    return { ok: false, error: err.message };
  }
});

// ── Saved servers ──────────────────────────────────────────────────────
ipcMain.handle('get-saved-servers', () => store.getServers());
ipcMain.handle('save-server', (_e, entry) => {
  log('store', `Saving server: ${entry.name} (${entry.code})`);
  store.saveServer(entry);
  return { ok: true };
});
ipcMain.handle('remove-server', (_e, code) => {
  log('store', `Removing server: ${code}`);
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
  log('file', `File selected: ${path.basename(filePath)}, size=${stats.size} bytes`);
  if (stats.size > 100 * 1024 * 1024) {
    log('file', 'File rejected: exceeds 100MB limit');
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
  log('file', `Saving file: ${result.filePath}`);
  fs.writeFileSync(result.filePath, Buffer.from(data, 'base64'));
  return { ok: true };
});

// ── Check for updates ────────────────────────────────────────────────
function checkForUpdates() {
  log('update', `Checking for updates (current: v${CURRENT_VERSION})...`);
  return new Promise((resolve) => {
    const url = `https://raw.githubusercontent.com/${GITHUB_OWNER}/${GITHUB_REPO}/main/package.json`;
    log('update', `Fetching: ${url}`);
    const req = https.get(url, { headers: { 'User-Agent': 'Yapp-Updater' }, timeout: 10000 }, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        log('update', `Response status: ${res.statusCode}`);
        if (res.statusCode !== 200) {
          log('update', `Unexpected status. Body: ${data.slice(0, 200)}`);
          resolve({ ok: false, error: `GitHub returned ${res.statusCode}` });
          return;
        }
        try {
          const remote = JSON.parse(data);
          const latest = remote.version;
          const upToDate = latest === CURRENT_VERSION;
          log('update', `Remote version: v${latest}, up to date: ${upToDate}`);
          resolve({ ok: true, upToDate, current: CURRENT_VERSION, latest });
        } catch (err) {
          log('update', `Parse error: ${err.message}, body: ${data.slice(0, 200)}`);
          resolve({ ok: false, error: 'Failed to parse remote package.json' });
        }
      });
    });
    req.on('error', (err) => {
      log('update', `Request error: ${err.message}`);
      resolve({ ok: false, error: err.message });
    });
    req.on('timeout', () => {
      log('update', 'Request timed out (10s)');
      req.destroy();
      resolve({ ok: false, error: 'Request timed out' });
    });
  });
}

ipcMain.handle('check-for-updates', async () => {
  return checkForUpdates();
});
