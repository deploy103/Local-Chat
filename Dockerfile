FROM node:24-alpine
ENV NODE_ENV=production PORT=8005
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --chown=node:node server.js ./
COPY --chown=node:node public ./public
RUN mkdir -p /app/data /app/uploads && chown -R node:node /app
USER node
EXPOSE 8005
CMD ["node", "server.js"]
