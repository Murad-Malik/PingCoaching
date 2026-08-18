// Viewer/coach side: join a room, receive the host's screen as a video stream,
// and translate clicks on that video into normalized ping coordinates sent back
// over the WebRTC data channel.

const serverUrlInput = document.getElementById('server-url');
const roomInput = document.getElementById('room-input');
const joinBtn = document.getElementById('join-btn');
const leaveBtn = document.getElementById('leave-btn');
const joinPanel = document.getElementById('join-panel');
const watchPanel = document.getElementById('watch-panel');
const joinStatus = document.getElementById('join-status');
const watchStatus = document.getElementById('watch-status');
const video = document.getElementById('remote-video');
const watchStage = document.getElementById('watch-stage');
const localEffectsLayer = document.getElementById('local-effects-layer');
const localDrawSvg = document.getElementById('local-draw-svg');
const notesBtn = document.getElementById('notes-btn');
const notesBox = document.getElementById('notes-box');
const fullscreenBtn = document.getElementById('fullscreen-btn');
const qualitySelect = document.getElementById('quality-select');
const qualityStatus = document.getElementById('quality-status');
const colorSwatches = document.querySelectorAll('.color-swatch');

let pingColor = document.querySelector('.color-swatch.selected').dataset.color;

colorSwatches.forEach((swatch) => {
  swatch.addEventListener('click', () => {
    colorSwatches.forEach((s) => s.classList.remove('selected'));
    swatch.classList.add('selected');
    pingColor = swatch.dataset.color;
  });
});

let ws = null;
let pc = null;
let pingChannel = null;
let pendingCandidates = [];

function sendSignal(data) {
  ws.send(JSON.stringify({ type: 'signal', data }));
}

function sendQualityRequest(id) {
  if (pingChannel && pingChannel.readyState === 'open') {
    pingChannel.send(JSON.stringify({ type: 'quality-request', id }));
  }
}

async function flushPendingCandidates() {
  const queued = pendingCandidates;
  pendingCandidates = [];
  for (const candidate of queued) {
    try {
      await pc.addIceCandidate(new RTCIceCandidate(candidate));
    } catch (err) {
      // Ignore - a stale/duplicate candidate isn't fatal.
    }
  }
}

function createPeerConnection() {
  pc = new RTCPeerConnection(window.RTC_CONFIG);

  pc.addEventListener('track', (event) => {
    video.srcObject = event.streams[0];
    watchStatus.textContent = 'Live. Click the video to ping.';

    // Chromium's WebRTC playout speeds video up (sometimes noticeably, for
    // fast-moving content) whenever its receive buffer grows, to keep
    // end-to-end latency minimal. That's a fine trade for a video call, but
    // for watching gameplay it can make the stream visibly run ahead of
    // real time. Asking for a small fixed playout delay trades a little
    // extra baseline latency for steady, real-time-paced playback instead.
    try {
      if (event.receiver && 'playoutDelayHint' in event.receiver) {
        event.receiver.playoutDelayHint = 0.2;
      }
    } catch (err) {
      // Not supported everywhere; the stream still plays fine without it.
    }
  });

  pc.addEventListener('datachannel', (event) => {
    pingChannel = event.channel;
    pingChannel.addEventListener('open', () => {
      watchStatus.textContent = 'Connected. Click the video to ping.';
      sendQualityRequest(qualitySelect.value);
    });
    pingChannel.addEventListener('close', () => {
      watchStatus.textContent = 'Disconnected from host.';
      qualityStatus.textContent = '';
    });
    pingChannel.addEventListener('message', (event) => {
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch (err) {
        return;
      }
      if (msg.type === 'quality-applied') {
        const view = window.VIEW_QUALITIES.find((v) => v.id === msg.id);
        qualityStatus.textContent = view ? `Viewing at: ${view.label}` : '';
      }
    });
  });

  pc.addEventListener('icecandidate', (event) => {
    if (event.candidate) sendSignal({ candidate: event.candidate });
  });

  pc.addEventListener('connectionstatechange', () => {
    if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
      watchStatus.textContent = 'Connection lost.';
    }
  });
}

async function handleSignal(data) {
  if (data.sdp && data.sdp.type === 'offer') {
    await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
    await flushPendingCandidates();
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    sendSignal({ sdp: answer });
  } else if (data.candidate) {
    if (pc.remoteDescription) {
      try {
        await pc.addIceCandidate(new RTCIceCandidate(data.candidate));
      } catch (err) {
        // Non-fatal.
      }
    } else {
      pendingCandidates.push(data.candidate);
    }
  }
}

function joinSession() {
  const serverUrl = serverUrlInput.value.trim();
  const room = roomInput.value.trim().toUpperCase();

  if (!room) {
    joinStatus.textContent = 'Enter the room code your streamer gave you.';
    return;
  }

  joinBtn.disabled = true;
  joinStatus.textContent = 'Connecting...';

  ws = new WebSocket(serverUrl);

  ws.addEventListener('error', () => {
    joinStatus.textContent = `Could not reach the signaling server at ${serverUrl}`;
    joinBtn.disabled = false;
  });

  ws.addEventListener('open', () => {
    ws.send(JSON.stringify({ type: 'join', room }));
  });

  ws.addEventListener('message', async (event) => {
    const msg = JSON.parse(event.data);

    if (msg.type === 'join-ok') {
      createPeerConnection();
      joinPanel.classList.add('hidden');
      watchPanel.classList.remove('hidden');
      document.body.classList.add('is-watching');
      window.pingcoach.maximize();
    } else if (msg.type === 'signal') {
      await handleSignal(msg.data);
    } else if (msg.type === 'peer-left') {
      endSession('The streamer ended the session.');
    } else if (msg.type === 'error') {
      joinStatus.textContent = msg.message;
      joinBtn.disabled = false;
    }
  });
}

// Tears down the connection and drops back to the join screen. Used both for the
// viewer choosing to leave and for the streamer ending the session out from under
// them (the signaling server tells us via 'peer-left') - in the latter case the
// video would otherwise just sit there frozen on the last frame forever.
function endSession(message) {
  document.body.classList.remove('is-watching');
  window.pingcoach.setFullScreen(false);
  window.pingcoach.unmaximize();
  if (pingChannel) pingChannel.close();
  if (pc) pc.close();
  if (ws) ws.close();
  pingChannel = null;
  pc = null;
  ws = null;
  video.srcObject = null;

  watchPanel.classList.add('hidden');
  joinPanel.classList.remove('hidden');
  joinBtn.disabled = false;
  joinStatus.textContent = message || '';
  qualityStatus.textContent = '';
}

function leaveSession() {
  endSession('');
}

// Translate a client (page) coordinate into a normalized (0..1, 0..1) coordinate
// on the *actual video image*, accounting for the letterboxing that object-fit:
// contain introduces when the stream's aspect ratio doesn't exactly match the
// element's aspect ratio. Returns null for points outside the rendered image
// (the letterbox bars) or before the stream has any dimensions yet.
function toNormalizedPoint(clientX, clientY) {
  if (!video.videoWidth || !video.videoHeight) return null;

  const rect = video.getBoundingClientRect();
  const scale = Math.min(rect.width / video.videoWidth, rect.height / video.videoHeight);
  const renderedWidth = video.videoWidth * scale;
  const renderedHeight = video.videoHeight * scale;
  const offsetX = (rect.width - renderedWidth) / 2;
  const offsetY = (rect.height - renderedHeight) / 2;

  const localX = clientX - rect.left - offsetX;
  const localY = clientY - rect.top - offsetY;

  if (localX < 0 || localY < 0 || localX > renderedWidth || localY > renderedHeight) return null;

  return { x: localX / renderedWidth, y: localY / renderedHeight };
}

function sendDrawPoint(strokeId, clientX, clientY) {
  if (!pingChannel || pingChannel.readyState !== 'open') return;
  const point = toNormalizedPoint(clientX, clientY);
  if (!point) return;
  pingChannel.send(JSON.stringify({ type: 'draw-point', strokeId, x: point.x, y: point.y, color: pingColor }));
}

// Drawn directly on the coach's own screen the instant they click/drag - not
// waiting on the round trip through the video (which has real, visible
// latency) or on the ping showing up in the captured feed at all (it won't,
// if the streamer is sharing just one application window rather than their
// whole screen, since the overlay that draws pings is a separate window).
function showLocalPing(clientX, clientY, color) {
  const stageRect = watchStage.getBoundingClientRect();
  const px = clientX - stageRect.left;
  const py = clientY - stageRect.top;

  const el = document.createElement('div');
  el.className = 'local-ping';
  el.style.left = `${px}px`;
  el.style.top = `${py}px`;
  el.style.setProperty('--ping-color', color);

  const ring = document.createElement('div');
  ring.className = 'ring';
  const core = document.createElement('div');
  core.className = 'core';
  el.appendChild(ring);
  el.appendChild(core);
  localEffectsLayer.appendChild(el);

  window.setTimeout(() => el.remove(), 1300);
}

const SVG_NS = 'http://www.w3.org/2000/svg';
let localStrokeEl = null;
let localStrokePoints = [];

function toStagePoint(clientX, clientY) {
  const stageRect = watchStage.getBoundingClientRect();
  return `${clientX - stageRect.left},${clientY - stageRect.top}`;
}

function startLocalStroke(clientX, clientY, color) {
  localStrokePoints = [toStagePoint(clientX, clientY)];
  localStrokeEl = document.createElementNS(SVG_NS, 'polyline');
  localStrokeEl.setAttribute('fill', 'none');
  localStrokeEl.setAttribute('stroke', color);
  localStrokeEl.setAttribute('stroke-width', '5');
  localStrokeEl.setAttribute('stroke-linecap', 'round');
  localStrokeEl.setAttribute('stroke-linejoin', 'round');
  localStrokeEl.setAttribute('points', localStrokePoints.join(' '));
  localStrokeEl.style.filter = `drop-shadow(0 0 6px ${color})`;
  localDrawSvg.appendChild(localStrokeEl);
}

function addLocalStrokePoint(clientX, clientY) {
  if (!localStrokeEl) return;
  localStrokePoints.push(toStagePoint(clientX, clientY));
  localStrokeEl.setAttribute('points', localStrokePoints.join(' '));
}

function finishLocalStroke() {
  if (!localStrokeEl) return;
  const el = localStrokeEl;
  localStrokeEl = null;
  localStrokePoints = [];
  el.classList.add('fade-out');
  window.setTimeout(() => el.remove(), 2000);
}

// A short click pings; holding the button down for DRAG_HOLD_MS arms free-draw
// mode, and moving the mouse from then on (still held) draws a line that fades
// out after release. The delay is what keeps an ordinary click - even a slightly
// jittery, rapid one - from ever being misread as a drag: dragging simply can't
// start until you've held for a beat.
const DRAG_HOLD_MS = 250;
let isPointerDown = false;
let isDragging = false;
let suppressNextClick = false;
let dragAnchor = null;
let currentStrokeId = null;
let dragArmTimer = null;
// Movement is real (and can be fast) well before we know whether this gesture
// is a drag - throwing it away until the hold threshold fires would make the
// line jump straight from the start point to wherever the mouse ended up.
// Buffer it during the wait and replay it once armed, so the line follows the
// actual path instead of teleporting.
let pendingPoints = [];
// Sending a network message per raw mousemove event (which can fire well past
// 60Hz) does more harm than good - throttle actual sends to one per animation
// frame instead, which is both smoother and lighter on the data channel.
let latestMovePoint = null;
let drawRafId = null;

function flushDrawFrame() {
  drawRafId = null;
  if (isDragging && latestMovePoint) {
    sendDrawPoint(currentStrokeId, latestMovePoint.x, latestMovePoint.y);
  }
}

video.addEventListener('mousedown', (event) => {
  if (event.button !== 0) return; // left button only
  // Without a controls attribute, a plain <video> still toggles play/pause as
  // its built-in default action on click, and is natively draggable - both of
  // which would fight with pinging/drawing here.
  event.preventDefault();
  isPointerDown = true;
  isDragging = false;
  dragAnchor = { x: event.clientX, y: event.clientY };
  pendingPoints = [dragAnchor];

  dragArmTimer = window.setTimeout(() => {
    if (!isPointerDown) return; // already released before the hold threshold
    isDragging = true;
    currentStrokeId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

    startLocalStroke(pendingPoints[0].x, pendingPoints[0].y, pingColor);
    pendingPoints.forEach((point, index) => {
      sendDrawPoint(currentStrokeId, point.x, point.y);
      if (index > 0) addLocalStrokePoint(point.x, point.y);
    });
    pendingPoints = [];
  }, DRAG_HOLD_MS);
});

document.addEventListener('mousemove', (event) => {
  if (!isPointerDown) return;

  if (!isDragging) {
    pendingPoints.push({ x: event.clientX, y: event.clientY });
    return;
  }

  // The local line updates on every raw event - it's just a DOM update, no
  // network round trip, so there's no reason to throttle it like the actual
  // network sends below.
  addLocalStrokePoint(event.clientX, event.clientY);

  latestMovePoint = { x: event.clientX, y: event.clientY };
  if (drawRafId === null) drawRafId = requestAnimationFrame(flushDrawFrame);
});

document.addEventListener('mouseup', () => {
  if (!isPointerDown) return;
  isPointerDown = false;
  clearTimeout(dragArmTimer);

  if (isDragging) {
    if (drawRafId !== null) {
      cancelAnimationFrame(drawRafId);
      drawRafId = null;
    }
    if (latestMovePoint) sendDrawPoint(currentStrokeId, latestMovePoint.x, latestMovePoint.y);
    finishLocalStroke();

    suppressNextClick = true;
    if (pingChannel && pingChannel.readyState === 'open') {
      pingChannel.send(JSON.stringify({ type: 'draw-end', strokeId: currentStrokeId }));
    }
  }

  isDragging = false;
  currentStrokeId = null;
  latestMovePoint = null;
  pendingPoints = [];
});

video.addEventListener('click', (event) => {
  event.preventDefault();

  if (suppressNextClick) {
    suppressNextClick = false;
    return;
  }

  if (!pingChannel || pingChannel.readyState !== 'open') return;

  const point = toNormalizedPoint(event.clientX, event.clientY);
  if (!point) return;

  pingChannel.send(JSON.stringify({ type: 'ping', x: point.x, y: point.y, color: pingColor }));
  showLocalPing(event.clientX, event.clientY, pingColor);
});

video.style.cursor = 'crosshair';

// The coach only watches - pausing would freeze the frame while the host keeps
// streaming, hiding what's actually happening. Immediately undo any pause,
// however it was triggered (spacebar, media keys, etc).
video.addEventListener('pause', () => {
  if (video.srcObject) video.play();
});

// Window-level fullscreen (not the browser's element Fullscreen API) - see the
// comment in main.js for why: it keeps our own controls (ping colors, leave/exit
// buttons) rendering as a floating overlay instead of getting hidden along with
// the rest of the page, and it avoids Chromium's built-in fullscreen video
// controls bar (the "timer") that comes with the element API.
let isFullscreen = false;

function toggleFullscreen() {
  window.pingcoach.setFullScreen(!isFullscreen);
}

window.pingcoach.onFullscreenChange((flag) => {
  isFullscreen = flag;
  document.body.classList.toggle('is-fullscreen', flag);
  fullscreenBtn.textContent = flag ? 'Exit full screen' : 'Full screen';
});

// Window-level fullscreen has none of the browser's built-in "Escape exits
// fullscreen" behavior (that's specific to the element Fullscreen API we
// deliberately moved away from), so it has to be wired up by hand here.
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && isFullscreen) {
    window.pingcoach.setFullScreen(false);
  }
});

// Notes: a small textarea the coach can jot down while watching, without it
// covering the stream. Toggling it shrinks the video to 80% width and opens a
// 20% panel on the right - works the same way in and out of full screen, since
// both just react to the same 'notes-open' class on the shared stage element.
const NOTES_STORAGE_KEY = 'pingcoach-viewer-notes';
notesBox.value = localStorage.getItem(NOTES_STORAGE_KEY) || '';

let notesSaveTimer = null;
notesBox.addEventListener('input', () => {
  clearTimeout(notesSaveTimer);
  notesSaveTimer = window.setTimeout(() => {
    localStorage.setItem(NOTES_STORAGE_KEY, notesBox.value);
  }, 300);
});

function toggleNotes() {
  const open = watchStage.classList.toggle('notes-open');
  notesBtn.textContent = open ? 'Hide notes' : 'Notes';
  if (open) notesBox.focus();
}

joinBtn.addEventListener('click', joinSession);
leaveBtn.addEventListener('click', leaveSession);
fullscreenBtn.addEventListener('click', toggleFullscreen);
notesBtn.addEventListener('click', toggleNotes);
qualitySelect.addEventListener('change', () => sendQualityRequest(qualitySelect.value));
