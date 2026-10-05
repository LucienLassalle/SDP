FROM node:24.21.0-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

COPY app.js ./

EXPOSE 3000
USER node
CMD ["node", "app.js"]
