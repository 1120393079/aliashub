FROM python:3.12-slim-bookworm

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PICKUP_HOST=0.0.0.0 \
    PICKUP_PORT=4190 \
    PICKUP_DATABASE_PATH=/app/data/mail-pickup.db \
    LDXP_PLAYWRIGHT_PROFILE_DIR=/app/data/ldxp-browser

WORKDIR /app

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt \
    && python -m playwright install --with-deps chromium

COPY app.py ./
COPY static ./static

RUN mkdir -p /app/data

EXPOSE 4190
HEALTHCHECK --interval=15s --timeout=5s --start-period=15s --retries=4 \
  CMD ["python", "-c", "import urllib.request; urllib.request.urlopen('http://127.0.0.1:4190/health', timeout=3).read()"]

CMD ["python", "app.py"]
