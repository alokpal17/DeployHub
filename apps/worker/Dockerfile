FROM node:20-alpine AS builder
WORKDIR /app
RUN apk add --no-cache git docker-cli
COPY package.json package-lock.json ./
COPY packages ./packages
COPY apps/worker ./apps/worker
RUN npm ci
RUN npm run build --workspace=@deployhub/worker

FROM node:20-alpine
WORKDIR /app
RUN apk add --no-cache git docker-cli
ENV NODE_ENV=production
COPY package.json package-lock.json ./
COPY packages ./packages
COPY apps/worker/package.json ./apps/worker/
RUN npm ci --omit=dev
COPY --from=builder /app/apps/worker/dist ./apps/worker/dist
WORKDIR /app/apps/worker
CMD ["node", "dist/worker.js"]

