FROM python:3.12-slim

WORKDIR /app

# Rutas relativas al CONTEXTO de `docker build`:
# - Contexto web_monitor/ (recomendado si construyes solo): docker build -t x web_monitor
#   → por defecto REQUIREMENTS_PATH=requirements-docker.txt, APP_COPY=.
# - Contexto raíz del repo: docker build -f web_monitor/Dockerfile .  (o compose abajo)
#   → pasa --build-arg REQUIREMENTS_PATH=web_monitor/requirements-docker.txt --build-arg APP_COPY=web_monitor
ARG REQUIREMENTS_PATH=requirements-docker.txt
ARG APP_COPY=.
COPY ${REQUIREMENTS_PATH} /tmp/requirements-docker.txt
RUN pip install --no-cache-dir -r /tmp/requirements-docker.txt

COPY ${APP_COPY}/ /app/

RUN mkdir -p /app/recordings

EXPOSE 8080

# Puerto por defecto en varmon.conf; si el backend elige otro, ajusta HEALTHCHECK o desactívalo.
HEALTHCHECK --interval=30s --timeout=4s --start-period=15s --retries=3 \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8080/api/uptime', timeout=3)"

CMD ["python", "app.py"]
