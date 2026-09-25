# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

Photo Wall recreates the Windows 7 Media Center photo slideshow in the browser: a B&W polaroid collage that drifts, pans/zooms into a photo, cross-fades it to colour, cycles through photos taken around the same time, then zooms back out. Python/FastAPI backend; vanilla ES-module JS frontend with no build step.

## Commands

```bash
pip install -r requirements.txt
python run.py                      # serves API + frontend on host/port from config.json (http://127.0.0.1:8000)
curl -X POST http://127.0.0.1:8000/api/scan   # trigger a rescan

docker build -t photowall .        # local image (uses config.docker.json as /app/config.json)
docker compose up -d
```

There are no tests, linters, or frontend build tooling. Frontend changes take effect on browser reload (static files served by FastAPI). Verify changes by running the app in a browser; Chrome is the primary target, but Safari (including iOS) compatibility has been deliberately fixed and should be preserved.

## Architecture

**Config** — `backend/config.py` loads `config.json` from the repo root once at import into the global `CFG` (paths become `Path` objects). `config.json` is the local dev config (its `photos_dir` is machine-specific); `config.docker.json` is baked into the image and uses container paths `/photos` and `/cache`. When adding a config key, update both files, the README config table, and — if the frontend needs it — expose it via `GET /api/config` in `backend/main.py` and read it in `init()` in `frontend/app.js`.

**Scan pipeline** — `backend/scanner.py` runs in a background thread (startup scan + every `auto_scan_hours`, and on `POST /api/scan`), guarded by a module-level `_state` dict + lock that `/api/status` reports. It:
- Assigns each photo an ID = first 16 hex of SHA-1 of its POSIX path **relative to `photos_dir`**, so IDs are stable across mount points and Windows/Docker. Thumbnails from the older absolute-path scheme (`_legacy_photo_id`) are renamed in place on the next scan.
- Generates greyscale thumbnails with `ImageOps.fit` (cover-crop) after `exif_transpose`. The cover-crop must match the frontend's `object-fit: cover` on the colour overlay so B&W and colour show the identical region.
- Is incremental: existing thumbs are reused and EXIF datetimes (`exif_datetime`) are taken from the previous `metadata.json` to avoid reopening source files (important on NAS/network shares). Orphaned thumbs are deleted. With `mtime_fallback`, photos lacking EXIF get the file mtime as their effective `datetime`/`datetime_ts` (`exif_datetime` stays null). `metadata.json` is written atomically (tmp + `os.replace`).
- Lays out the board: photos fill a grid `board_cols` wide, ordered by photo ID when `shuffle_wall` is on (stable pseudo-random, so same-shoot photos aren't adjacent) or by sorted path when off. `_polaroid_dims()` derives frame/gap/cell sizes from thumb size; these are written into `metadata.json` under `board` and are the single source of truth for geometry on the frontend.

Everything the frontend knows comes from `cache/metadata.json` (`board` + `thumbnails[]` with `x,y,w,h` = polaroid rect in world coords, `path`, `folder`, `datetime`, `datetime_ts`). The cache directory is disposable.

**API** (`backend/main.py`) — `/api/photo/{id}` serves browser-native formats directly and transcodes others (TIFF/BMP/HEIC) to JPEG/PNG via Pillow. `/api/related/{id}` returns up to 20 photos within ±`window` seconds by EXIF timestamp. Endpoints get metadata via `_get_metadata()`, an in-memory cache plus id index that reloads when `metadata.json`'s mtime changes. `/api/related` defaults its window to `related_window_seconds`. The frontend is mounted as static files at `/` last, so API routes must be declared before the mount.

**Frontend rendering** — two layers stacked in `#stage`:
1. `frontend/canvas-wall.js` (`WallCanvas`): a virtual canvas that draws only grid cells intersecting the viewport given `(worldX, worldY, scale)`, lazily loading thumbnails into an LRU cache (max 500, evicting beyond 2 viewports).
2. `#photo-frame` DOM overlay (in `index.html`): positioned over the target polaroid's screen rect by `positionPhotoFrame()`, holding two stacked `<img>` layers (`photo-img-a` base, `photo-img-b` cross-fade) inside `#photo-photo-area` which clips zoom/pan transforms so they never bleed into the white border. Frame border sizes are passed via CSS custom properties `--frame-side` / `--frame-bottom`.

**Animation state machine** (`frontend/app.js`) — a single `requestAnimationFrame` `tick()` switches on `state`: `BROWSING → PANNING → ZOOMING_IN → COLOR_IN → SHOWING_RELATED → COLOR_OUT → ZOOMING_OUT → BROWSING`. `transitionTo()` sets up each state's start/end values; `tick()` interpolates with `easeInOutCubic`. `SHOWING_RELATED` is the exception: it runs as an async `setTimeout`/`fadeElement` chain (`showNextRelated()`) outside the rAF switch, fading imgB in over imgA, then "promoting" imgB into imgA (copying its computed transform to avoid a jump). The optional zoom/pan effect (`zoom_pan`) alternates per related photo between zoom-in-to-NW and zoom-out-from-SE, starting halfway through the fade and ending at promotion.

Viewport size comes from `window.visualViewport` (needed for iOS Safari); keep using `_vpSize()` rather than `innerWidth/innerHeight`.

## Deployment

GitHub Actions (`.github/workflows/docker.yml`) builds multi-arch (amd64/arm64) images and pushes to `ghcr.io/gappleby/photowall` on pushes to `main` (`:latest`) and `v*.*.*` tags; PRs build only. The container runs as non-root uid 1000 with a healthcheck on `/api/status`. The README documents QNAP Container Station deployment.
