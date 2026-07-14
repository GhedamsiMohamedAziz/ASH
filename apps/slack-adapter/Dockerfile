# slack-adapter — instructions.md §7.2
FROM node:22-slim
WORKDIR /app
COPY package.json ./
COPY src ./src
EXPOSE 8085
CMD ["node", "src/server.ts"]
