FROM node:20-alpine AS builder
WORKDIR /app
# Install git and docker CLI for worker operations
RUN apk add --no-cache git docker-cli
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:20-alpine
WORKDIR /app
RUN apk add --no-cache git docker-cli
COPY package*.json ./
RUN npm ci --only=production
COPY --from=builder /app/dist ./dist
CMD ["node", "dist/worker.js"]
