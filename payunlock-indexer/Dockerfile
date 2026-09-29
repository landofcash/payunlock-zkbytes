FROM node:24-bookworm-slim
RUN npm install --global pnpm@11.27.0
WORKDIR /workspace
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY payunlock-indexer/package.json payunlock-indexer/package.json
COPY payunlock-backend/package.json payunlock-backend/package.json
COPY payunlock-frontend/package.json payunlock-frontend/package.json
COPY payunlock-contract/package.json payunlock-contract/package.json
COPY packages/api-contracts/package.json packages/api-contracts/package.json
RUN pnpm install --frozen-lockfile --filter @payunlock/indexer...
COPY tsconfig.base.json ./
COPY payunlock-contract/abi/ ./payunlock-contract/abi/
COPY payunlock-indexer/ ./payunlock-indexer/
WORKDIR /workspace/payunlock-indexer
RUN node node_modules/envio/bin.mjs codegen
CMD ["node", "node_modules/envio/bin.mjs", "start"]
