import json
import os
from pathlib import Path

_ROOT = Path(__file__).parent.parent

def load() -> dict:
    path = _ROOT / "config.json"
    with open(path) as f:
        cfg = json.load(f)
    cfg["photos_dir"] = Path(cfg["photos_dir"])
    cfg["cache_dir"] = Path(cfg["cache_dir"])
    cfg["cache_dir"].mkdir(parents=True, exist_ok=True)
    (cfg["cache_dir"] / "thumbs").mkdir(exist_ok=True)
    return cfg

CFG = load()
