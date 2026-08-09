# Node 24 is the floor: lib/db.ts uses node:sqlite, which only stopped needing
# --experimental-sqlite there. Alpine is safe because every dependency in this
# project is pure JavaScript — nothing compiles against glibc.
FROM node:24-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM node:24-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

FROM node:24-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
# Bind to every interface: the default localhost binding is unreachable from
# outside the container.
ENV HOSTNAME=0.0.0.0

# su-exec lets the entrypoint fix volume ownership as root and then drop back
# down to an unprivileged user for the server itself.
RUN apk add --no-cache su-exec

# output: "standalone" emits a server plus only the node_modules it traced.
# public/ and .next/static are deliberately not part of it, so copy them in.
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public

COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

EXPOSE 3000
ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "server.js"]
