# kondi-chat — minimal Alpine image for CI/non-interactive use.
# Build: docker build -t kondi-chat .
# Run:   docker run --rm -v "$PWD:/work" -w /work kondi-chat --prompt "review this"
FROM node:20-alpine

RUN apk add --no-cache git bash coreutils

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund || npm install --no-audit --no-fund

COPY src ./src
COPY tsconfig.json ./

# Non-interactive entrypoint runs the Node backend directly (no TUI).
ENTRYPOINT ["npx", "tsx", "src/cli/backend.ts"]
