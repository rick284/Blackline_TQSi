# One container: the API and the built web app together. It needs a Postgres database (DATABASE_URL); see docs/HOSTING.md.
#   docker build -t blackline .
#   docker run -p 3000:3000 -e NODE_ENV=production -e DATABASE_URL=postgres://... blackline
FROM node:22-bookworm-slim

WORKDIR /app
ENV NODE_ENV=development

# dependencies first, so a code change doesn't reinstall them
COPY package.json package-lock.json ./
COPY packages/engine/package.json packages/engine/
COPY packages/checkout/package.json packages/checkout/
COPY packages/tender/package.json packages/tender/
COPY packages/server/package.json packages/server/
COPY packages/web/package.json packages/web/
RUN npm ci

COPY . .
RUN npm run build -w @blackline/web

ENV NODE_ENV=production \
    PORT=3000 \
    TRUST_PROXY=1
EXPOSE 3000

# the host's "is it up" check: the server answers /health only when the database answers
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"

# run as an ordinary user, not root (the tools write small caches next to the code)
RUN chown -R node:node /app
USER node
CMD ["npm", "start", "-w", "@blackline/server"]
