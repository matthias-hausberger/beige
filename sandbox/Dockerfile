FROM denoland/deno:2.2.3

# Install common utilities
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    jq \
    git \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

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

WORKDIR /workspace

# No CMD — container is started with "sleep infinity" by the gateway
