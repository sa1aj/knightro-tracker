FROM python:3.12-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
WORKDIR /app
COPY backend/requirements.txt /app/backend/requirements.txt
RUN pip install --no-cache-dir -r backend/requirements.txt \
    && useradd --uid 10001 --create-home knightro \
    && mkdir -p /data && chown knightro:knightro /data
COPY backend /app/backend
COPY frontend /app/frontend
USER knightro
EXPOSE 8000
VOLUME ["/data"]
CMD ["python", "backend/server.py", "--bind", "0.0.0.0", "--port", "8000", "--database", "/data/knightro.db", "--events", "/data/events.json"]
