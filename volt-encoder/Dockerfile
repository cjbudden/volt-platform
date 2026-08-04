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

WORKDIR /app
COPY bin/ /app/bin/
RUN chmod +x /app/bin/*.sh

# tini reaps the FFmpeg/Shaka/uploader children cleanly on stop.
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["python3", "/app/bin/encoder.py"]
