# Escritório Adaptus (versão hospedada). Build a partir da raiz do repositório.
FROM node:22-slim
WORKDIR /app
COPY . .
RUN npm ci --include=dev --ignore-scripts --no-audit --no-fund \
 && node esbuild.js \
 && cd webview-ui && npm run build
ENV NODE_ENV=production DATA_DIR=/data
EXPOSE 8080
CMD ["node", "hosted/gateway.js"]
