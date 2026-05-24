"""Entry point — python run.py"""
import uvicorn
from backend.config import CFG

if __name__ == "__main__":
    uvicorn.run(
        "backend.main:app",
        host=CFG["host"],
        port=CFG["port"],
        reload=False,
    )
