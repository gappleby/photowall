import io
import mimetypes
import threading
import time
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from PIL import Image, ImageOps

from . import scanner
from .config import CFG


# ---------------------------------------------------------------------------
# Background auto-scan loop
# ---------------------------------------------------------------------------

def _scan_args():
    return (
        CFG["photos_dir"],
        CFG["cache_dir"],
        CFG["thumb_width"],
        CFG["thumb_height"],
        CFG["board_cols"],
        CFG.get("mtime_fallback", False),
        CFG.get("shuffle_wall", True),
    )


# ---------------------------------------------------------------------------
# In-memory metadata cache — reloaded only when metadata.json changes on disk
# ---------------------------------------------------------------------------

_meta_lock = threading.Lock()
_meta_cache = {"mtime": None, "meta": None, "by_id": {}}


def _get_metadata() -> tuple[dict | None, dict]:
    """Returns (metadata, {id: record}), or (None, {}) if no scan has completed."""
    path = CFG["cache_dir"] / "metadata.json"
    try:
        mtime = path.stat().st_mtime_ns
    except FileNotFoundError:
        return None, {}
    with _meta_lock:
        if _meta_cache["mtime"] != mtime:
            meta = scanner.load_metadata(CFG["cache_dir"])
            _meta_cache["meta"] = meta
            _meta_cache["by_id"] = {t["id"]: t for t in meta["thumbnails"]} if meta else {}
            _meta_cache["mtime"] = mtime
        return _meta_cache["meta"], _meta_cache["by_id"]


def _auto_scan_loop():
    """Runs once on startup, then repeats every auto_scan_hours.
    Set auto_scan_hours to 0 in config.json to disable periodic rescanning
    (a single startup scan still runs)."""
    interval_hours = CFG.get("auto_scan_hours", 4)

    # Always scan on startup so a server restart picks up new photos
    scanner.scan(*_scan_args())

    if interval_hours <= 0:
        return

    interval_secs = int(interval_hours) * 3600
    while True:
        time.sleep(interval_secs)
        scanner.scan(*_scan_args())


@asynccontextmanager
async def lifespan(app: FastAPI):
    threading.Thread(target=_auto_scan_loop, daemon=True).start()
    yield


app = FastAPI(title="Photowall API", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

_FRONTEND = Path(__file__).parent.parent / "frontend"


# ---------------------------------------------------------------------------
# Chrome DevTools probe — return empty object so it doesn't log a 404
# ---------------------------------------------------------------------------

@app.get("/.well-known/appspecific/com.chrome.devtools.json")
def chrome_devtools():
    return {}


# ---------------------------------------------------------------------------
# Config endpoint
# ---------------------------------------------------------------------------

@app.get("/api/config")
def get_config():
    return {
        "fade_ms":         CFG.get("fade_ms",         2000),
        "dwell_ms":        CFG.get("dwell_ms",        4000),
        "show_caption":    CFG.get("show_caption",    True),
        "zoom_pan":        CFG.get("zoom_pan",        True),
        "auto_scan_hours": CFG.get("auto_scan_hours", 4),
    }


# ---------------------------------------------------------------------------
# Scan endpoints
# ---------------------------------------------------------------------------

@app.get("/api/status")
def status():
    state = scanner.get_state()
    state["has_metadata"] = (CFG["cache_dir"] / "metadata.json").exists()
    return state


@app.post("/api/scan")
def start_scan():
    t = threading.Thread(target=scanner.scan, args=_scan_args(), daemon=True)
    t.start()
    return {"started": True}


@app.get("/api/metadata")
def metadata():
    meta, _ = _get_metadata()
    if meta is None:
        raise HTTPException(404, "No metadata — run /api/scan first")
    return meta


# ---------------------------------------------------------------------------
# Image endpoints
# ---------------------------------------------------------------------------

@app.get("/api/thumb/{photo_id}")
def thumb(photo_id: str):
    path = CFG["cache_dir"] / "thumbs" / f"{photo_id}.jpg"
    if not path.exists():
        raise HTTPException(404, "Thumbnail not found")
    return FileResponse(path, media_type="image/jpeg", headers={"Cache-Control": "max-age=86400"})


# Formats Chrome renders natively — served as-is for speed
_BROWSER_NATIVE = frozenset({".jpg", ".jpeg", ".png", ".gif", ".webp"})


@app.get("/api/photo/{photo_id}")
def photo(photo_id: str):
    meta, by_id = _get_metadata()
    if meta is None:
        raise HTTPException(404, "No metadata")
    record = by_id.get(photo_id)
    if record is None:
        raise HTTPException(404, "Photo not found")
    path = CFG["photos_dir"] / record["path"]
    if not path.exists():
        raise HTTPException(404, "File not found on disk")

    suffix = path.suffix.lower()
    if suffix in _BROWSER_NATIVE:
        mime, _ = mimetypes.guess_type(str(path))
        return FileResponse(path, media_type=mime or "image/jpeg",
                            headers={"Cache-Control": "max-age=3600"})

    # Transcode TIFF, BMP, HEIC, and any other Pillow-supported format to
    # JPEG so Chrome can always decode it.
    try:
        with Image.open(path) as img:
            img = ImageOps.exif_transpose(img)
            if img.mode in ("RGBA", "LA", "P"):
                img = img.convert("RGBA")
                buf = io.BytesIO()
                img.save(buf, "PNG")
                out_mime = "image/png"
            else:
                img = img.convert("RGB")
                buf = io.BytesIO()
                img.save(buf, "JPEG", quality=92, optimize=True)
                out_mime = "image/jpeg"
        buf.seek(0)
        return StreamingResponse(buf, media_type=out_mime,
                                 headers={"Cache-Control": "max-age=3600"})
    except Exception as exc:
        raise HTTPException(500, f"Cannot decode image: {exc}")


@app.get("/api/related/{photo_id}")
def related(photo_id: str, window: int | None = None):
    meta, by_id = _get_metadata()
    if meta is None:
        raise HTTPException(404, "No metadata")
    if window is None:
        window = CFG.get("related_window_seconds", 300)
    target = by_id.get(photo_id)
    if target is None:
        raise HTTPException(404, "Photo not found")

    if target["datetime_ts"] is None:
        return []

    ts = target["datetime_ts"]
    results = [
        t for t in meta["thumbnails"]
        if t["id"] != photo_id
        and t["datetime_ts"] is not None
        and abs(t["datetime_ts"] - ts) <= window
    ]
    results.sort(key=lambda t: abs(t["datetime_ts"] - ts))
    return results[:20]


# ---------------------------------------------------------------------------
# Serve frontend
# ---------------------------------------------------------------------------

class _RevalidatingStaticFiles(StaticFiles):
    """Makes browsers revalidate frontend files on every load (cheap 304 when
    unchanged) so an updated app.js is never masked by a heuristically cached copy."""

    async def get_response(self, path, scope):
        response = await super().get_response(path, scope)
        response.headers["Cache-Control"] = "no-cache"
        return response


app.mount("/", _RevalidatingStaticFiles(directory=str(_FRONTEND), html=True), name="frontend")
