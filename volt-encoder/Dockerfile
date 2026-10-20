# Volt Encoder / Packager
# One container == one channel/event (all its renditions, kept in sync).
# Two workflows selected by the job config:
#   package_only  -> client sends a full pre-encoded ABR ladder; we only package (CPU, cheap)
#   transcode     -> client sends one mezzanine; we build the ladder with FFmpeg (GPU node)
#
# Base carries FFmpeg (ingest/relay + optional transcode) and Shaka Packager
# (CMAF single-file segments -> HLS + DASH, cbcs DRM via raw keys from SPEKE).

FROM ubuntu:22.04

ARG SHAKA_VERSION=v3.2.0
ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONUNBUFFERED=1 \
    JOB_CONFIG=/job/config.json \
    WORK_DIR=/work

# ffmpeg for ingest + transcode, python3 for the orchestrator + SPEKE client,
# awscli for the S3 uploader sidecar, curl/ca-certs for SPEKE POSTs.
RUN apt-get update && apt-get install -y --no-install-recommends \
        ffmpeg \
        python3 python3-pip \
        awscli \
        curl ca-certificates tini \
    && rm -rf /var/lib/apt/lists/*

# Shaka Packager (static binary from the official release).
RUN curl -fsSL -o /usr/local/bin/packager \
      "https://github.com/shaka-project/shaka-packager/releases/download/${SHAKA_VERSION}/packager-linux-x64" \
    && chmod +x /usr/local/bin/packager \
    && /usr/local/bin/packager --version

# LIVE CAPTIONS ON CPU (optional, 20 Oct 2026). With CAPTIONS_CPU=true the image
# carries faster-whisper (CTranslate2, int8) and the tiny and base models, so a
# channel with whisper tiny/base captions transcribes inside this task on CPU
# (no GPU add-on task). CAPTIONS_MT=true adds NLLB-200 on CPU (torch CPU build)
# for targets other than English. Tell the control plane with
# CAPTIONS_CPU_IN_ENCODER=true. Off by default: the base image stays lean.
#   docker build --build-arg CAPTIONS_CPU=true [--build-arg CAPTIONS_MT=true] .
ARG CAPTIONS_CPU=false
ARG CAPTIONS_MT=false
ENV HF_HOME=/models/hf WHISPER_DEVICE=cpu WHISPER_COMPUTE=int8
RUN if [ "$CAPTIONS_CPU" = "true" ]; then \
      pip3 install --no-cache-dir faster-whisper==1.0.3 requests \
      && python3 -c "from faster_whisper import WhisperModel as W; [W(m, device='cpu', compute_type='int8') for m in ('tiny', 'base')]"; \
    fi \
 && if [ "$CAPTIONS_MT" = "true" ]; then \
      pip3 install --no-cache-dir torch --index-url https://download.pytorch.org/whl/cpu \
      && pip3 install --no-cache-dir transformers==4.44.2 sentencepiece==0.2.0 \
      && python3 -c "from transformers import AutoTokenizer, AutoModelForSeq2SeqLM as M; n='facebook/nllb-200-distilled-600M'; AutoTokenizer.from_pretrained(n); M.from_pretrained(n)"; \
    fi

WORKDIR /app
COPY bin/ /app/bin/
RUN chmod +x /app/bin/*.sh

# tini reaps the FFmpeg/Shaka/uploader children cleanly on stop.
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["python3", "/app/bin/encoder.py"]
