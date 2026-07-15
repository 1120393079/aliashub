FROM python:3.11-slim

ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1
ENV PIP_NO_CACHE_DIR=1

WORKDIR /app

COPY requirements.txt /app/requirements.txt
COPY customer_portal_api/requirements.txt /app/customer_portal_api/requirements.txt
RUN pip install -r /app/customer_portal_api/requirements.txt

COPY . /app

EXPOSE 8100

CMD ["python", "-m", "uvicorn", "customer_portal_api.main:app", "--host", "0.0.0.0", "--port", "8100"]
