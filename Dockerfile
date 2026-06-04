FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY monitor.js ./

ENV STATE_DIR=/data

CMD ["node", "monitor.js"]
