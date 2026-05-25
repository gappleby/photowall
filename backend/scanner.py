"""
Scans the photos directory, generates B&W thumbnails, and writes metadata.json.
Runs in a background thread so the API stays responsive during scanning.
"""
import hashlib
import json
import math
import threading
import time
from datetime import datetime
from pathlib import Path

from PIL import Image, ExifTags, ImageOps

try:
    import pillow_heif
    pillow_heif.register_heif_opener()
    _HEIF = True
except ImportError:
    _HEIF = False

_IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".gif", ".bmp", ".tiff", ".tif", ".webp"}
if _HEIF:
    _IMAGE_EXTENSIONS |= {".heic", ".heif"}

# Video extensions are never included — listed explicitly so future additions are obvious
_VIDEO_EXTENSIONS = {
    ".mp4", ".m4v", ".mov", ".avi", ".wmv", ".mkv", ".flv",
    ".webm", ".mpg", ".mpeg", ".3gp", ".ts", ".mts", ".m2ts",
}

EXTENSIONS = _IMAGE_EXTENSIONS - _VIDEO_EXTENSIONS

_state = {
    "status": "idle",   # idle | scanning | ready | error
    "progress": 0.0,
    "total": 0,
    "done": 0,
    "error": None,
}
_lock = threading.Lock()


def get_state() -> dict:
    with _lock:
        return dict(_state)


def _set(key, value):
    with _lock:
        _state[key] = value


def _photo_id(path: Path) -> str:
    return hashlib.sha1(str(path).encode()).hexdigest()[:16]


_EXIF_TAG_DATETIME_ORIGINAL = 36867  # DateTimeOriginal
_EXIF_TAG_DATETIME          = 306   # DateTime (fallback)


def _exif_datetime(img: Image.Image) -> datetime | None:
    try:
        exif = img.getexif()  # public API; works on JPEG, TIFF, PNG (where present)
        for tag_id in (_EXIF_TAG_DATETIME_ORIGINAL, _EXIF_TAG_DATETIME):
            raw = exif.get(tag_id)
            if raw:
                return datetime.strptime(raw.strip(), "%Y:%m:%d %H:%M:%S")
    except Exception:
        pass
    return None


def _make_thumb(src: Path, dst: Path, w: int, h: int):
    with Image.open(src) as img:
        # Extract datetime before any conversion (EXIF lives on the original object)
        dt = _exif_datetime(img)
        # Correct orientation — handles all 8 EXIF orientation values including flips
        img = ImageOps.exif_transpose(img)
        img = img.convert("RGB")
        # Cover-crop to exactly w×h — same behaviour as CSS object-fit:cover so the
        # B&W thumbnail and the colour overlay show the identical portion of the photo,
        # eliminating the visible jump at the start of the colour cross-fade.
        img = ImageOps.fit(img, (w, h), Image.LANCZOS)
        img.convert("L").save(dst, "JPEG", quality=75, optimize=True)
    return dt


def scan(photos_dir: Path, cache_dir: Path, thumb_w: int, thumb_h: int, cols: int):
    with _lock:
        if _state["status"] == "scanning":
            return
        _state.update({"status": "scanning", "progress": 0.0, "done": 0, "error": None})

    try:
        _run(photos_dir, cache_dir, thumb_w, thumb_h, cols)
    except Exception as exc:
        with _lock:
            _state.update({"status": "error", "error": str(exc)})


def _polaroid_dims(thumb_w: int, thumb_h: int) -> dict:
    """Compute polaroid frame and cell dimensions from thumb size."""
    frame_side   = max(4, round(thumb_w * 0.065))   # equal border: top, left, right
    frame_bottom = max(8, round(thumb_h * 0.26))    # larger bottom border (polaroid feel)
    gap          = max(8, round(thumb_w * 0.20))    # black gap between cells
    polaroid_w   = thumb_w + 2 * frame_side
    polaroid_h   = thumb_h + frame_side + frame_bottom
    cell_w       = polaroid_w + gap
    cell_h       = polaroid_h + gap
    return dict(
        frame_side=frame_side,
        frame_bottom=frame_bottom,
        gap=gap,
        polaroid_w=polaroid_w,
        polaroid_h=polaroid_h,
        cell_w=cell_w,
        cell_h=cell_h,
    )


def _run(photos_dir: Path, cache_dir: Path, thumb_w: int, thumb_h: int, cols: int):
    thumbs_dir = cache_dir / "thumbs"
    thumbs_dir.mkdir(exist_ok=True)

    dims = _polaroid_dims(thumb_w, thumb_h)
    cell_w = dims["cell_w"]
    cell_h = dims["cell_h"]

    # Cache datetimes from a previous scan so rescans don't reopen every source
    # file on disk — critical for large libraries on network shares (NAS).
    prior = load_metadata(cache_dir)
    cached_datetimes: dict[str, str | None] = {}
    if prior:
        for rec in prior.get("thumbnails", []):
            cached_datetimes[rec["id"]] = rec.get("datetime")

    photos = [
        p for p in sorted(photos_dir.rglob("*"))
        if p.suffix.lower() in EXTENSIONS and p.is_file()
    ]

    total = len(photos)
    _set("total", total)

    if total == 0:
        with _lock:
            _state.update({"status": "ready", "progress": 1.0})
        _write_metadata(cache_dir, [], cols, thumb_w, thumb_h, dims, photos_dir)
        return

    records = []

    for i, photo in enumerate(photos):
        photo_id = _photo_id(photo)
        thumb_path = thumbs_dir / f"{photo_id}.jpg"

        dt = None
        if not thumb_path.exists():
            # New photo — generate thumbnail (also returns EXIF datetime)
            try:
                dt = _make_thumb(photo, thumb_path, thumb_w, thumb_h)
            except Exception:
                with _lock:
                    _state["done"] = i + 1
                    _state["progress"] = (i + 1) / total
                continue
        elif photo_id in cached_datetimes:
            # Existing thumbnail with a known datetime — reuse it without
            # touching the source file (avoids thousands of network reads on NAS)
            raw = cached_datetimes[photo_id]
            try:
                dt = datetime.fromisoformat(raw) if raw else None
            except Exception:
                dt = None
        else:
            # Existing thumbnail but no cached datetime — read from source once
            try:
                with Image.open(photo) as img:
                    dt = _exif_datetime(img)
            except Exception:
                pass

        col = i % cols
        row = i // cols
        rel_path = photo.relative_to(photos_dir)
        folder = str(rel_path.parent) if rel_path.parent != Path(".") else ""

        records.append({
            "id": photo_id,
            "col": col,
            "row": row,
            # x,y = top-left of the polaroid frame within the world
            "x": col * cell_w,
            "y": row * cell_h,
            # w,h = polaroid frame size (visible area, excludes gap)
            "w": dims["polaroid_w"],
            "h": dims["polaroid_h"],
            "path": str(rel_path).replace("\\", "/"),
            "folder": folder,
            "datetime": dt.isoformat() if dt else None,
            "datetime_ts": int(dt.timestamp()) if dt else None,
        })

        with _lock:
            _state["done"] = i + 1
            _state["progress"] = (i + 1) / total

    # Remove thumbnails for photos that no longer exist on disk
    current_ids = {r["id"] for r in records}
    for thumb_file in thumbs_dir.glob("*.jpg"):
        if thumb_file.stem not in current_ids:
            try:
                thumb_file.unlink()
            except Exception:
                pass

    _write_metadata(cache_dir, records, cols, thumb_w, thumb_h, dims, photos_dir)
    with _lock:
        _state.update({"status": "ready", "progress": 1.0})


def _write_metadata(cache_dir, records, cols, thumb_w, thumb_h, dims, photos_dir):
    rows = math.ceil(len(records) / cols) if records else 0
    cell_w = dims["cell_w"]
    cell_h = dims["cell_h"]
    meta = {
        "generated_at": datetime.utcnow().isoformat(),
        "photos_dir": str(photos_dir),
        "board": {
            "cols": cols,
            "rows": rows,
            "thumb_w": thumb_w,
            "thumb_h": thumb_h,
            **dims,
            "total_width": cols * cell_w,
            "total_height": rows * cell_h,
            "count": len(records),
        },
        "thumbnails": records,
    }
    (cache_dir / "metadata.json").write_text(json.dumps(meta, indent=2))


def load_metadata(cache_dir: Path) -> dict | None:
    p = cache_dir / "metadata.json"
    if p.exists():
        return json.loads(p.read_text())
    return None
