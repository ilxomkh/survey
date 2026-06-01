FROM node:20-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM node:20-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
ARG BUILD_DATE
COPY . .
RUN npm install @next/swc-linux-x64-musl --no-save && npm run build

FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ARG BUILD_DATE=unknown
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public
RUN echo "$BUILD_DATE" > /app/public/build_id.txt
EXPOSE 3000
CMD ["node", "server.js"]
