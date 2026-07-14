# llm-proxy — instructions.md §9.5, §26
FROM python:3.12-slim
WORKDIR /app
ENV PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1
COPY pyproject.toml ./
RUN pip install --upgrade pip && pip install "fastapi>=0.110" "uvicorn[standard]>=0.29" "pydantic>=2.6" "pyyaml>=6"
COPY app ./app
COPY config.yaml ./
EXPOSE 8000
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
