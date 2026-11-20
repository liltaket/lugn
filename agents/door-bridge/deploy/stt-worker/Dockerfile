# Speech-to-text worker for the door bridge, with NVIDIA GPU support.
# Build from agents/door-bridge: docker build -f deploy/stt-worker/Dockerfile .
FROM python:3.12-slim

ENV PIP_NO_CACHE_DIR=1 PIP_DISABLE_PIP_VERSION_CHECK=1 PYTHONUNBUFFERED=1
COPY stt_worker/requirements.txt stt_worker/requirements-cuda.txt /tmp/
RUN pip install -r /tmp/requirements.txt -r /tmp/requirements-cuda.txt
# CTranslate2 loads cuBLAS and cuDNN from the pip wheels.
ENV LD_LIBRARY_PATH=/usr/local/lib/python3.12/site-packages/nvidia/cublas/lib:/usr/local/lib/python3.12/site-packages/nvidia/cudnn/lib

RUN useradd --system --uid 10001 --create-home stt && mkdir /models && chown stt /models
COPY stt_worker /app/stt_worker
WORKDIR /app
USER stt
EXPOSE 8790
HEALTHCHECK --interval=30s --timeout=5s --start-period=180s --retries=3 \
  CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8790/health', timeout=4).status == 200 else 1)"
ENTRYPOINT ["python", "-m", "stt_worker", "--host", "0.0.0.0", "--port", "8790", "--download-root", "/models"]
