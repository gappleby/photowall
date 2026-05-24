# Photo Wall

A browser-based photo wall that recreates the Windows 7 Media Center slideshow effect.

## Quick start

1. **Edit `config.json`** and set `photos_dir` to your photos folder and `cache_dir` to a writable directory for thumbnails.

2. **Install dependencies** (once):
   ```
   pip install -r requirements.txt
   ```

3. **Run the server**:
   ```
   python run.py
   ```

4. **Open Chrome** and go to `http://127.0.0.1:8000`

The first run will automatically scan your photos folder and build the thumbnail library.  
Subsequent runs load the cached thumbnails instantly.

## config.json options

| Key | Default | Description |
|-----|---------|-------------|
| `photos_dir` | `C:/Users/Public/Pictures` | Root folder containing your photos |
| `cache_dir` | `./cache` | Where thumbnails and metadata are stored (separate from photos) |
| `host` | `127.0.0.1` | Server host |
| `port` | `8000` | Server port |
| `thumb_width` | `120` | Thumbnail width in pixels |
| `thumb_height` | `90` | Thumbnail height in pixels |
| `board_cols` | `80` | Number of thumbnail columns on the wall |
| `related_window_seconds` | `300` | Time window (±seconds) for grouping related photos |

## How it works

- The backend scans your photos folder recursively, generates B&W JPEG thumbnails, and writes `metadata.json` into the cache directory.
- The browser loads only the thumbnails currently visible on screen (virtual canvas), keeping memory usage low even with thousands of photos.
- Full-resolution colour photos are fetched one at a time during the spotlight sequence and released immediately after.

## Rescanning

If you add photos, click **Build Thumbnail Library** in the browser overlay, or POST to `/api/scan`.
