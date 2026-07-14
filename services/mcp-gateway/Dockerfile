# mcp-gateway — instructions.md §13, ADR 001. Node runs .ts natively (type-strip).
FROM node:22-slim
WORKDIR /app
COPY package.json ./
COPY src ./src
# shared-ts is imported by relative path from the monorepo; copied at build in prod.
EXPOSE 8443
CMD ["node", "src/server.ts"]
