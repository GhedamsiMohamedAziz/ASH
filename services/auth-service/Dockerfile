# auth-service — instructions.md §5, §8.1, §13.4
FROM python:3.12-slim

WORKDIR /app
ENV PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1

COPY pyproject.toml ./
RUN pip install --upgrade pip && pip install \
    "fastapi>=0.110" "uvicorn[standard]>=0.29" "pydantic>=2.6" "cryptography>=42"

COPY app ./app

# Dev signing keys are generated at runtime under /app/keys (gitignored, never baked in).
EXPOSE 8091
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8091"]
