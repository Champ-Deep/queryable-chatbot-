# Both agents in one image: Champions Group Agent (:9100) and Personal Agent (:9200).
# Used by the Cloudflare Container (see wrangler.jsonc); also runs anywhere Docker does:
#   docker build -t champions-a2a . && docker run -p 9100:9100 -p 9200:9200 champions-a2a
FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

WORKDIR /app
COPY requirements.txt .
RUN pip install -r requirements.txt

COPY common ./common
COPY champions ./champions
COPY personal ./personal
COPY scripts ./scripts
COPY deploy/run.sh ./deploy/run.sh

RUN useradd --create-home --uid 10001 app \
    && mkdir -p /app/data /app/reports \
    && chown -R app:app /app/data /app/reports
USER app

EXPOSE 9100 9200
CMD ["bash", "deploy/run.sh"]
