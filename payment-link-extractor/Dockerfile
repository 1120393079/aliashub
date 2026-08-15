FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    OPLL_WEB_HOST=0.0.0.0 \
    OPLL_WEB_PORT=18794 \
    OPLL_LOG_FILE=/app/data/payment-link.log

WORKDIR /app

COPY requirements.txt ./
RUN pip install --no-cache-dir --disable-pip-version-check -r requirements.txt

COPY payment_link_extractor ./payment_link_extractor
COPY iprocket_chain_bridge.py ./iprocket_chain_bridge.py

RUN mkdir -p /app/data \
    && chmod -R a+rX /app/payment_link_extractor /app/iprocket_chain_bridge.py

EXPOSE 18794

HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=4 \
  CMD ["python", "-c", "import os,socket,urllib.request; r=urllib.request.Request('http://127.0.0.1:18794/api/health', headers={'X-Workbench-Password': os.environ.get('OPLL_WEB_PASSWORD', '')}); urllib.request.urlopen(r, timeout=3).read(); socket.create_connection(('127.0.0.1', int(os.environ.get('IPROCKET_BRIDGE_PORT', '18796'))), 3).close()"]

CMD ["python", "-m", "payment_link_extractor.web"]
