import io
import mimetypes
import threading
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from PIL import Image, ImageOps

from . import scanner
from .config import CFG

app = FastAPI(title="Photowall API")

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
        "fade_ms":      CFG.get("fade_ms",      2000),
        "dwell_ms":     CFG.get("dwell_ms",     4000),
        "show_caption": CFG.get("show_caption", True),
    }


# ---------------------------------------------------------------------------
# Scan endpoints
# ---------------------------------------------------------------------------

@app.get("/api/status")
def status():
    state = scanner.get_state()
    meta = scanner.load_metadata(CFG["cache_dir"])
    state["has_metadata"] = meta is not None
    return state


@app.post("/api/scan")
def start_scan():
    t = threading.Thread(
        target=scanner.scan,
        args=(
            CFG["photos_dir"],
            CFG["cache_dir"],
            CFG["thumb_width"],
            CFG["thumb_height"],
            CFG["board_cols"],
        ),
        daemon=True,
    )
    t.start()
    return {"started": True}


@app.get("/api/metadata")
def metadata():
    meta = scanner.load_metadata(CFG["cache_dir"])
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
    meta = scanner.load_metadata(CFG["cache_dir"])
    if meta is None:
        raise HTTPException(404, "No metadata")
    record = next((t for t in meta["thumbnails"] if t["id"] == photo_id), None)
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
def related(photo_id: str, window: int = 300):
    meta = scanner.load_metadata(CFG["cache_dir"])
    if meta is None:
        raise HTTPException(404, "No metadata")
    target = next((t for t in meta["thumbnails"] if t["id"] == photo_id), None)
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

app.mount("/", StaticFiles(directory=str(_FRONTEND), html=True), name="frontend")
