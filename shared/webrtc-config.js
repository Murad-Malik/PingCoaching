// Shared WebRTC configuration used by both the host and viewer renderer processes.
//
// STUN servers just help two computers discover how to reach each other directly
// (they don't relay any video/data). Google's public STUN servers are free and fine
// for an MVP. If pings/video fail to connect on some networks (e.g. strict corporate
// firewalls, some mobile hotspots), that's usually because a direct connection isn't
// possible and you need a TURN server (a relay) as a fallback. You can add one here,
// for example a free tier from a provider like Metered or Twilio, or self-host coturn:
//
// { urls: 'turn:your-turn-server:3478', username: '...', credential: '...' }

const RTC_CONFIG = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' }
  ]
};

// Presets the streamer picks from before going live. These set the actual screen
// capture resolution/frame rate and act as the ceiling for encoding bitrate - the
// viewer's quality choice (below) can only ever match or scale this down, never
// exceed it.
const CAPTURE_PRESETS = [
  { id: '720p30', label: '720p 30fps', width: 1280, height: 720, frameRate: 30, maxBitrate: 1500000 },
  { id: '720p60', label: '720p 60fps', width: 1280, height: 720, frameRate: 60, maxBitrate: 2500000 },
  { id: '1080p30', label: '1080p 30fps', width: 1920, height: 1080, frameRate: 30, maxBitrate: 4000000 },
  { id: '1080p60', label: '1080p 60fps', width: 1920, height: 1080, frameRate: 60, maxBitrate: 8000000 },
  { id: '1080p144', label: '1080p 144fps', width: 1920, height: 1080, frameRate: 144, maxBitrate: 10000000 },
  { id: '1440p60', label: '1440p 60fps', width: 2560, height: 1440, frameRate: 60, maxBitrate: 9000000 },
  { id: '1440p144', label: '1440p 144fps', width: 2560, height: 1440, frameRate: 144, maxBitrate: 15000000 }
];

// Presets the viewer picks from once connected. There's only one media stream
// (no simulcast/SFU), so "quality" here means asking the streamer's own sender
// to scale down and/or cap the bitrate of what it's already capturing -
// scaleResolutionDownBy divides both dimensions, so 1.5 and 3 give a visible
// but not extreme step down each level.
const VIEW_QUALITIES = [
  { id: 'auto', label: 'Auto (match streamer)', scale: 1, maxBitrate: null, maxFramerate: null },
  { id: 'high', label: 'High', scale: 1, maxBitrate: 6000000, maxFramerate: null },
  { id: 'medium', label: 'Medium', scale: 1.5, maxBitrate: 2500000, maxFramerate: 30 },
  { id: 'low', label: 'Low (data saver)', scale: 3, maxBitrate: 800000, maxFramerate: 20 }
];

// Works in both a CommonJS context (preload/main) and a plain <script> include
// (renderer windows load this file directly via a <script src="../shared/webrtc-config.js">).
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { RTC_CONFIG, CAPTURE_PRESETS, VIEW_QUALITIES };
}
if (typeof window !== 'undefined') {
  window.RTC_CONFIG = RTC_CONFIG;
  window.CAPTURE_PRESETS = CAPTURE_PRESETS;
  window.VIEW_QUALITIES = VIEW_QUALITIES;
}
