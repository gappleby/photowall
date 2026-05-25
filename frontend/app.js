import { WallCanvas } from './canvas-wall.js';

// ---------------------------------------------------------------------------
// State machine constants
// ---------------------------------------------------------------------------
const State = Object.freeze({
  LOADING:          'LOADING',
  BROWSING:         'BROWSING',
  PANNING:          'PANNING',
  ZOOMING_IN:       'ZOOMING_IN',
  COLOR_IN:         'COLOR_IN',
  SHOWING_RELATED:  'SHOWING_RELATED',
  COLOR_OUT:        'COLOR_OUT',
  ZOOMING_OUT:      'ZOOMING_OUT',
});

// ---------------------------------------------------------------------------
// Easing
// ---------------------------------------------------------------------------
function easeInOutCubic(t) {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

// ---------------------------------------------------------------------------
// DOM refs
// ---------------------------------------------------------------------------
const overlay        = document.getElementById('overlay');
const overlayStatus  = document.getElementById('overlay-status');
const progressBar    = document.getElementById('progress-bar');
const scanBtn        = document.getElementById('scan-btn');
const canvasEl       = document.getElementById('wall-canvas');
const photoFrame     = document.getElementById('photo-frame');
const photoImgA      = document.getElementById('photo-img-a');  // base layer
const photoImgB      = document.getElementById('photo-img-b');  // cross-fade layer (on top)
const captionEl      = document.getElementById('photo-caption');
const captionFolder  = document.getElementById('caption-folder');
const captionDate    = document.getElementById('caption-date');

// ---------------------------------------------------------------------------
// App state
// ---------------------------------------------------------------------------
let state = State.LOADING;

/** @type {WallCanvas|null} */
let wall = null;

// Viewport / world
// visualViewport is the authoritative visible size on iOS Safari;
// window.innerWidth/Height can equal the large viewport (behind browser chrome).
function _vpSize() {
  const vp = window.visualViewport;
  return {
    w: Math.round(vp ? vp.width  : window.innerWidth),
    h: Math.round(vp ? vp.height : window.innerHeight),
  };
}
let { w: viewW, h: viewH } = _vpSize();

// Board dimensions (filled from metadata)
let boardW = 0;
let boardH = 0;
let boardThumbW    = 0;  // photo-only width inside polaroid
let boardThumbH    = 0;  // photo-only height inside polaroid
let boardFrameSide = 0;  // white border on top/left/right
let boardFrameBottom = 0; // white border on bottom (polaroid label area)

// Caption config
let showCaption = true;

// Current world position and scale
let worldX = 0;
let worldY = 0;
let scale  = 1;

// BROWSING drift
let driftVX = 0;
let driftVY = 0;
let browseStart = 0;         // performance.now() when BROWSING started
let browseDuration = 0;      // random 4000–8000 ms
/** @type {object|null} */
let targetThumb = null;      // thumbnail chosen for next pan

// PANNING
let panStartX = 0;
let panStartY = 0;
let panEndX   = 0;
let panEndY   = 0;
let panStartTime = 0;
const PAN_DURATION = 2000;   // ms

// ZOOMING_IN / ZOOMING_OUT
let zoomStartScale = 1;
let zoomEndScale   = 1;
let zoomStartX = 0;
let zoomStartY = 0;
let zoomEndX   = 0;
let zoomEndY   = 0;
let zoomStartTime  = 0;
const ZOOM_DURATION = 1200;  // ms

// Pre-zoom state (restored in ZOOMING_OUT)
let preZoomX = 0;
let preZoomY = 0;
let preZoomScale = 1;

// COLOR_IN / COLOR_OUT — durations are overwritten from /api/config at startup
let fadeStartTime = 0;
let fadeDuration = 2000;   // ms — cross-fade between B&W and colour, and between colour photos
let dwellMs      = 4000;   // ms — how long each colour photo is held before moving on

// SHOWING_RELATED
let relatedQueue = [];
let relatedIndex = 0;

// rAF handle
let rafId = null;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function clampWorld(wx, wy, s) {
  const maxX = Math.max(0, boardW - viewW / s);
  const maxY = Math.max(0, boardH - viewH / s);
  return [
    Math.max(0, Math.min(wx, maxX)),
    Math.max(0, Math.min(wy, maxY)),
  ];
}

function thumbCenterWorld(thumb) {
  return { cx: thumb.x + thumb.w / 2, cy: thumb.y + thumb.h / 2 };
}

function worldXYToCenter(thumb, s) {
  return [
    thumb.x + thumb.w / 2 - viewW / (2 * s),
    thumb.y + thumb.h / 2 - viewH / (2 * s),
  ];
}

function randomBetween(a, b) {
  return a + Math.random() * (b - a);
}

function pickDriftVelocity() {
  const speed = randomBetween(1, 3);
  const angle = Math.random() * 2 * Math.PI;
  return [speed * Math.cos(angle), speed * Math.sin(angle)];
}

function pickRandomThumb(thumbnails) {
  return thumbnails[Math.floor(Math.random() * thumbnails.length)];
}

/** Contain-fit the polaroid to 80% of the viewport, never clipping either edge */
function zoomScaleForThumb(thumb) {
  return Math.min((viewW * 0.8) / thumb.w, (viewH * 0.8) / thumb.h);
}

/** Position #photo-frame over the full polaroid (white border + photo area + label). */
function positionPhotoFrame(thumb) {
  // thumb.x/y is the polaroid top-left; thumb.w/h is the full polaroid size
  const screenX = (thumb.x - worldX) * scale;
  const screenY = (thumb.y - worldY) * scale;
  const screenW = thumb.w * scale;
  const screenH = thumb.h * scale;

  photoFrame.style.left   = `${screenX}px`;
  photoFrame.style.top    = `${screenY}px`;
  photoFrame.style.width  = `${screenW}px`;
  photoFrame.style.height = `${screenH}px`;

  // CSS custom properties let the child imgs and caption size themselves correctly
  const fs = `${boardFrameSide   * scale}px`;
  const fb = `${boardFrameBottom * scale}px`;
  photoFrame.style.setProperty('--frame-side',   fs);
  photoFrame.style.setProperty('--frame-bottom', fb);
}

/** Populate the caption with folder name and date from a thumbnail record. */
function updateCaption(thumb) {
  if (!showCaption) return;
  // Show only the deepest folder component to keep it concise
  const raw = (thumb.folder || '').replace(/\\/g, '/');
  const folder = raw.split('/').filter(Boolean).pop() ?? '';
  captionFolder.textContent = folder;

  let dateStr = '';
  if (thumb.datetime) {
    try {
      const d = new Date(thumb.datetime);
      dateStr = d.toLocaleDateString('en-GB', {
        day: 'numeric', month: 'long', year: 'numeric',
      });
    } catch (_) {}
  }
  captionDate.textContent = dateStr;
}

// ---------------------------------------------------------------------------
// Resize handler
// ---------------------------------------------------------------------------
function onResize() {
  ({ w: viewW, h: viewH } = _vpSize());
  canvasEl.width  = viewW;
  canvasEl.height = viewH;
  // WallCanvas reads canvas.width/height dynamically — no resize call needed
}

window.addEventListener('resize', onResize);
// visualViewport fires its own resize on iOS Safari when the toolbar shows/hides
window.visualViewport?.addEventListener('resize', onResize);

// ---------------------------------------------------------------------------
// Scan button
// ---------------------------------------------------------------------------
scanBtn.addEventListener('click', () => {
  scanBtn.classList.add('hidden');
  overlayStatus.textContent = 'Starting scan…';
  fetch('/api/scan', { method: 'POST' }).catch(console.error);
  pollStatus();
});

// ---------------------------------------------------------------------------
// Polling
// ---------------------------------------------------------------------------
let pollTimer = null;

function stopPolling() {
  if (pollTimer !== null) {
    clearTimeout(pollTimer);
    pollTimer = null;
  }
}

function pollStatus() {
  stopPolling();
  fetch('/api/status')
    .then(r => r.json())
    .then(data => {
      const progress = data.progress ?? 0;
      progressBar.style.width = `${Math.round(progress * 100)}%`;

      if (data.status === 'scanning') {
        overlayStatus.textContent = `Scanning… ${Math.round(progress * 100)}%`;
        pollTimer = setTimeout(pollStatus, 1000);

      } else if (data.status === 'ready') {
        overlayStatus.textContent = 'Loading wall…';
        progressBar.style.width = '100%';
        startWall();

      } else if (data.status === 'error') {
        overlayStatus.textContent = 'Error during scan. Reload to retry.';

      } else {
        // idle or unknown
        if (data.has_metadata) {
          overlayStatus.textContent = 'Loading wall…';
          startWall();
        } else {
          overlayStatus.textContent = 'No photos scanned yet.';
          scanBtn.classList.remove('hidden');
        }
      }
    })
    .catch(err => {
      console.error('Status poll failed:', err);
      pollTimer = setTimeout(pollStatus, 2000);
    });
}

// ---------------------------------------------------------------------------
// Start wall after metadata is ready
// ---------------------------------------------------------------------------
function startWall() {
  fetch('/api/metadata')
    .then(r => r.json())
    .then(meta => {
      boardW           = meta.board.total_width;
      boardH           = meta.board.total_height;
      boardThumbW      = meta.board.thumb_w;
      boardThumbH      = meta.board.thumb_h;
      boardFrameSide   = meta.board.frame_side   ?? 0;
      boardFrameBottom = meta.board.frame_bottom ?? 0;
      const thumbnails = meta.thumbnails ?? [];

      // Initialise canvas size
      canvasEl.width  = viewW;
      canvasEl.height = viewH;

      wall = new WallCanvas(canvasEl, meta);

      // Start in centre of board
      worldX = (boardW - viewW) / 2;
      worldY = (boardH - viewH) / 2;
      [worldX, worldY] = clampWorld(worldX, worldY, scale);

      // Hide overlay
      overlay.classList.add('hidden');

      // Begin animation
      transitionTo(State.BROWSING, thumbnails);
      rafId = requestAnimationFrame(tick);
    })
    .catch(err => {
      console.error('Failed to load metadata:', err);
      overlayStatus.textContent = 'Failed to load metadata. Reload to retry.';
    });
}

// ---------------------------------------------------------------------------
// State transition
// ---------------------------------------------------------------------------
let _thumbnails = [];  // kept for reference inside state machine

function transitionTo(newState, thumbnails) {
  if (thumbnails) _thumbnails = thumbnails;
  state = newState;

  if (newState === State.BROWSING) {
    [driftVX, driftVY] = pickDriftVelocity();
    browseStart = performance.now();
    browseDuration = randomBetween(4000, 8000);
    targetThumb = null;

  } else if (newState === State.PANNING) {
    panStartX    = worldX;
    panStartY    = worldY;
    const s      = scale;
    let [ex, ey] = worldXYToCenter(targetThumb, s);
    [ex, ey]     = clampWorld(ex, ey, s);
    panEndX      = ex;
    panEndY      = ey;
    panStartTime = performance.now();

    // Save pre-zoom position for restoration
    preZoomX     = worldX;
    preZoomY     = worldY;
    preZoomScale = scale;

  } else if (newState === State.ZOOMING_IN) {
    zoomStartScale = scale;
    zoomEndScale   = zoomScaleForThumb(targetThumb);
    zoomStartTime  = performance.now();
    // We'll interpolate world coords to keep thumb centred
    let [ex, ey] = worldXYToCenter(targetThumb, zoomEndScale);
    [ex, ey]     = clampWorld(ex, ey, zoomEndScale);
    zoomStartX   = worldX;
    zoomStartY   = worldY;
    zoomEndX     = ex;
    zoomEndY     = ey;

  } else if (newState === State.COLOR_IN) {
    fadeStartTime = 0;
    positionPhotoFrame(targetThumb);
    photoFrame.style.opacity = '0';
    photoFrame.style.display = 'block';
    // Reset both layers
    photoImgA.onload = null;
    photoImgA.src = '';
    photoImgA.style.opacity = '1';
    photoImgB.onload = null;
    photoImgB.src = '';
    photoImgB.style.opacity = '0';

    updateCaption(targetThumb);

    photoImgA.onload = () => {
      photoImgA.onload = null;
      photoImgA.onerror = null;
      fadeStartTime = performance.now();
    };
    photoImgA.onerror = () => {
      photoImgA.onerror = null;
      photoImgA.onload = null;
      // Photo couldn't be decoded — hide the frame and zoom back out
      photoFrame.style.display = 'none';
      transitionTo(State.ZOOMING_OUT);
    };
    photoImgA.src = `/api/photo/${targetThumb.id}`;

  } else if (newState === State.COLOR_OUT) {
    fadeStartTime = performance.now();

  } else if (newState === State.ZOOMING_OUT) {
    zoomStartScale = scale;
    zoomEndScale   = preZoomScale;
    zoomStartX     = worldX;
    zoomStartY     = worldY;
    zoomEndX       = preZoomX;
    zoomEndY       = preZoomY;
    zoomStartTime  = performance.now();

  } else if (newState === State.SHOWING_RELATED) {
    relatedQueue = [];
    relatedIndex = 0;
    // Fetch related then drive the sub-sequence
    fetch(`/api/related/${targetThumb.id}?window=300`)
      .then(r => r.json())
      .then(related => {
        relatedQueue = Array.isArray(related) ? related.slice(0, 5) : [];
        showNextRelated();
      })
      .catch(() => {
        relatedQueue = [];
        showNextRelated();
      });
  }
}

// ---------------------------------------------------------------------------
// SHOWING_RELATED sub-sequence (async, outside rAF)
// ---------------------------------------------------------------------------
function showNextRelated() {
  if (relatedIndex >= relatedQueue.length) {
    // All related shown (or none) — wait then fade the whole frame back to B&W
    const dwell = relatedQueue.length === 0 ? dwellMs : Math.round(fadeDuration / 2);
    setTimeout(() => transitionTo(State.COLOR_OUT), dwell);
    return;
  }

  const rel = relatedQueue[relatedIndex++];

  // Load next photo into the top layer (imgB) while imgA stays fully visible
  photoImgB.onload = null;
  photoImgB.style.opacity = '0';

  const crossFade = () => {
    fadeElement(photoImgB, 0, 1, fadeDuration, () => {
      // Cross-fade complete — promote imgB to imgA so imgB is free for next.
      photoImgA.src = photoImgB.src;
      photoImgA.style.opacity = '1';
      photoImgB.style.opacity = '0';
      updateCaption(rel);
      setTimeout(showNextRelated, dwellMs);
    });
  };

  photoImgB.src = `/api/photo/${rel.id}`;
  if (photoImgB.complete && photoImgB.naturalWidth > 0) {
    crossFade();
  } else {
    photoImgB.onload = () => {
      photoImgB.onload = null;
      photoImgB.onerror = null;
      crossFade();
    };
    photoImgB.onerror = () => {
      photoImgB.onload = null;
      photoImgB.onerror = null;
      // Skip this related photo and try the next one
      setTimeout(showNextRelated, 0);
    };
  }
}

function fadeElement(el, fromOpacity, toOpacity, durationMs, onDone) {
  const start = performance.now();
  el.style.opacity = String(fromOpacity);

  function step(now) {
    const t = Math.min(1, (now - start) / durationMs);
    el.style.opacity = String(fromOpacity + (toOpacity - fromOpacity) * easeInOutCubic(t));
    if (t < 1) {
      requestAnimationFrame(step);
    } else {
      el.style.opacity = String(toOpacity);
      if (onDone) onDone();
    }
  }
  requestAnimationFrame(step);
}

// ---------------------------------------------------------------------------
// COLOR_IN image-load wait tracking
// ---------------------------------------------------------------------------
// We use a simple flag: once src is set and onload fires we begin the fade.
// The fade progress is tracked via a separate variable.
let colorInFadeStarted = false;

// ---------------------------------------------------------------------------
// Main animation loop
// ---------------------------------------------------------------------------
function tick(now) {
  rafId = requestAnimationFrame(tick);

  switch (state) {

    // -----------------------------------------------------------------------
    case State.BROWSING: {
      // Drift
      worldX += driftVX;
      worldY += driftVY;

      const maxX = Math.max(0, boardW - viewW / scale);
      const maxY = Math.max(0, boardH - viewH / scale);

      if (worldX <= 0)    { worldX = 0;    driftVX = Math.abs(driftVX); }
      if (worldX >= maxX) { worldX = maxX; driftVX = -Math.abs(driftVX); }
      if (worldY <= 0)    { worldY = 0;    driftVY = Math.abs(driftVY); }
      if (worldY >= maxY) { worldY = maxY; driftVY = -Math.abs(driftVY); }

      wall.draw(worldX, worldY, scale);

      // Timer
      if (now - browseStart >= browseDuration && _thumbnails.length > 0) {
        targetThumb = pickRandomThumb(_thumbnails);
        transitionTo(State.PANNING);
      }
      break;
    }

    // -----------------------------------------------------------------------
    case State.PANNING: {
      const t = Math.min(1, (now - panStartTime) / PAN_DURATION);
      const e = easeInOutCubic(t);

      worldX = panStartX + (panEndX - panStartX) * e;
      worldY = panStartY + (panEndY - panStartY) * e;

      wall.draw(worldX, worldY, scale);

      if (t >= 1) {
        transitionTo(State.ZOOMING_IN);
      }
      break;
    }

    // -----------------------------------------------------------------------
    case State.ZOOMING_IN: {
      const t = Math.min(1, (now - zoomStartTime) / ZOOM_DURATION);
      const e = easeInOutCubic(t);

      scale  = zoomStartScale + (zoomEndScale  - zoomStartScale)  * e;
      worldX = zoomStartX     + (zoomEndX      - zoomStartX)      * e;
      worldY = zoomStartY     + (zoomEndY      - zoomStartY)      * e;
      [worldX, worldY] = clampWorld(worldX, worldY, scale);

      wall.draw(worldX, worldY, scale);

      if (t >= 1) {
        colorInFadeStarted = false;
        transitionTo(State.COLOR_IN);
      }
      break;
    }

    // -----------------------------------------------------------------------
    case State.COLOR_IN: {
      // Keep frame aligned as world may have settled
      positionPhotoFrame(targetThumb);
      wall.draw(worldX, worldY, scale);

      // The fade is driven by photoImg.onload setting fadeStartTime,
      // but we detect it here to update opacity smoothly in rAF.
      if (!colorInFadeStarted && fadeStartTime > 0) {
        colorInFadeStarted = true;
      }
      if (colorInFadeStarted) {
        const t = Math.min(1, (now - fadeStartTime) / fadeDuration);
        photoFrame.style.opacity = String(easeInOutCubic(t));
        if (t >= 1) {
          photoFrame.style.opacity = '1';
          transitionTo(State.SHOWING_RELATED);
        }
      }
      break;
    }

    // -----------------------------------------------------------------------
    case State.SHOWING_RELATED: {
      // Async sub-sequence manages itself; just keep canvas stable
      wall.draw(worldX, worldY, scale);
      break;
    }

    // -----------------------------------------------------------------------
    case State.COLOR_OUT: {
      const t = Math.min(1, (now - fadeStartTime) / fadeDuration);
      photoFrame.style.opacity = String(1 - easeInOutCubic(t));
      wall.draw(worldX, worldY, scale);

      if (t >= 1) {
        photoFrame.style.opacity = '0';
        photoFrame.style.display = 'none';
        photoImgA.src = '';
        photoImgB.src = '';
        transitionTo(State.ZOOMING_OUT);
      }
      break;
    }

    // -----------------------------------------------------------------------
    case State.ZOOMING_OUT: {
      const t = Math.min(1, (now - zoomStartTime) / ZOOM_DURATION);
      const e = easeInOutCubic(t);

      scale  = zoomStartScale + (zoomEndScale  - zoomStartScale)  * e;
      worldX = zoomStartX     + (zoomEndX      - zoomStartX)      * e;
      worldY = zoomStartY     + (zoomEndY      - zoomStartY)      * e;
      [worldX, worldY] = clampWorld(worldX, worldY, scale);

      wall.draw(worldX, worldY, scale);

      if (t >= 1) {
        // Short pause before next BROWSING cycle
        cancelAnimationFrame(rafId);
        rafId = null;
        setTimeout(() => {
          transitionTo(State.BROWSING);
          rafId = requestAnimationFrame(tick);
        }, 600);
      }
      break;
    }

    // -----------------------------------------------------------------------
    default:
      break;
  }
}

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------
function init() {
  overlay.classList.remove('hidden');
  scanBtn.classList.add('hidden');
  overlayStatus.textContent = 'Checking status…';
  progressBar.style.width = '0%';

  // Fetch config and status in parallel; config failure is non-fatal (defaults apply)
  Promise.all([
    fetch('/api/config').then(r => r.json()).catch(() => ({})),
    fetch('/api/status').then(r => r.json()),
  ])
    .then(([cfg, data]) => {
      if (cfg.fade_ms      != null) fadeDuration = cfg.fade_ms;
      if (cfg.dwell_ms     != null) dwellMs      = cfg.dwell_ms;
      if (cfg.show_caption != null) showCaption  = cfg.show_caption;
      captionEl.style.display = showCaption ? '' : 'none';

      if (data.status === 'ready' || data.has_metadata) {
        overlayStatus.textContent = 'Loading wall…';
        startWall();
      } else if (data.status === 'scanning') {
        overlayStatus.textContent = 'Scanning…';
        pollStatus();
      } else {
        overlayStatus.textContent = 'Starting initial scan…';
        fetch('/api/scan', { method: 'POST' }).catch(console.error);
        pollStatus();
      }
    })
    .catch(err => {
      console.error('Initial status check failed:', err);
      overlayStatus.textContent = 'Cannot reach server. Retrying…';
      setTimeout(init, 3000);
    });
}

init();
