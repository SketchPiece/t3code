# Build from the repository root: docker build -f infra/helm-relay/Dockerfile .
# The relay runs its TypeScript sources directly on Node 24, like the rest of
# the repo's Node entry points, so there is no build step.
FROM node:24-slim

ENV CI=true
RUN corepack enable
WORKDIR /repo

COPY . .
# Only the relay and the workspace packages it imports.
RUN corepack pnpm install --frozen-lockfile --ignore-scripts --filter "helm-relay..."

WORKDIR /repo/infra/helm-relay
ENV NODE_ENV=production
EXPOSE 8080
CMD ["node", "src/main.ts"]
