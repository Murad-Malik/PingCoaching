// Host side: capture this computer's screen, share it over WebRTC with whoever
// joins the room, and forward any pings that come back over the data channel to
// the overlay window so they're drawn on screen.

const serverUrlInput = document.getElementById('server-url');
const sourcesEl = document.getElementById('sources');
const startBtn = document.getElementById('start-btn');
const stopBtn = document.getElementById('stop-btn');
const setupPanel = document.getElementById('setup-panel');
const sessionPanel = document.getElementById('session-panel');
const setupStatus = document.getElementById('setup-status');
const sessionStatus = document.getElementById('session-status');
const roomCodeEl = document.getElementById('room-code');
const preview = document.getElementById('preview');
const qualitySelect = document.getElementById('quality-select');
const brbBtn = document.getElementById('brb-btn');
const switchSourceBtn = document.getElementById('switch-source-btn');
const switchSourcesEl = document.getElementById('switch-sources');

let selectedSourceId = null;
let localStream = null;
let ws = null;
let pc = null;
let pingChannel = null;
// The capture preset the streamer chose. It's the ceiling for the encoder - the
// viewer can ask to scale down from this, but never above it.
let capturePreset = null;

// BRB: swaps the outgoing video for a static placeholder track so nothing on
// the real screen - passwords, personal messages, whatever - reaches the
// viewer while it's on. Built once and reused for the life of the session.
let brbStream = null;
let brbActive = false;

function getBrbTrack() {
  if (!brbStream) brbStream = createBrbStream();
  return brbStream.getVideoTracks()[0];
}

function createBrbStream() {
  const canvas = document.createElement('canvas');
  canvas.width = 1280;
  canvas.height = 720;
  const ctx = canvas.getContext('2d');

  ctx.fillStyle = '#0d0f13';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  ctx.fillStyle = '#ffb020';
  ctx.beginPath();
  ctx.arc(canvas.width / 2, canvas.height / 2 - 92, 10, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = '#eef0f3';
  ctx.textAlign = 'center';
  ctx.font = 'bold 56px "Segoe UI", sans-serif';
  ctx.fillText('Be right back', canvas.width / 2, canvas.height / 2 - 10);

  ctx.fillStyle = '#9aa1ad';
  ctx.font = '24px "Segoe UI", sans-serif';
  ctx.fillText('The streamer stepped away for a moment', canvas.width / 2, canvas.height / 2 + 36);

  // A low but nonzero frame rate keeps the track alive (some receivers treat
  // a video track that never emits a frame as stalled) without wasting effort
  // re-encoding a static image dozens of times a second.
  return canvas.captureStream(1);
}

async function toggleBrb() {
  if (!localStream) return;
  brbActive = !brbActive;

  const track = brbActive ? getBrbTrack() : localStream.getVideoTracks()[0];
  preview.srcObject = brbActive ? brbStream : localStream;

  const sender = pc && pc.getSenders().find((s) => s.track && s.track.kind === 'video');
  if (sender) await sender.replaceTrack(track).catch(() => {});

  brbBtn.textContent = brbActive ? "I'm back" : 'BRB';
  brbBtn.classList.toggle('active', brbActive);
}

// Clamp the viewer's requested scale/bitrate/framerate against the streamer's own
// chosen ceiling, then push it to the actual RTCRtpSender encoding the video.
function applyViewQuality(view) {
  if (!pc || !capturePreset) return;
  const sender = pc.getSenders().find((s) => s.track && s.track.kind === 'video');
  if (!sender) return;

  const maxBitrate = view.maxBitrate ? Math.min(view.maxBitrate, capturePreset.maxBitrate) : capturePreset.maxBitrate;
  const maxFramerate = view.maxFramerate ? Math.min(view.maxFramerate, capturePreset.frameRate) : capturePreset.frameRate;

  const params = sender.getParameters();
  if (!params.encodings || !params.encodings.length) params.encodings = [{}];
  params.encodings[0].scaleResolutionDownBy = view.scale;
  params.encodings[0].maxBitrate = maxBitrate;
  params.encodings[0].maxFramerate = maxFramerate;
  sender.setParameters(params).catch(() => {
    // Benign if the connection isn't in a state that accepts new parameters yet;
    // the viewer's next request (or reconnect) will retry.
  });
}

// Shared between the initial "what to share" picker (setup-panel) and the
// "change source" picker (session-panel, while already live) - the two just
// wire up different click behavior (select-and-enable-start vs. switch-now).
function renderSourceCard(source, grid, onSelect, selectedId) {
  const card = document.createElement('div');
  card.className = 'source-card' + (source.id === selectedId ? ' selected' : '');

  const img = document.createElement('img');
  img.src = source.thumbnailDataUrl;
  const name = document.createElement('div');
  name.className = 'name';
  // A window's title comes from whatever application owns it, not from us -
  // set it as text rather than interpolating into innerHTML so a title that
  // happens to contain markup can't inject anything.
  name.textContent = source.name;
  card.appendChild(img);
  card.appendChild(name);

  card.addEventListener('click', () => onSelect(source, card));
  grid.appendChild(card);
}

function renderSourceGroup(container, label, group, onSelect, selectedId) {
  if (!group.length) return;
  const heading = document.createElement('p');
  heading.className = 'field-label';
  heading.textContent = label;
  container.appendChild(heading);

  const grid = document.createElement('div');
  grid.className = 'sources';
  container.appendChild(grid);

  group.forEach((source) => renderSourceCard(source, grid, onSelect, selectedId));
}

async function loadSources() {
  setupStatus.textContent = 'Looking for screens and windows to share...';
  const sources = await window.pingcoach.getScreenSources();
  sourcesEl.innerHTML = '';

  const selectSetupSource = (source, card) => {
    sourcesEl.querySelectorAll('.source-card').forEach((c) => c.classList.remove('selected'));
    card.classList.add('selected');
    selectedSourceId = source.id;
    startBtn.disabled = false;
  };

  renderSourceGroup(sourcesEl, 'Screens', sources.filter((s) => s.type === 'screen'), selectSetupSource);
  renderSourceGroup(sourcesEl, 'Applications', sources.filter((s) => s.type === 'window'), selectSetupSource);

  // Auto-select the first screen (the common single-monitor case) so hosting is
  // a one-click action, while still leaving it just as easy to instead pick a
  // specific application to share.
  const firstCard = sourcesEl.querySelector('.source-card');
  if (firstCard) firstCard.click();

  setupStatus.textContent = sources.length
    ? ''
    : 'No shareable screens or windows were found.';
}

// Live source switching: capture the newly picked source, then hand it to the
// existing peer connection with replaceTrack - no renegotiation, no dropped
// connection, the viewer's feed just cuts over.
async function captureSource(sourceId) {
  return navigator.mediaDevices.getUserMedia({
    audio: false,
    video: {
      mandatory: {
        chromeMediaSource: 'desktop',
        chromeMediaSourceId: sourceId,
        maxWidth: capturePreset.width,
        maxHeight: capturePreset.height,
        maxFrameRate: capturePreset.frameRate
      }
    }
  });
}

async function switchSource(source) {
  if (source.id === selectedSourceId) {
    switchSourcesEl.classList.add('hidden');
    return;
  }

  switchSourceBtn.disabled = true;
  let newStream;
  try {
    newStream = await captureSource(source.id);
  } catch (err) {
    sessionStatus.textContent = `Could not switch source: ${err.message}`;
    switchSourceBtn.disabled = false;
    return;
  }

  const oldStream = localStream;
  localStream = newStream;
  selectedSourceId = source.id;

  // If BRB is on, the new source is captured and ready but stays out of sight
  // - same placeholder keeps showing until BRB is turned back off, exactly
  // like it would for the source that was already selected.
  if (!brbActive) {
    preview.srcObject = localStream;
    const sender = pc && pc.getSenders().find((s) => s.track && s.track.kind === 'video');
    if (sender) await sender.replaceTrack(localStream.getVideoTracks()[0]).catch(() => {});
  }

  if (oldStream) oldStream.getTracks().forEach((t) => t.stop());

  switchSourcesEl.classList.add('hidden');
  switchSourceBtn.disabled = false;
}

async function loadSwitchSources() {
  switchSourcesEl.innerHTML = '';
  const loading = document.createElement('p');
  loading.className = 'hint';
  loading.textContent = 'Looking for screens and windows to share...';
  switchSourcesEl.appendChild(loading);

  const sources = await window.pingcoach.getScreenSources();
  switchSourcesEl.innerHTML = '';

  const intro = document.createElement('p');
  intro.className = 'hint';
  intro.textContent = "Pick what to share next - your viewer's feed switches instantly, no need to restart the session.";
  switchSourcesEl.appendChild(intro);

  renderSourceGroup(switchSourcesEl, 'Screens', sources.filter((s) => s.type === 'screen'), switchSource, selectedSourceId);
  renderSourceGroup(switchSourcesEl, 'Applications', sources.filter((s) => s.type === 'window'), switchSource, selectedSourceId);
}

async function toggleSourceSwitcher() {
  const opening = switchSourcesEl.classList.contains('hidden');
  switchSourcesEl.classList.toggle('hidden');
  if (opening) await loadSwitchSources();
}

function connectSignaling(serverUrl) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(serverUrl);
    socket.addEventListener('open', () => {
      socket.send(JSON.stringify({ type: 'host' }));
    });
    socket.addEventListener('error', () => {
      reject(new Error(`Could not reach the signaling server at ${serverUrl}`));
    });
    socket.addEventListener('message', function onFirstMessage(event) {
      const msg = JSON.parse(event.data);
      if (msg.type === 'host-ok') {
        socket.removeEventListener('message', onFirstMessage);
        resolve({ socket, room: msg.room });
      } else if (msg.type === 'error') {
        reject(new Error(msg.message));
      }
    });
  });
}

async function createPeerConnection() {
  pc = new RTCPeerConnection(window.RTC_CONFIG);

  // If BRB was already on when a viewer (re)connects, start the connection
  // with the placeholder rather than briefly exposing the real screen first.
  localStream.getTracks().forEach((track) => {
    if (track.kind === 'video' && brbActive) {
      pc.addTrack(getBrbTrack(), brbStream);
    } else {
      pc.addTrack(track, localStream);
    }
  });

  pingChannel = pc.createDataChannel('pings');
  pingChannel.addEventListener('open', () => {
    sessionStatus.textContent = 'Connected. Your viewer can ping your screen now.';
  });
  pingChannel.addEventListener('close', () => {
    sessionStatus.textContent = 'Viewer disconnected. Waiting for reconnect...';
  });
  pingChannel.addEventListener('message', (event) => {
    let payload;
    try {
      payload = JSON.parse(event.data);
    } catch (err) {
      return;
    }
    if (payload.type === 'ping') {
      // Nothing about the real screen should react while it's hidden - a ping
      // would still land somewhere on it, just not anywhere the viewer (looking
      // at the placeholder) could have intended.
      if (brbActive) return;
      window.pingcoach.sendPing({
        x: clamp01(payload.x),
        y: clamp01(payload.y),
        color: payload.color
      });
    } else if (payload.type === 'quality-request') {
      const view = window.VIEW_QUALITIES.find((v) => v.id === payload.id) || window.VIEW_QUALITIES[0];
      applyViewQuality(view);
      pingChannel.send(JSON.stringify({ type: 'quality-applied', id: view.id }));
    } else if (payload.type === 'draw-point') {
      if (brbActive) return;
      window.pingcoach.sendDrawPoint({
        strokeId: String(payload.strokeId),
        x: clamp01(payload.x),
        y: clamp01(payload.y),
        color: payload.color
      });
    } else if (payload.type === 'draw-end') {
      if (brbActive) return;
      window.pingcoach.sendDrawEnd({ strokeId: String(payload.strokeId) });
    }
  });

  pc.addEventListener('icecandidate', (event) => {
    if (event.candidate) {
      sendSignal({ candidate: event.candidate });
    }
  });

  pc.addEventListener('connectionstatechange', () => {
    if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
      sessionStatus.textContent = 'Connection lost. Have your viewer rejoin the room.';
    }
  });
}

function clamp01(n) {
  return Math.min(1, Math.max(0, Number(n) || 0));
}

function sendSignal(data) {
  ws.send(JSON.stringify({ type: 'signal', data }));
}

async function handleSignal(data) {
  if (data.sdp) {
    await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
    if (data.sdp.type === 'answer') return;
  }
  if (data.candidate) {
    try {
      await pc.addIceCandidate(new RTCIceCandidate(data.candidate));
    } catch (err) {
      // Benign if it arrives before the remote description is set in rare
      // orderings; ICE will retry via other candidates.
    }
  }
}

async function startHosting() {
  startBtn.disabled = true;
  setupStatus.textContent = 'Starting screen capture...';

  capturePreset = window.CAPTURE_PRESETS.find((p) => p.id === qualitySelect.value)
    || window.CAPTURE_PRESETS.find((p) => p.id === '1080p30');

  try {
    localStream = await captureSource(selectedSourceId);
  } catch (err) {
    setupStatus.textContent = `Could not capture the screen: ${err.message}`;
    startBtn.disabled = false;
    return;
  }

  preview.srcObject = localStream;

  setupStatus.textContent = 'Connecting to signaling server...';
  let connection;
  try {
    connection = await connectSignaling(serverUrlInput.value.trim());
  } catch (err) {
    setupStatus.textContent = err.message;
    startBtn.disabled = false;
    localStream.getTracks().forEach((t) => t.stop());
    return;
  }

  ws = connection.socket;
  roomCodeEl.textContent = connection.room;

  ws.addEventListener('message', async (event) => {
    const msg = JSON.parse(event.data);
    if (msg.type === 'peer-joined') {
      sessionStatus.textContent = 'Viewer joining, connecting stream...';
      await createPeerConnection();
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      sendSignal({ sdp: offer });
    } else if (msg.type === 'signal') {
      if (pc) await handleSignal(msg.data);
    } else if (msg.type === 'peer-left') {
      sessionStatus.textContent = 'Viewer disconnected. Waiting for someone to join...';
      if (pingChannel) pingChannel.close();
      if (pc) pc.close();
      pc = null;
      pingChannel = null;
    } else if (msg.type === 'error') {
      sessionStatus.textContent = `Signaling error: ${msg.message}`;
    }
  });

  window.pingcoach.startOverlay();
  setupPanel.classList.add('hidden');
  sessionPanel.classList.remove('hidden');
}

function stopHosting() {
  window.pingcoach.stopOverlay();
  if (pingChannel) pingChannel.close();
  if (pc) pc.close();
  if (ws) ws.close();
  if (localStream) localStream.getTracks().forEach((t) => t.stop());
  if (brbStream) brbStream.getTracks().forEach((t) => t.stop());

  pingChannel = null;
  pc = null;
  ws = null;
  localStream = null;
  capturePreset = null;
  brbStream = null;
  brbActive = false;
  brbBtn.textContent = 'BRB';
  brbBtn.classList.remove('active');
  switchSourcesEl.classList.add('hidden');
  switchSourcesEl.innerHTML = '';

  sessionPanel.classList.add('hidden');
  setupPanel.classList.remove('hidden');
  startBtn.disabled = !selectedSourceId;
  setupStatus.textContent = '';
  loadSources();
}

startBtn.addEventListener('click', startHosting);
stopBtn.addEventListener('click', stopHosting);
brbBtn.addEventListener('click', toggleBrb);
switchSourceBtn.addEventListener('click', toggleSourceSwitcher);

loadSources();
