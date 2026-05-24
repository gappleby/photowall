/**
 * canvas-wall.js
 * Manages a virtual canvas for the photowall app.
 * Renders only visible B&W photo thumbnails plus a buffer,
 * fetching lazily from the API and evicting when out of range.
 */

const MAX_CACHE_SIZE = 500;
const EVICT_BUFFER_MULTIPLIERS = 2; // viewport-widths outside visible area

export class WallCanvas {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {Object} metadata - Parsed /api/metadata JSON
   */
  constructor(canvas, metadata) {
    this._canvas = canvas;
    this._ctx = canvas.getContext('2d');
    this._ctx.imageSmoothingEnabled = true;
    this._ctx.imageSmoothingQuality = 'high';

    this._board = metadata.board;
    this._thumbnails = metadata.thumbnails;

    // Spatial index: Map from "col,row" to thumbnail record
    this._gridIndex = new Map();
    for (const thumb of this._thumbnails) {
      this._gridIndex.set(`${thumb.col},${thumb.row}`, thumb);
    }

    // Image cache: Map<id, HTMLImageElement>
    this._cache = new Map();

    // LRU tracking: Map<id, accessOrder> — higher = more recent
    this._lruOrder = new Map();
    this._lruCounter = 0;

    // Track the last known viewport so redraws triggered by image loads
    // can re-render without needing new draw() arguments.
    this._lastWorldX = 0;
    this._lastWorldY = 0;
    this._lastScale = 1;

    // Bind the redraw callback used by image load handlers
    this._onImageLoad = () => {
      this.draw(this._lastWorldX, this._lastWorldY, this._lastScale);
    };
  }

  /**
   * Render the visible portion of the wall.
   * @param {number} worldX - Left edge of the visible world region (px)
   * @param {number} worldY - Top edge of the visible world region (px)
   * @param {number} scale  - Zoom factor (1 = normal)
   */
  draw(worldX, worldY, scale) {
    this._lastWorldX = worldX;
    this._lastWorldY = worldY;
    this._lastScale = scale;

    const ctx = this._ctx;
    const canvas = this._canvas;
    const viewW = canvas.width;
    const viewH = canvas.height;

    // World-space dimensions of the viewport
    const worldViewW = viewW / scale;
    const worldViewH = viewH / scale;

    // Clear the canvas
    ctx.clearRect(0, 0, viewW, viewH);

    // Determine which grid cells overlap the visible world rectangle
    const board = this._board;
    const thumbW    = board.thumb_w;
    const thumbH    = board.thumb_h;
    const cellW     = board.cell_w     ?? thumbW;   // fallback for old metadata
    const cellH     = board.cell_h     ?? thumbH;
    const frameSide = board.frame_side ?? 0;
    const polaroidW = board.polaroid_w ?? thumbW;
    const polaroidH = board.polaroid_h ?? thumbH;

    const colStart = Math.max(0, Math.floor(worldX / cellW));
    const colEnd   = Math.min(board.cols - 1, Math.ceil((worldX + worldViewW) / cellW));
    const rowStart = Math.max(0, Math.floor(worldY / cellH));
    const rowEnd   = Math.min(board.rows - 1, Math.ceil((worldY + worldViewH) / cellH));

    // Evict images that are far outside the visible area
    this._evict(worldX, worldViewW, worldY, worldViewH);

    // Draw each visible cell
    for (let row = rowStart; row <= rowEnd; row++) {
      for (let col = colStart; col <= colEnd; col++) {
        const thumb = this._gridIndex.get(`${col},${row}`);
        if (!thumb) continue;

        const screenX  = (thumb.x - worldX) * scale;
        const screenY  = (thumb.y - worldY) * scale;
        const pW       = polaroidW * scale;
        const pH       = polaroidH * scale;

        // White polaroid frame with a soft drop shadow
        ctx.save();
        ctx.shadowColor    = 'rgba(0,0,0,0.45)';
        ctx.shadowBlur     = 8 * scale;
        ctx.shadowOffsetX  = 2 * scale;
        ctx.shadowOffsetY  = 3 * scale;
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(screenX, screenY, pW, pH);
        ctx.restore();

        // Photo area (inside the white frame)
        const photoX = screenX + frameSide * scale;
        const photoY = screenY + frameSide * scale;
        const photoW = thumbW  * scale;
        const photoH = thumbH  * scale;

        if (this._cache.has(thumb.id)) {
          this._lruOrder.set(thumb.id, ++this._lruCounter);
          const img = this._cache.get(thumb.id);
          ctx.drawImage(img, photoX, photoY, photoW, photoH);
        } else {
          // Light grey placeholder inside the white frame while loading
          ctx.fillStyle = '#cccccc';
          ctx.fillRect(photoX, photoY, photoW, photoH);
          this._fetchImage(thumb);
        }
      }
    }
  }

  /**
   * Returns the thumbnail record nearest to world coordinates (wx, wy).
   * @param {number} wx
   * @param {number} wy
   * @returns {Object|null}
   */
  getThumbnailAt(wx, wy) {
    const board = this._board;
    const col = Math.floor(wx / board.thumb_w);
    const row = Math.floor(wy / board.thumb_h);

    // Try exact cell first
    const exact = this._gridIndex.get(`${col},${row}`);
    if (exact) return exact;

    // Fall back to nearest occupied cell by searching adjacent cells
    const searchRadius = 2;
    let nearest = null;
    let bestDist = Infinity;

    for (let dr = -searchRadius; dr <= searchRadius; dr++) {
      for (let dc = -searchRadius; dc <= searchRadius; dc++) {
        const c = col + dc;
        const r = row + dr;
        if (c < 0 || r < 0 || c >= board.cols || r >= board.rows) continue;
        const thumb = this._gridIndex.get(`${c},${r}`);
        if (!thumb) continue;
        const cx = thumb.x + thumb.w / 2;
        const cy = thumb.y + thumb.h / 2;
        const dist = Math.hypot(wx - cx, wy - cy);
        if (dist < bestDist) {
          bestDist = dist;
          nearest = thumb;
        }
      }
    }

    return nearest;
  }

  /**
   * Returns a random thumbnail record.
   * @returns {Object}
   */
  getRandomThumbnail() {
    const idx = Math.floor(Math.random() * this._thumbnails.length);
    return this._thumbnails[idx];
  }

  /**
   * Returns the world-space center {x, y} of a thumbnail record.
   * @param {Object} thumb
   * @returns {{x: number, y: number}}
   */
  getCenter(thumb) {
    return {
      x: thumb.x + thumb.w / 2,
      y: thumb.y + thumb.h / 2,
    };
  }

  /**
   * Frees all cached image objects. Call when leaving the wall view.
   */
  clearCache() {
    this._cache.clear();
    this._lruOrder.clear();
    this._lruCounter = 0;
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Starts loading a thumbnail image if not already in-flight.
   * @param {Object} thumb
   */
  _fetchImage(thumb) {
    // Avoid duplicate fetches — mark as in-flight by inserting a sentinel
    if (this._cache.has(thumb.id)) return;

    const img = new Image();

    // Reserve the slot immediately so concurrent draw() calls don't
    // re-request the same image while it is still loading.
    this._cache.set(thumb.id, img);
    this._lruOrder.set(thumb.id, ++this._lruCounter);

    img.onload = () => {
      // Image is already in the cache; just trigger a redraw.
      this._onImageLoad();
    };

    img.onerror = () => {
      // Remove failed entries so they can be retried on the next draw pass.
      this._cache.delete(thumb.id);
      this._lruOrder.delete(thumb.id);
    };

    img.src = `/api/thumb/${thumb.id}`;

    // Enforce max cache size after inserting
    this._enforceCacheLimit();
  }

  /**
   * Evicts images that are more than EVICT_BUFFER_MULTIPLIERS viewport-widths
   * outside the visible area, and enforces the hard MAX_CACHE_SIZE cap via LRU.
   */
  _evict(worldX, worldViewW, worldY, worldViewH) {
    const buffer = EVICT_BUFFER_MULTIPLIERS * worldViewW;

    const minX = worldX - buffer;
    const maxX = worldX + worldViewW + buffer;
    // Use a proportional vertical buffer (scaled by aspect ratio)
    const bufferY = EVICT_BUFFER_MULTIPLIERS * worldViewH;
    const minY = worldY - bufferY;
    const maxY = worldY + worldViewH + bufferY;

    for (const [id, img] of this._cache) {
      // Find the corresponding thumbnail to check its position
      // We need the thumbnail's world rect; look it up by id.
      // Build a reverse id->thumb lookup lazily if needed.
      const thumb = this._thumbById(id);
      if (!thumb) {
        this._cache.delete(id);
        this._lruOrder.delete(id);
        continue;
      }

      const thumbRight  = thumb.x + thumb.w;
      const thumbBottom = thumb.y + thumb.h;

      const outOfRange =
        thumbRight < minX ||
        thumb.x    > maxX ||
        thumbBottom < minY ||
        thumb.y    > maxY;

      if (outOfRange) {
        this._cache.delete(id);
        this._lruOrder.delete(id);
      }
    }

    this._enforceCacheLimit();
  }

  /**
   * Drops the least-recently-used entries until cache is within MAX_CACHE_SIZE.
   */
  _enforceCacheLimit() {
    if (this._cache.size <= MAX_CACHE_SIZE) return;

    // Sort by LRU order ascending (lowest = oldest)
    const sorted = [...this._lruOrder.entries()].sort((a, b) => a[1] - b[1]);
    const toRemove = this._cache.size - MAX_CACHE_SIZE;

    for (let i = 0; i < toRemove && i < sorted.length; i++) {
      const id = sorted[i][0];
      this._cache.delete(id);
      this._lruOrder.delete(id);
    }
  }

  /**
   * Returns the thumbnail record for a given id.
   * Builds a lazy id-keyed index on first call.
   * @param {string} id
   * @returns {Object|null}
   */
  _thumbById(id) {
    if (!this._idIndex) {
      this._idIndex = new Map();
      for (const thumb of this._thumbnails) {
        this._idIndex.set(thumb.id, thumb);
      }
    }
    return this._idIndex.get(id) ?? null;
  }
}
