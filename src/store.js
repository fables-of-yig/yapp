const fs = require('fs');
const path = require('path');
const { app } = require('electron');

class Store {
  constructor() {
    const userDir = app.getPath('userData');
    this.filePath = path.join(userDir, 'servers.json');
    this._data = this._load();
  }

  _load() {
    try {
      return JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
    } catch {
      return { servers: [] };
    }
  }

  _save() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.writeFileSync(this.filePath, JSON.stringify(this._data, null, 2));
  }

  getServers() {
    return this._data.servers;
  }

  saveServer(entry) {
    // entry: { code, name, password? }
    const idx = this._data.servers.findIndex((s) => s.code === entry.code);
    if (idx >= 0) {
      this._data.servers[idx] = entry;
    } else {
      this._data.servers.push(entry);
    }
    this._save();
  }

  removeServer(code) {
    this._data.servers = this._data.servers.filter((s) => s.code !== code);
    this._save();
  }
}

module.exports = Store;
