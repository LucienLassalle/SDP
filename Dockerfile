FROM node:10.15.0

WORKDIR /app

COPY package.json ./
RUN npm install

COPY . .

EXPOSE 3000
USER node
CMD ["node", "app.js"]
