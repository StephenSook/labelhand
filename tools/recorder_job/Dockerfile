FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PYTHONPATH=/app/tools

WORKDIR /app

COPY tools/recorder_job/requirements.txt /tmp/requirements.txt
RUN pip install --no-cache-dir --requirement /tmp/requirements.txt

COPY data/nws_points_cache.json /app/data/nws_points_cache.json
COPY tools/nws_recorder.py tools/season_export.py /app/tools/
COPY tools/recorder_job /app/tools/recorder_job

ENTRYPOINT ["python", "-m", "tools.recorder_job.run"]
