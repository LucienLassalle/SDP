FROM node:24.21.0-alpine

WORKDIR /app

COPY package.json ./
RUN npm install

COPY . .

EXPOSE 3000
USER node
CMD ["node", "app.js"]
