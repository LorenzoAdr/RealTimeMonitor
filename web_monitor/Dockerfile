FROM python:3.12-slim

WORKDIR /app

COPY requirements-docker.txt .
RUN pip install --no-cache-dir -r requirements-docker.txt

COPY . .

RUN mkdir -p /app/recordings

EXPOSE 8080

# Puerto por defecto en varmon.conf; si el backend elige otro, ajusta HEALTHCHECK o desactívalo.
HEALTHCHECK --interval=30s --timeout=4s --start-period=15s --retries=3 \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8080/api/uptime', timeout=3)"

CMD ["python", "app.py"]
