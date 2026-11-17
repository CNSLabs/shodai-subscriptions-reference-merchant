# The subscription SDK is not published to npm, so the image builds it from its public source at the pinned commit.
FROM node:22.23.4-alpine AS sdk

ARG SDK_COMMIT=2b2a7b560a34b47dd5361908d2328a0a958057cd

RUN apk add --no-cache git
WORKDIR /sdk
RUN git init -q . && \
  git remote add origin https://github.com/CNSLabs/agreements-api-sdk.git && \
  git fetch -q --depth 1 origin "$SDK_COMMIT" && \
  git checkout -q FETCH_HEAD
RUN npm --prefix packages/agreements-api-client install --ignore-scripts --no-package-lock && \
  npm --prefix packages/agreements-api-client run build && \
  npm pack ./packages/agreements-api-client --pack-destination /sdk --ignore-scripts && \
  mv /sdk/shodai-network-agreements-api-client-*.tgz /sdk/agreements-api-client.tgz

FROM node:22.23.4-alpine

# Hosted MongoDB-compatible databases such as Amazon DocumentDB present certificates from the RDS CA.
RUN apk add --no-cache ca-certificates curl && \
  curl -fsSL https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem -o /etc/ssl/certs/rds-combined-ca-bundle.pem

WORKDIR /app
COPY package.json ./
COPY --from=sdk /sdk/agreements-api-client.tgz /tmp/agreements-api-client.tgz
RUN npm install --no-save --package-lock=false --ignore-scripts /tmp/agreements-api-client.tgz && \
  rm /tmp/agreements-api-client.tgz
COPY tsconfig.json ./
COPY src ./src
COPY public ./public

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=8787
ENV NODE_EXTRA_CA_CERTS=/etc/ssl/certs/rds-combined-ca-bundle.pem

USER node
EXPOSE 8787
CMD ["node", "--import", "tsx", "src/server.ts"]
