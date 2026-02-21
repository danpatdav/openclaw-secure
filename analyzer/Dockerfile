FROM node:20-slim AS base

WORKDIR /app

COPY package.json ./
RUN npm install --production

COPY analyzer.mjs ./

# Create non-root user
RUN groupadd -r analyzer && useradd -r -g analyzer -d /app -s /sbin/nologin analyzer
RUN chown -R analyzer:analyzer /app

USER analyzer

CMD ["node", "analyzer.mjs"]
