FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY dist ./dist
RUN mkdir -p /app/data /app/temp && chown -R node:node /app/data /app/temp

USER node
EXPOSE 4000

CMD ["node", "dist/index.js"]
