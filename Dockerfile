FROM node:20-alpine
WORKDIR /app
COPY package.json ./
COPY server.js pos.js index.html ./
ENV NODE_ENV=production
EXPOSE 3000
CMD ["node", "server.js"]
