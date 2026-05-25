# Photo Wall

A browser-based photo wall that recreates the Windows 7 Media Center slideshow experience. Point it at a folder of photos and open Chrome — it builds a large black-and-white collage of polaroid-style thumbnails, pans and zooms into individual photos, cross-fades them to full colour, shows related photos taken at the same time, then fades back and moves on.

**Repository:** https://github.com/gappleby/photowall

---

## How it works

- A Python/FastAPI backend scans your photos folder recursively, generates B&W JPEG thumbnails using a cover-crop (matching `object-fit: cover`) so the thumbnail and the colour overlay always show the same portion of the photo, and writes `metadata.json` into a separate cache directory.
- The browser renders a virtual canvas — only thumbnails currently visible on screen are loaded, keeping memory low even with thousands of photos.
- The presentation runs as a continuous animation loop:

  1. **Drift** — the collage slowly pans around (larger than the screen so it can move freely)
  2. **Pan** — smoothly slides to bring a chosen thumbnail near centre
  3. **Zoom in** — scales the thumbnail to 80% of the screen
  4. **Colour fade** — cross-fades from the B&W thumbnail to the full-resolution colour photo
  5. **Related photos** — any photos taken within ±5 minutes cross-fade between each other with alternating zoom/pan effects (see below)
  6. **Fade out** — cross-fades back to the B&W thumbnail
  7. **Zoom out** — returns to the collage and repeats

- Each photo in the collage is styled as a polaroid with a white frame, a larger bottom border, and a black gap between cards.
- An optional caption in the bottom white panel shows the folder name and date of the photo being displayed.
- Video files are never included. Non-browser-renderable formats (TIFF, BMP, HEIC) are automatically transcoded to JPEG by the server.

### Related photo zoom/pan effects

When related photos cross-fade, each photo gets a slow zoom and pan that starts halfway through the cross-fade and completes at the end of the dwell period. The two effects alternate:

| Photo in sequence | Start state | End state | Effect |
|---|---|---|---|
| 1st, 3rd, 5th … | Scale 1×, centred | Scale 1.2×, panned NW 10% | Zooms in toward the top-left corner |
| 2nd, 4th … | Scale 1.2×, panned to SE 10% | Scale 1×, centred | Zooms out from the bottom-right corner |

The zoom is clipped to the photo area so it never bleeds into the white polaroid border.

---

## Running locally

### Prerequisites

- Python 3.11 or later
- Chrome (other browsers may work but are untested)

### Setup

1. Clone the repository:
   ```bash
   git clone https://github.com/gappleby/photowall.git
   cd photowall
   ```

2. Install Python dependencies:
   ```bash
   pip install -r requirements.txt
   ```

3. Edit `config.json` and set `photos_dir` to your photos folder:
   ```json
   {
     "photos_dir": "C:/Users/YourName/Pictures",
     "cache_dir": "C:/source/Repos/photowall/cache"
   }
   ```

4. Start the server:
   ```bash
   python run.py
   ```

5. Open Chrome and go to `http://127.0.0.1:8000`

The first run automatically scans your photos and builds the thumbnail library. Subsequent starts load the cache instantly.

---

## Configuration

All settings live in `config.json` in the project root.

| Key | Default | Description |
|-----|---------|-------------|
| `photos_dir` | `C:/Users/Public/Pictures` | Root folder to scan recursively for photos |
| `cache_dir` | `./cache` | Where generated thumbnails and metadata are stored (keep separate from photos) |
| `host` | `127.0.0.1` | Server bind address (`0.0.0.0` to expose on the network) |
| `port` | `8000` | Server port |
| `thumb_width` | `120` | Thumbnail width in pixels |
| `thumb_height` | `90` | Thumbnail height in pixels |
| `board_cols` | `80` | Number of thumbnail columns on the wall |
| `related_window_seconds` | `300` | Time window (±seconds) used to group photos taken at the same time |
| `fade_ms` | `2000` | Duration of every cross-fade transition in milliseconds |
| `dwell_ms` | `4000` | How long each colour photo is held before the next cross-fade |
| `show_caption` | `true` | Show folder name and date in the bottom polaroid panel |
| `zoom_pan` | `true` | Enable the alternating zoom/pan effect on related photos |
| `auto_scan_hours` | `4` | Automatically rescan in the background every N hours. Set to `0` to disable. |

### Rescanning

If you add photos, click **Build Thumbnail Library** in the browser overlay, or send:
```bash
curl -X POST http://127.0.0.1:8000/api/scan
```

The scanner is incremental — only new photos get thumbnails generated; existing thumbnails are reused. The cache directory can be deleted entirely at any time and will be rebuilt on the next scan.

> **Note:** If you were running a version prior to the cover-crop thumbnail change, delete the cache directory and rescan. Old thumbnails were letterboxed with grey padding, which caused a visible mismatch with the colour photo overlay on non-4:3 images.

---

## Running with Docker

A pre-built multi-architecture image (`linux/amd64`, `linux/arm64`) is published to the GitHub Container Registry on every push to `main`.

### Quick start

```bash
docker run -d \
  --name photowall \
  --restart unless-stopped \
  -p 8000:8000 \
  -v /path/to/your/photos:/photos:ro \
  -v /path/to/cache:/cache \
  ghcr.io/gappleby/photowall:latest
```

The default container config (`config.docker.json`, baked into the image) already points `photos_dir` to `/photos` and `cache_dir` to `/cache`.

### Overriding configuration

Mount your own `config.json` over the default:

```bash
docker run -d \
  --name photowall \
  --restart unless-stopped \
  -p 8000:8000 \
  -v /path/to/my-config.json:/app/config.json:ro \
  -v /path/to/your/photos:/photos:ro \
  -v /path/to/cache:/cache \
  ghcr.io/gappleby/photowall:latest
```

Your `config.json` must use **container paths** for `photos_dir` and `cache_dir` (i.e. the paths as seen inside the container, matching your volume mounts), and `host` must be `0.0.0.0`.

### docker-compose

A `docker-compose.yml` is included. Edit the volume paths then run:

```bash
docker compose up -d
```

### Updating

```bash
docker pull ghcr.io/gappleby/photowall:latest
docker compose up -d          # if using docker-compose
# or stop/remove/re-run the docker run command above
```

The cache survives updates because it is stored on the host filesystem.

---

## Deploying to a QNAP NAS

Container Station (available from the QNAP App Center) provides Docker on QNAP NAS devices.

### 1 — Find your NAS paths

Shared folders are accessible at `/share/SHARENAME` over SSH. Connect and list them:

```bash
ssh admin@YOUR-NAS-IP
ls /share/
```

### 2 — Create the working directory

```bash
mkdir -p /share/homes/admin/photowall/cache
```

### 3 — Create config.json on the NAS

The paths in `config.json` are **container paths**, not NAS paths — the volume mounts in the next step connect them.

```bash
cat > /share/homes/admin/photowall/config.json << 'EOF'
{
  "photos_dir": "/photos",
  "cache_dir": "/cache",
  "host": "0.0.0.0",
  "port": 8000,
  "thumb_width": 120,
  "thumb_height": 90,
  "board_cols": 80,
  "related_window_seconds": 300,
  "fade_ms": 2000,
  "dwell_ms": 4000,
  "show_caption": true
}
EOF
```

### 4 — Start the container

**Via SSH:**

```bash
docker run -d \
  --name photowall \
  --restart unless-stopped \
  -p 8000:8000 \
  -v /share/homes/admin/photowall/config.json:/app/config.json:ro \
  -v /share/Photos:/photos:ro \
  -v /share/homes/admin/photowall/cache:/cache \
  ghcr.io/gappleby/photowall:latest
```

Replace `/share/Photos` with the actual path to your photos share.

**Via Container Station GUI:**

1. Open Container Station → **Create** → **Create Container**
2. Image: `ghcr.io/gappleby/photowall:latest`
3. **Network** tab → Port: host `8000` → container `8000`
4. **Storage** tab → add three volume mounts:

| Host path (NAS) | Container path | Mode |
|---|---|---|
| `/share/homes/admin/photowall/config.json` | `/app/config.json` | Read only |
| `/share/Photos` | `/photos` | Read only |
| `/share/homes/admin/photowall/cache` | `/cache` | Read/Write |

5. Click **Create**

### 5 — Open in Chrome

```
http://YOUR-NAS-IP:8000
```

---

## Building the Docker image yourself

The GitHub Actions workflow at `.github/workflows/docker.yml` builds and pushes automatically. To build locally:

```bash
docker build -t photowall .
docker run -d --name photowall -p 8000:8000 \
  -v /path/to/photos:/photos:ro \
  -v ./cache:/cache \
  photowall
```

---

## Project structure

```
photowall/
├── backend/
│   ├── config.py        # Loads config.json
│   ├── scanner.py       # Background scan + B&W thumbnail generation (Pillow)
│   └── main.py          # FastAPI: REST API + static file serving
├── frontend/
│   ├── index.html
│   ├── styles.css
│   ├── canvas-wall.js   # Virtual canvas: LRU-cached tile loading, viewport culling
│   └── app.js           # 8-state animation state machine
├── run.py               # Entry point
├── config.json          # Local development configuration
├── config.docker.json   # Default configuration baked into the Docker image
├── Dockerfile
├── docker-compose.yml
└── requirements.txt
```

## API endpoints

| Endpoint | Description |
|---|---|
| `GET /api/status` | Scan status and progress |
| `POST /api/scan` | Trigger a new scan |
| `GET /api/config` | Returns `fade_ms`, `dwell_ms`, `show_caption`, `zoom_pan`, `auto_scan_hours` |
| `GET /api/metadata` | Full board layout and thumbnail records |
| `GET /api/thumb/{id}` | B&W thumbnail JPEG |
| `GET /api/photo/{id}` | Full-resolution colour photo (transcoded to JPEG if needed) |
| `GET /api/related/{id}` | Photos taken within `related_window_seconds` of this one |
