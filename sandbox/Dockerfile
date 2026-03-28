FROM denoland/deno:2.2.3

# Install common utilities
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    jq \
    ca-certificates \
    nodejs \
    npm \
    && npm install -g pnpm \
    && rm -rf /var/lib/apt/lists/*
# git is intentionally NOT installed in the container. Agents must use the
# git tool (/tools/bin/git -> /beige/tool-client) which runs on the gateway
# host where the SSH key lives. Installing system git leads agents to call
# /usr/bin/git directly, which has no credentials, hits dubious-ownership
# errors on host-owned repo files, and cannot resolve /workspace paths on
# the gateway.

# Create workspace directory
RUN mkdir -p /workspace /tools/bin /tools/packages /beige

# Copy tool-client source
COPY tool-client.ts /beige/tool-client.ts

# Create a wrapper script that runs tool-client via deno
# --allow-read: read the socket file path
# --allow-write: needed for some Deno versions with Unix sockets
# --allow-env: environment variables
# --unstable-net: Unix domain socket support (needed for some Deno 2.x builds)
RUN echo '#!/bin/sh' > /beige/tool-client && \
    echo 'exec deno run --allow-read --allow-write --allow-net --allow-env --unstable-net /beige/tool-client.ts "$@"' >> /beige/tool-client && \
    chmod +x /beige/tool-client

# Prepend /tools/bin to PATH so plugin tools shadow system binaries
ENV PATH="/tools/bin:/usr/local/bin:/usr/bin:/bin"

WORKDIR /workspace

# No CMD — container is started with "sleep infinity" by the gateway
