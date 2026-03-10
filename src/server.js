const { WebSocketServer } = require('ws');
const { v4: uuidv4 } = require('uuid');
const http = require('http');
const os = require('os');

class Server {
  constructor({ name, password, port }) {
    this.name = name || 'My Server';
    this.password = password || '';
    this.port = port || 0;
    this.id = uuidv4().replace(/-/g, '').slice(0, 16);
    this.httpServer = null;
    this.wss = null;
    this.clients = new Map(); // peerId -> { ws, username, muted }
  }

  start() {
    return new Promise((resolve, reject) => {
      this.httpServer = http.createServer();
      this.wss = new WebSocketServer({ server: this.httpServer });

      this.wss.on('connection', (ws) => this._onConnection(ws));

      this.httpServer.listen(this.port, '0.0.0.0', () => {
        const addr = this.httpServer.address();
        this.port = addr.port;
        const ip = this._getLocalIp();
        resolve({ ip, port: this.port, id: this.id, name: this.name });
      });

      this.httpServer.on('error', reject);
    });
  }

  stop() {
    if (this.wss) {
      for (const [, client] of this.clients) {
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

  _onConnection(ws) {
    let peerId = null;
    let authenticated = false;

    const sendJson = (data) => {
      if (ws.readyState === 1) ws.send(JSON.stringify(data));
    };

    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw);
      } catch {
        return;
      }

      // Auth handshake
      if (msg.type === 'auth') {
        if (this.password && msg.password !== this.password) {
          sendJson({ type: 'auth-fail', reason: 'Wrong password' });
          ws.close(4001, 'Wrong password');
          return;
        }
        peerId = msg.peerId || uuidv4().slice(0, 8);
        authenticated = true;
        this.clients.set(peerId, { ws, username: msg.username || 'Anon' });

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
        sendJson({ type: 'error', reason: 'Not authenticated' });
        return;
      }

      // Chat message
      if (msg.type === 'chat') {
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
          target.ws.send(JSON.stringify({
            type: 'signal',
            from: peerId,
            signal: msg.signal,
          }));
        }
        return;
      }
    });

    ws.on('close', () => {
      if (peerId && this.clients.has(peerId)) {
        this.clients.delete(peerId);
        this._broadcast({ type: 'peer-leave', peerId });
      }
    });
  }

  _broadcast(msg, excludePeerId) {
    const raw = JSON.stringify(msg);
    for (const [id, client] of this.clients) {
      if (id !== excludePeerId && client.ws.readyState === 1) {
        client.ws.send(raw);
      }
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
