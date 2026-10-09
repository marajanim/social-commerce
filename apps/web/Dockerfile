# syntax=docker/dockerfile:1
FROM node:22-slim AS build
RUN npm i -g pnpm@12.10.1
WORKDIR /repo
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @sc/web build

FROM node:22-slim
ENV NODE_ENV=production PORT=3000 HOSTNAME=0.0.0.0
WORKDIR /app
# Next standalone output keeps the monorepo path layout.
COPY --from=build /repo/apps/web/.next/standalone ./
COPY --from=build /repo/apps/web/.next/static ./apps/web/.next/static
USER node
CMD ["node", "apps/web/server.js"]
