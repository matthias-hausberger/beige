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

# Copy tool-client source (will be compiled at build time)
COPY tool-client.ts /beige/tool-client.ts

# Create a wrapper script that runs tool-client via deno
RUN echo '#!/bin/sh' > /beige/tool-client && \
    echo 'exec deno run --allow-net --allow-read --allow-env /beige/tool-client.ts "$@"' >> /beige/tool-client && \
    chmod +x /beige/tool-client

WORKDIR /workspace

# No CMD — container is started with "sleep infinity" by the gateway
