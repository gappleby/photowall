FROM python:3.13-slim

WORKDIR /app

# Install Python dependencies first (cached layer unless requirements.txt changes)
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy application code
COPY backend/ ./backend/
COPY frontend/ ./frontend/
COPY run.py .

# Bake in container-appropriate defaults.
# Override at runtime by mounting your own config: -v /host/config.json:/app/config.json
COPY config.docker.json ./config.json

# Non-root user; pre-create the default volume mount points so Docker can bind-mount them
RUN useradd -m -u 1000 photowall \
    && mkdir -p /photos /cache \
    && chown -R photowall:photowall /app /photos /cache

USER photowall

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://localhost:8000/api/status')" || exit 1

CMD ["python", "run.py"]
