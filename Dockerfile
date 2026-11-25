FROM node:22-alpine

LABEL org.opencontainers.image.title="DeepNav" \
      org.opencontainers.image.description="Self-hosted navigation page with ICMP latency checks and an admin console" \
      org.opencontainers.image.version="1.12.0" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.source="https://github.com/xiaoxiong996/deepnav"

ENV NODE_ENV=production \
    PORT=8090 \
    DATA_DIR=/data \
    TZ=Asia/Shanghai

WORKDIR /app

COPY --chown=node:node package.json server.js ./
COPY --chown=node:node lib ./lib
COPY --chown=node:node public ./public
COPY --chown=node:node scripts ./scripts

# iputils provides the `ping` binary used for server-side ICMP probing.
RUN apk add --no-cache iputils \
  && mkdir -p /data \
  && chown node:node /data

USER node

EXPOSE 8090
VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8090)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
