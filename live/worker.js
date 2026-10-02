import { DurableObject } from 'cloudflare:workers';
// No public entry point: rooms are reachable only through the Pages binding.
export default { fetch() { return new Response('Not found', { status: 404 }); } };
export class FightRoom extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }
  async fetch(request) {
    if (request.headers.get('Upgrade') !== 'websocket') return new Response('Upgrade required', { status: 426 });
    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ expires: Date.now() + 30 * 60 * 1000 });
    return new Response(null, { status: 101, webSocket: client });
  }
  async changed() {
    for (const ws of this.ctx.getWebSockets()) {
      try {
        if (ws.deserializeAttachment()?.expires <= Date.now()) ws.close(1000, 'Reconnect');
        else ws.send('changed');
      } catch { /* A disconnected client must not affect other subscribers. */ }
    }
  }
  webSocketMessage(ws) { ws.close(1008, 'Notifications only'); }
  webSocketClose(ws, code, reason) { ws.close(code, reason); }
  webSocketError(ws) { ws.close(1011, 'Connection error'); }
}
