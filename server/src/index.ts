import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import express from 'express';
import { WebSocketServer, type WebSocket } from 'ws';

import { RoomRegistry } from './rooms';
import type { ClientMessage, ServerMessage } from '../../shared/signaling';

const PORT = Number(process.env.PORT ?? 8080);
const HEARTBEAT_INTERVAL_MS = 30_000;

const here = path.dirname(fileURLToPath(import.meta.url));
const clientDist = path.resolve(here, '../../dist/client');

const rooms = new RoomRegistry();
/** clientId → 连接。信令服务器只按 id 转发，不关心内容。 */
const sockets = new Map<string, WebSocket>();

function send(clientId: string, message: ServerMessage): void {
  const socket = sockets.get(clientId);
  if (socket === undefined || socket.readyState !== socket.OPEN) return;
  socket.send(JSON.stringify(message));
}

function handleMessage(clientId: string, message: ClientMessage): void {
  switch (message.type) {
    case 'join': {
      const result = rooms.join(clientId, message.roomId);
      if (!result.ok) {
        send(clientId, { type: 'error', reason: result.reason });
        return;
      }
      send(clientId, { type: 'joined', roomId: message.roomId, role: result.role });
      for (const peerId of result.peerIds) send(peerId, { type: 'peer-joined' });
      return;
    }

    case 'offer':
    case 'answer':
    case 'ice-candidate': {
      if (!rooms.isInRoom(clientId)) {
        send(clientId, { type: 'error', reason: 'not-in-room' });
        return;
      }
      // 原样转发。服务器从不解析 SDP —— 它只是个邮差。
      // 房间里暂时只有自己时静默丢弃（对端刚断开的竞态），不算错误。
      for (const peerId of rooms.peersOf(clientId)) send(peerId, message);
      return;
    }

    case 'leave': {
      const result = rooms.leave(clientId);
      if (result === null) return;
      for (const peerId of result.peerIds) send(peerId, { type: 'peer-left' });
      return;
    }

    default:
      send(clientId, { type: 'error', reason: 'bad-message' });
  }
}

const app = express();

app.get('/healthz', (_req, res) => {
  res.json({ ok: true, rooms: rooms.roomCount, clients: sockets.size });
});

// 生产模式（npm run build && npm start）下由同一个进程托管前端，
// 这样 WebSocket 和页面同源，不用额外配置。开发模式走 vite dev server。
if (existsSync(clientDist)) {
  app.use(express.static(clientDist));
  // 兜底回 index.html。用 app.use 而不是 app.get('*')：
  // Express 5 换了 path-to-regexp，裸 '*' 通配已经不再合法。
  app.use((_req, res) => {
    res.sendFile(path.join(clientDist, 'index.html'));
  });
}

const server = createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (socket) => {
  const clientId = randomUUID();
  sockets.set(clientId, socket);

  let alive = true;
  socket.on('pong', () => {
    alive = true;
  });

  const heartbeat = setInterval(() => {
    if (!alive) {
      socket.terminate();
      return;
    }
    alive = false;
    socket.ping();
  }, HEARTBEAT_INTERVAL_MS);

  socket.on('message', (raw) => {
    let message: ClientMessage;
    try {
      message = JSON.parse(raw.toString()) as ClientMessage;
    } catch {
      send(clientId, { type: 'error', reason: 'bad-message' });
      return;
    }
    handleMessage(clientId, message);
  });

  socket.on('close', () => {
    clearInterval(heartbeat);
    sockets.delete(clientId);
    const result = rooms.leave(clientId);
    if (result === null) return;
    for (const peerId of result.peerIds) send(peerId, { type: 'peer-left' });
  });

  socket.on('error', () => {
    socket.terminate();
  });
});

server.listen(PORT, () => {
  console.log(`[signaling] ws://localhost:${PORT}/ws`);
  if (existsSync(clientDist)) console.log(`[static]    http://localhost:${PORT}`);
});
