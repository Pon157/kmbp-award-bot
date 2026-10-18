FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund
COPY . .
ENV NODE_ENV=production DB_PATH=/data/bot.sqlite
VOLUME /data
EXPOSE 3000
CMD ["node", "--no-warnings", "--import", "./server/register.mjs", "server/index.mjs"]
