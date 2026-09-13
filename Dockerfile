FROM node:22-bookworm

WORKDIR /app

# ---------------------------------------------------------------------------
# Frontend build-time configuration
#
# Vite inlines `VITE_*` into the bundle during `vite build`, so these must be
# present at IMAGE BUILD time -- injecting them at `docker run` is too late and
# silently produces a bundle with the values missing. Pass them with --build-arg.
#
# Nothing here is a secret: every VITE_* value ships to the browser by design.
# They are ARG rather than ENV so they are not baked into the final image.
# ---------------------------------------------------------------------------
ARG VITE_SSO_URL=""
ARG VITE_SSO_CLIENT_ID=""
ARG VITE_IAM_ENABLED="true"
ARG VITE_ENABLE_MOCK_FALLBACK="false"

# ---------------------------------------------------------------------------
# Image-level defaults: environment-independent tuning and paths only.
#
# Credentials, database URLs, SSO client config, Azure endpoints and admin user
# IDs are deliberately NOT set here -- supply them at runtime via `--env-file`
# or your platform's secret store. See .env.example for the full list.
# ---------------------------------------------------------------------------
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:/opt/markitdown/bin:$PATH \
    APP_DATA_ROOT=/app/data \
    ONTOLOGY_ENABLE_CLAUDE=true \
    ONTOLOGY_PROXY_PROVIDER=azure \
    ONTOLOGY_PROXY_MODEL=gpt-5.4 \
    AZURE_OPENAI_CONNECT_TIMEOUT_MS=90000 \
    ONTOLOGY_WORKSPACE_ROOT=data/ontology-workspaces \
    ONTOLOGY_INITIAL_WIKI_SOURCE=server/templates/knowledge-base \
    ONTOLOGY_IAM_ENABLED=true \
    ONTOLOGY_CLAUDE_INHERIT_LOCAL_AUTH=false \
    CLAUDE_SESSION_STORE=postgres \
    MARKITDOWN_PYTHON=/opt/markitdown/bin/python \
    MARKITDOWN_ALLOW_LLM_IN_MARKITDOWN=false \
    MARKITDOWN_PDF_TEXT_FIRST=true \
    MARKITDOWN_PDF_TEXT_COMMAND=pdftotext \
    DOCUMENT_CONVERSION_TIMEOUT=240s \
    MARKITDOWN_TIMEOUT_MS=240000 \
    PDF_MAX_PAGES=500 \
    PDF_MAX_BYTES=104857600 \
    PRESENTATION_MAX_SLIDES=60 \
    PRESENTATION_MAX_BYTES=209715200 \
    WORD_MAX_BYTES=104857600 \
    VISION_EXTRACTION_ENABLED=true \
    VISION_EXTRACTION_PROVIDER=azure \
    VISION_EXTRACTION_MODEL=gpt-5.3-codex \
    VISION_EXTRACTION_CONCURRENCY=4 \
    VISION_EXTRACTION_MAX_NORMALIZED_IMAGE_BYTES_PER_FILE=125829120 \
    VISION_EXTRACTION_FOR_STANDALONE_IMAGES=true \
    VISION_EXTRACTION_FOR_PDF_PAGES=true \
    VISION_EXTRACTION_PDF_MIN_REGION_AREA_RATIO=0.1 \
    VISION_EXTRACTION_PDF_FULL_PAGE_TEXT_MAX_CHARS=160 \
    VISION_EXTRACTION_PDF_BACKGROUND_MAX_BYTES=20000 \
    VISION_EXTRACTION_FOR_OFFICE_IMAGES=true \
    JSON_BODY_LIMIT=90mb \
    MARKITDOWN_ZIP_MAX_ENTRIES=10000 \
    MARKITDOWN_ZIP_MAX_TOTAL_BYTES=536870912

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    git \
    ca-certificates \
    python3 \
    python3-venv \
    python3-pip \
    poppler-utils \
  && rm -rf /var/lib/apt/lists/*

RUN python3 -m venv /opt/markitdown \
  && /opt/markitdown/bin/python -m pip install --upgrade pip \
  && /opt/markitdown/bin/python -m pip install "markitdown[all]" PyMuPDF Pillow PyYAML

COPY package.json pnpm-lock.yaml ./
RUN corepack enable \
  && pnpm install

COPY . .
ENV NODE_ENV=production
# Bundle the frontend at image build time; production must not run the Vite dev server.
# (Deliberately skips the `tsc` gate in `pnpm build` -- typecheck belongs in CI, not deploy.)
RUN pnpm exec vite build
RUN mkdir -p /app/data

EXPOSE 8787 8888

# start:frontend serves dist/ on 8888 (gzip + immutable cache + /api proxy, drop-in for the old Vite port).
# start:server runs the API without the dev watcher.
CMD ["sh", "-c", "pnpm start:frontend & pnpm start:server"]
