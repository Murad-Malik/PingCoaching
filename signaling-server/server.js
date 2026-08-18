// PingCoach signaling server
//
// This is intentionally tiny and dumb. Its only job is to let a "host" (the person
// sharing their screen) and a "viewer" (the coach) find each other by a short room
// code, and pass WebRTC handshake messages (SDP offers/answers, ICE candidates)
// between them. Once that handshake finishes, the video stream and the pings both
// travel directly between the two computers (WebRTC peer-to-peer) - this server
// never sees any of that traffic, only the initial connection setup.
//
// Run it with: node server.js  (or npm start)
// It listens on process.env.PORT or 8787 by default.

const http = require('http');
const { WebSocketServer } = require('ws');
const crypto = require('crypto');

const PORT = process.env.PORT || 8787;

// room code -> { host: WebSocket|null, viewer: WebSocket|null }
const rooms = new Map();

function generateRoomCode() {
  // 6 uppercase alphanumeric characters, easy to read aloud/type, e.g. "K3F9QZ".
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I to avoid confusion
  let code;
  do {
    code = Array.from({ length: 6 }, () => alphabet[crypto.randomInt(alphabet.length)]).join('');
  } while (rooms.has(code));
  return code;
}

function send(ws, message) {
  if (ws && ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(message));
  }
}

function cleanupSocket(ws) {
  const room = ws.roomCode ? rooms.get(ws.roomCode) : null;
  if (!room) return;

  if (room.host === ws) room.host = null;
  if (room.viewer === ws) room.viewer = null;

  const other = room.host || room.viewer;
  send(other, { type: 'peer-left' });

  if (!room.host && !room.viewer) {
    rooms.delete(ws.roomCode);
  }
}

const httpServer = http.createServer((req, res) => {
  // Simple health check so you can confirm the server is reachable, e.g. after
  // deploying it, by hitting http://your-server:8787/ in a browser.
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end(`PingCoach signaling server is running. Active rooms: ${rooms.size}\n`);
});

const wss = new WebSocketServer({ server: httpServer });

wss.on('connection', (ws) => {
  ws.roomCode = null;
  ws.role = null;

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch (err) {
      send(ws, { type: 'error', message: 'Malformed message (expected JSON).' });
      return;
    }

    switch (msg.type) {
      case 'host': {
        const room = { host: ws, viewer: null };
        const code = generateRoomCode();
        rooms.set(code, room);
        ws.roomCode = code;
        ws.role = 'host';
        send(ws, { type: 'host-ok', room: code });
        break;
      }

      case 'join': {
        const room = rooms.get(msg.room);
        if (!room) {
          send(ws, { type: 'error', message: `No session found for room "${msg.room}".` });
          return;
        }
        if (room.viewer) {
          send(ws, { type: 'error', message: `Room "${msg.room}" already has a viewer connected.` });
          return;
        }
        room.viewer = ws;
        ws.roomCode = msg.room;
        ws.role = 'viewer';
        send(ws, { type: 'join-ok', room: msg.room });
        send(room.host, { type: 'peer-joined' });
        break;
      }

      // Opaque relay: whatever the sender puts in `data` (an SDP offer/answer or an
      // ICE candidate) gets forwarded verbatim to the other peer in the room. The
      // server doesn't need to understand WebRTC internals to do this.
      case 'signal': {
        const room = rooms.get(ws.roomCode);
        if (!room) return;
        const other = ws.role === 'host' ? room.viewer : room.host;
        send(other, { type: 'signal', data: msg.data });
        break;
      }

      default:
        send(ws, { type: 'error', message: `Unknown message type "${msg.type}".` });
    }
  });

  ws.on('close', () => cleanupSocket(ws));
  ws.on('error', () => cleanupSocket(ws));
});

httpServer.listen(PORT, () => {
  console.log(`PingCoach signaling server listening on port ${PORT}`);
});
