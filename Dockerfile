FROM node:22-alpine

ENV NODE_ENV=production \
    PORT=3000 \
    TEAMS_FILE=/data/teams.json

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --chown=node:node server.js ./
COPY --chown=node:node public ./public
COPY --chown=node:node teams.json /data/teams.json
RUN chown -R node:node /data

USER node

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["npm", "start"]