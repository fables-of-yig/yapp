const { WebSocketServer } = require('ws');
const { v4: uuidv4 } = require('uuid');
const http = require('http');
const os = require('os');

function log(tag, ...args) {
  const ts = new Date().toISOString();
  console.log(`[${ts}] [server:${tag}]`, ...args);
}

class Server {
  constructor({ name, password, port }) {
    this.name = name || 'My Server';
    this.password = password || '';
    this.port = port || 0;
    this.id = uuidv4().replace(/-/g, '').slice(0, 16);
    this.httpServer = null;
    this.wss = null;
    this.clients = new Map(); // peerId -> { ws, username, muted }
    log('init', `Created server: name="${this.name}", id=${this.id}, port=${this.port || 'auto'}, password=${this.password ? 'yes' : 'none'}`);
  }

  start() {
    return new Promise((resolve, reject) => {
      this.httpServer = http.createServer();
      this.wss = new WebSocketServer({ server: this.httpServer });

      this.wss.on('connection', (ws, req) => {
        const remoteAddr = req.socket.remoteAddress;
        const remotePort = req.socket.remotePort;
        log('conn', `New WebSocket connection from ${remoteAddr}:${remotePort}`);
        this._onConnection(ws, remoteAddr);
      });

      this.wss.on('error', (err) => {
        log('error', `WebSocketServer error: ${err.message}`);
      });

      this.httpServer.listen(this.port, '0.0.0.0', () => {
        const addr = this.httpServer.address();
        this.port = addr.port;
        const ip = this._getLocalIp();
        log('listen', `Listening on 0.0.0.0:${this.port} (local IP: ${ip})`);
        resolve({ ip, port: this.port, id: this.id, name: this.name });
      });

      this.httpServer.on('error', (err) => {
        log('error', `HTTP server error: ${err.message}`);
        if (err.code === 'EADDRINUSE') {
          log('error', `Port ${this.port} is already in use`);
        } else if (err.code === 'EACCES') {
          log('error', `Permission denied for port ${this.port} (try a port > 1024)`);
        }
        reject(err);
      });
    });
  }

  stop() {
    log('stop', `Stopping server (${this.clients.size} connected clients)`);
    if (this.wss) {
      for (const [id, client] of this.clients) {
        log('stop', `Closing connection for peer ${id} (${client.username})`);
        client.ws.close(1000, 'Server shutting down');
      }
      this.clients.clear();
      this.wss.close();
      this.wss = null;
    }
    if (this.httpServer) {
      this.httpServer.close();
      this.httpServer = null;
    }
    log('stop', 'Server stopped');
  }

  getInfo() {
    return {
      name: this.name,
      id: this.id,
      port: this.port,
      ip: this._getLocalIp(),
      clientCount: this.clients.size,
    };
  }

  _onConnection(ws, remoteAddr) {
    let peerId = null;
    let authenticated = false;

    const sendJson = (data) => {
      if (ws.readyState === 1) {
        ws.send(JSON.stringify(data));
      } else {
        log('warn', `Tried to send ${data.type} but WebSocket not open (state=${ws.readyState})`);
      }
    };

    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw);
      } catch (err) {
        log('warn', `Invalid JSON from ${remoteAddr}: ${err.message}, raw=${String(raw).slice(0, 100)}`);
        return;
      }

      // Auth handshake
      if (msg.type === 'auth') {
        log('auth', `Auth attempt from ${remoteAddr}: username="${msg.username || 'Anon'}", password=${msg.password ? 'provided' : 'none'}`);
        if (this.password && msg.password !== this.password) {
          log('auth', `Auth REJECTED for ${remoteAddr}: wrong password`);
          sendJson({ type: 'auth-fail', reason: 'Wrong password' });
          ws.close(4001, 'Wrong password');
          return;
        }
        peerId = msg.peerId || uuidv4().slice(0, 8);
        authenticated = true;
        this.clients.set(peerId, { ws, username: msg.username || 'Anon' });

        log('auth', `Auth OK: ${msg.username || 'Anon'} -> peerId=${peerId} (${this.clients.size} total clients)`);

        sendJson({
          type: 'auth-ok',
          peerId,
          serverName: this.name,
          peers: this._peerList(),
        });

        // Announce to others
        this._broadcast({ type: 'peer-join', peerId, username: msg.username || 'Anon' }, peerId);
        return;
      }

      if (!authenticated) {
        log('warn', `Unauthenticated message type="${msg.type}" from ${remoteAddr}`);
        sendJson({ type: 'error', reason: 'Not authenticated' });
        return;
      }

      // Chat message
      if (msg.type === 'chat') {
        log('chat', `[${peerId}] ${this.clients.get(peerId)?.username}: ${(msg.text || '').slice(0, 80)}${(msg.text || '').length > 80 ? '...' : ''}`);
        this._broadcast({
          type: 'chat',
          from: peerId,
          username: this.clients.get(peerId)?.username,
          text: msg.text,
          ts: Date.now(),
        });
        return;
      }

      // File share (metadata + base64 data — simple approach)
      if (msg.type === 'file') {
        const sizeKB = msg.size ? (msg.size / 1024).toFixed(1) : '?';
        log('file', `[${peerId}] ${this.clients.get(peerId)?.username} sharing file: "${msg.name}" (${sizeKB} KB)`);
        this._broadcast({
          type: 'file',
          from: peerId,
          username: this.clients.get(peerId)?.username,
          name: msg.name,
          size: msg.size,
          data: msg.data,
          ts: Date.now(),
        });
        return;
      }

      // WebRTC signaling relay
      if (msg.type === 'signal') {
        const target = this.clients.get(msg.to);
        if (target) {
          log('signal', `Relaying ${msg.signal?.type || 'signal'} from ${peerId} -> ${msg.to}`);
          target.ws.send(JSON.stringify({
            type: 'signal',
            from: peerId,
            signal: msg.signal,
          }));
        } else {
          log('signal', `Signal target ${msg.to} not found (from ${peerId})`);
        }
        return;
      }

      log('warn', `Unknown message type "${msg.type}" from peer ${peerId}`);
    });

    ws.on('close', (code, reason) => {
      const reasonStr = reason ? reason.toString() : 'none';
      if (peerId && this.clients.has(peerId)) {
        const username = this.clients.get(peerId).username;
        this.clients.delete(peerId);
        log('conn', `Peer disconnected: ${username} (${peerId}), code=${code}, reason="${reasonStr}" (${this.clients.size} remaining)`);
        this._broadcast({ type: 'peer-leave', peerId });
      } else {
        log('conn', `Unauthenticated connection closed from ${remoteAddr}, code=${code}, reason="${reasonStr}"`);
      }
    });

    ws.on('error', (err) => {
      log('error', `WebSocket error for ${peerId || remoteAddr}: ${err.message}`);
    });
  }

  _broadcast(msg, excludePeerId) {
    const raw = JSON.stringify(msg);
    let sent = 0;
    for (const [id, client] of this.clients) {
      if (id !== excludePeerId && client.ws.readyState === 1) {
        client.ws.send(raw);
        sent++;
      }
    }
    if (msg.type !== 'signal') {
      log('broadcast', `${msg.type} sent to ${sent}/${this.clients.size} peers${excludePeerId ? ` (excluding ${excludePeerId})` : ''}`);
    }
  }

  _peerList() {
    const list = [];
    for (const [id, client] of this.clients) {
      list.push({ peerId: id, username: client.username });
    }
    return list;
  }

  _getLocalIp() {
    const nets = os.networkInterfaces();
    for (const iface of Object.values(nets)) {
      for (const cfg of iface) {
        if (cfg.family === 'IPv4' && !cfg.internal) return cfg.address;
      }
    }
    return '127.0.0.1';
  }
}

module.exports = Server;
