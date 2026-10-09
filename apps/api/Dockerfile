# syntax=docker/dockerfile:1
FROM node:22-slim AS build
RUN npm i -g pnpm@12.10.1
WORKDIR /repo
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @sc/api... build
RUN pnpm --filter @sc/api deploy --prod /out

FROM node:22-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /out .
USER node
CMD ["node", "dist/main.js"]
