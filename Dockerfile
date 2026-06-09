# --- build stage: install deps + build SPA ---
FROM oven/bun:1 AS build
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY . .
RUN bun run build

# --- runtime: serve API + built SPA on one port ---
FROM oven/bun:1-slim
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=8787
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/server ./server
COPY --from=build /app/package.json ./
EXPOSE 8787
# Token is persisted to /app/server/.data — mount a volume to keep it across restarts.
CMD ["bun", "server/index.ts"]
