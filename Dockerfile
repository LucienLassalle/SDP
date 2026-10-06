FROM node:26.10.0-alpine@sha256:0b36e8c136b94cd4fcf02188228e76c31ad5872eef3fec8cbd2eee500cfd9e80 AS deps

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

FROM node:26.10.0-alpine@sha256:0b36e8c136b94cd4fcf02188228e76c31ad5872eef3fec8cbd2eee500cfd9e80

# npm, npx, corepack et yarn ne servent qu'à l'installation
RUN rm -rf /usr/local/lib/node_modules /opt/yarn-* \
    /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
    /usr/local/bin/yarn /usr/local/bin/yarnpkg

WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY package.json app.js passwords.js ./
COPY views ./views
COPY public ./public

ENV NODE_ENV=production

EXPOSE 3443
USER node
# La page d'accueil interroge la base : l'application n'est saine que si MySQL répond aussi
# (certificat autosigné : pas de vérification pour cet appel local)
HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --retries=3 \
  CMD ["node", "-e", "require('https').get({host: '127.0.0.1', port: 3443, path: '/', rejectUnauthorized: false}, r => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"]
CMD ["node", "app.js"]
