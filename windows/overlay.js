// Runs inside the transparent, click-through overlay window. All it does is listen
// for "show-ping" events (relayed from the host renderer through main.js) and draw
// a brief animated marker at the corresponding position on screen.

const stage = document.getElementById('stage');
const drawSvg = document.getElementById('draw-svg');
const SVG_NS = 'http://www.w3.org/2000/svg';

// strokeId -> { points: string[], el: SVGPolylineElement, staleTimer }
const strokes = new Map();

// If the viewer's connection drops mid-stroke, 'draw-end' might never arrive.
// Auto-finish a stroke that's gone quiet for a while so it can't linger forever.
const STROKE_STALE_MS = 4000;
const STROKE_FADE_MS = 2000;

function addDrawPoint({ strokeId, x, y, color }) {
  let stroke = strokes.get(strokeId);
  if (!stroke) {
    const el = document.createElementNS(SVG_NS, 'polyline');
    el.setAttribute('fill', 'none');
    el.setAttribute('stroke', color || '#ffcc33');
    el.setAttribute('stroke-width', '5');
    el.setAttribute('stroke-linecap', 'round');
    el.setAttribute('stroke-linejoin', 'round');
    el.style.filter = `drop-shadow(0 0 6px ${color || '#ffcc33'})`;
    drawSvg.appendChild(el);
    stroke = { points: [], el, staleTimer: null };
    strokes.set(strokeId, stroke);
  }

  stroke.points.push(`${Math.round(x * window.innerWidth)},${Math.round(y * window.innerHeight)}`);
  stroke.el.setAttribute('points', stroke.points.join(' '));

  clearTimeout(stroke.staleTimer);
  stroke.staleTimer = window.setTimeout(() => finishDraw({ strokeId }), STROKE_STALE_MS);
}

function finishDraw({ strokeId }) {
  const stroke = strokes.get(strokeId);
  if (!stroke) return;
  clearTimeout(stroke.staleTimer);
  strokes.delete(strokeId);

  stroke.el.classList.add('fade-out');
  window.setTimeout(() => stroke.el.remove(), STROKE_FADE_MS);
}

function showPing({ x, y, color }) {
  // x and y are normalized 0..1 coordinates from the viewer's click on the stream.
  // Multiplying by the overlay window's own size works because main.js sizes this
  // window to exactly match the primary display's bounds.
  const px = Math.round(x * window.innerWidth);
  const py = Math.round(y * window.innerHeight);

  const el = document.createElement('div');
  el.className = 'ping';
  el.style.left = `${px}px`;
  el.style.top = `${py}px`;
  if (color) el.style.setProperty('--ping-color', color);

  const ring = document.createElement('div');
  ring.className = 'ring';
  const core = document.createElement('div');
  core.className = 'core';

  el.appendChild(ring);
  el.appendChild(core);
  stage.appendChild(el);

  // Clean up after the animation finishes so the DOM doesn't grow unbounded during
  // a long coaching session.
  window.setTimeout(() => el.remove(), 1300);
}

window.pingcoach.onShowPing(showPing);
window.pingcoach.onDrawPoint(addDrawPoint);
window.pingcoach.onDrawEnd(finishDraw);
