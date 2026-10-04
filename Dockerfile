FROM python:3.12-slim

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app.py .
COPY templates ./templates
COPY static ./static

# SQLite 数据库与上传的扫描图保存在 /app/data(可挂载卷持久化)
ENV DATA_DIR=/app/data
RUN mkdir -p /app/data

EXPOSE 8000

CMD ["gunicorn", "-b", "0.0.0.0:8000", "--workers", "2", "app:app"]
