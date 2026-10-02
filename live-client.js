// A socket only invalidates the comparison; all scores use the gated HTTP API.
export class FightLive {
  constructor({ onChange, onStatus = () => {}, Socket = WebSocket, base = location.href }) {
    Object.assign(this, { onChange, onStatus, Socket, base });
    this.key = ''; this.socket = null; this.connected = false; this.attempt = 0;
  }
  watch(user, card) {
    const key = user && card ? `${user}:${card}` : '';
    if (key === this.key) return;
    this.stop(); this.key = key;
    if (key) { this.user = user; this.card = card; this.connect(); }
  }
  stop() {
    this.key = ''; this.connected = false;
    clearTimeout(this.retry); clearTimeout(this.renew); clearTimeout(this.change);
    clearInterval(this.heartbeat);
    const socket = this.socket; this.socket = null;
    if (socket) socket.close();
    this.attempt = 0;
  }
  connect() {
    if (!this.key) return;
    const url = new URL('/api/live', this.base);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    url.search = new URLSearchParams({ user: this.user, card: this.card });
    let socket;
    try { socket = new this.Socket(url); } catch { this.reconnect(); return; }
    this.socket = socket;
    let lastPong = Date.now();
    socket.onopen = () => {
      if (this.socket !== socket) return;
      this.connected = true; this.attempt = 0; this.onStatus();
      this.onChange(); // Recover changes missed during a disconnection.
      this.heartbeat = setInterval(() => {
        if (Date.now() - lastPong > 70000) { socket.close(); return; }
        socket.send('ping');
      }, 25000);
      this.renew = setTimeout(() => socket.close(), 25 * 60 * 1000);
    };
    socket.onmessage = event => {
      if (this.socket !== socket) return;
      if (event.data === 'pong') { lastPong = Date.now(); return; }
      if (event.data !== 'changed') return;
      clearTimeout(this.change);
      this.change = setTimeout(() => { if (this.socket === socket) this.onChange(); }, 250);
    };
    socket.onerror = () => socket.close();
    socket.onclose = () => {
      if (this.socket !== socket) return;
      this.socket = null; this.connected = false;
      clearInterval(this.heartbeat); clearTimeout(this.renew); clearTimeout(this.change);
      this.onStatus(); this.reconnect();
    };
  }
  reconnect() {
    if (!this.key) return;
    const delay = Math.min(30000, 1000 * 2 ** this.attempt++) + Math.random() * 500;
    this.retry = setTimeout(() => this.connect(), delay);
  }
}
