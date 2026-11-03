FROM python:3.13-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
WORKDIR /srv/fieldlist
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt \
    && python -m playwright install --with-deps chromium
COPY app ./app
RUN useradd --create-home fieldlist \
    && mkdir -p /srv/fieldlist/data \
    && chown -R fieldlist:fieldlist /srv/fieldlist \
    && mkdir -p /home/fieldlist/.cache \
    && cp -a /root/.cache/ms-playwright /home/fieldlist/.cache/ \
    && chown -R fieldlist:fieldlist /home/fieldlist/.cache
USER fieldlist
ENV FIELDLIST_DB=/srv/fieldlist/data/fieldlist.db
EXPOSE 8000
CMD ["sh", "-c", "python -m uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-8000} --workers 1"]
