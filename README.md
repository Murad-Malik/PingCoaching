# PointCue

A standalone desktop app for pinging a marker onto someone else's screen in real
time while you coach them, whether that's a League of Legends match, another
game, or a work screenshare. It doesn't route through Discord, Zoom, or Overwolf
- it's its own screen-share and overlay pipeline, built on WebRTC and Electron.

## How it works

There are two roles:

- **Host** - the person being coached. Their app captures their own screen and
  streams it out, and it also runs a transparent, click-through overlay window
  that sits on top of everything else on their screen, including a fullscreen
  game, and draws the ping markers.
- **Viewer (coach)** - joins a room with a short code, watches the host's
  screen, and clicks anywhere on the video to send a ping. That click is sent
  as a normalized coordinate (a percentage of the image, not a pixel), so it
  lands in the right spot on the host's screen no matter what resolution
  either computer is running.

A small "signaling server" is what lets the two apps find each other. It only
relays the initial WebRTC handshake (think of it as making the introduction);
once that's done, the video stream and every ping travel directly between the
two computers, peer to peer. The server never sees your screen or your pings.

```
Host app  <--- WebSocket (signaling only) --->  Signaling server  <--- WebSocket ---> Viewer app
Host app  <==========  WebRTC: video + pings, peer-to-peer, once connected  ========>  Viewer app
```

## Project layout

```
pointcue/
  main.js                 Electron main process: creates windows, manages the
                           overlay, exposes desktopCapturer to renderers
  preload.js               The safe, explicit API exposed to every window
  windows/
    launcher.html           Pick "I'm the Streamer" or "I'm the Viewer"
    host.html / host.js      Screen capture + WebRTC host logic
    viewer.html / viewer.js  Join a room, watch the stream, send pings
    overlay.html / overlay.js  The transparent click-through ping renderer
    common.css               Shared styling
  shared/
    webrtc-config.js        ICE server config (shared by host + viewer)
  signaling-server/
    server.js               Standalone Node WebSocket relay (~150 lines)
    package.json
```

## Running it locally (both roles on one computer, for testing)

1. Install dependencies and start the signaling server:
   ```
   cd signaling-server
   npm install
   npm start
   ```
   It listens on port 8787 by default and prints a confirmation.

2. In a second terminal, install and start the app:
   ```
   cd pointcue
   npm install
   npm start
   ```
   This opens the launcher window. Click "I'm the Streamer," pick a screen,
   and click "Start streaming." A 6-character room code appears.

3. Run `npm start` again (a second instance) to open a second launcher window,
   click "I'm the Viewer," leave the server address as `ws://localhost:8787`,
   type in the room code, and click "Join session." Click anywhere on the
   video to send a ping - you should see it appear on the host window's real
   screen almost instantly.

## Running it for real, across two different computers

The one thing that needs to change is the signaling server address, since
`ws://localhost:8787` only means "this same computer." You have a few options,
roughly in order of effort:

1. **Same Wi-Fi/LAN**: run the signaling server on one machine and have the
   other connect to its local network IP, e.g. `ws://192.168.1.23:8787`.
2. **A quick tunnel for testing**: run a tool like `ngrok http 8787` and use
   the `wss://...ngrok-free.app` URL it gives you (use `wss://`, not `ws://`,
   since ngrok terminates TLS).
3. **A small always-on server**: deploy `signaling-server/` to a cheap VPS
   (a $5/month box is plenty - it's a tiny relay, not a media server) or a
   platform like Render or Fly.io, and point both apps at
   `wss://your-domain:8787`.

## Packaging it as a real app

`npm start` is fine for development, but someone else won't want to clone the
repo and run a terminal command. `electron-builder` packages this into a
normal Windows installer:

```
npm install
npm run dist
```

That produces `dist/PointCue Setup <version>.exe` - a standard installer
someone can just double-click, with a Start Menu shortcut and an uninstaller,
no Node or terminal required on their end. (`npm run pack` builds the
unpacked app to `dist/win-unpacked/` instead, without the installer wrapper -
faster, useful for a quick local test.)

The signaling server is *not* bundled into that installer on purpose - it's
still a separate small Node process meant to run on a server (see "Running it
for real" above), not something that ships inside each user's app.

The `build` section of `package.json` controls the packaging (app id, product
name, which files get bundled, installer options). It currently has no
`icon` set, so Windows shows the default Electron icon - drop a `.ico` file
in `assets/` and point `build.win.icon` at it to brand it properly.

## Known limitations and things to firm up next

- **STUN only, no TURN.** The app currently only uses public STUN servers for
  NAT traversal, which works for most home networks but can fail on strict
  corporate firewalls or some mobile hotspots. `shared/webrtc-config.js` has
  a comment showing where to add a TURN server if you hit that.
- **Overlay on true exclusive fullscreen.** The click-through overlay works
  over "borderless windowed" or "windowed fullscreen," which is how most
  games including League run by default (and how the Discord and Steam
  overlays work too). A game running in genuine *exclusive* fullscreen mode
  can still cover the overlay - if that comes up, the fix is telling players
  to switch to windowed/borderless mode, which most games support and many
  default to already.
- **One viewer per room.** The signaling server currently supports exactly
  one host and one viewer per room, which matches the 1-on-1 coaching use
  case. Supporting a second observer would mean the host creating a second
  peer connection per additional viewer - the architecture supports it, it's
  just not wired up yet.
- **No authentication.** Anyone with the room code can join. That's fine for
  "read it out loud to my coach," but worth a password or single-use token
  if this ever needs to be more locked down.
- **No code signing / icon.** The Windows installer builds and runs fine, but
  it's unsigned (Windows SmartScreen will warn on first run) and uses the
  default Electron icon. Fine for sharing with people who trust you already;
  worth a code-signing cert and a real icon before wider distribution.

## Customizing the ping

The marker's look (color, size, animation timing) lives entirely in
`windows/overlay.html`'s `<style>` block and `windows/overlay.js`. The data
sent per ping is just `{ type: 'ping', x, y }` (0..1 normalized), with an
optional `color` field already wired through end to end if you want to let
the coach pick a ping color later.
