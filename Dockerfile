# ── Stage 1: Build ──────────────────────────────────────────────
FROM node:22-alpine AS build

WORKDIR /app

# Copy workspace root package files first (better layer caching)
COPY package.json package-lock.json ./
COPY client/package.json client/
COPY server/package.json server/

# Install ALL dependencies (including devDependencies for build)
RUN npm ci

# Copy source code
COPY client/ client/
COPY server/ server/

# Build client (Vite)
RUN npm run build --workspace=client

# Build server (TypeScript → JavaScript)
RUN npm run build --workspace=server

# ── Stage 2: Production ────────────────────────────────────────
FROM node:22-alpine AS production

WORKDIR /app

# Copy workspace root package files
COPY package.json package-lock.json ./
COPY server/package.json server/

# Install production dependencies only
RUN npm ci --workspace=server --omit=dev

# Copy built server
COPY --from=build /app/server/dist/ server/dist/

# Copy built client into server's static directory
COPY --from=build /app/client/dist/ client-dist/

# Copy public assets (component library definitions etc.)
COPY --from=build /app/client/public/ client-dist/

# Create data directory for project persistence
RUN mkdir -p data/projects

ENV NODE_ENV=production
ENV PORT=3001

EXPOSE 3001

# Start the server
CMD ["node", "server/dist/index.js"]
