FROM node:18-alpine

WORKDIR /app

# Install only production dependencies for smaller image
COPY package.json package-lock.json* ./
RUN npm ci --only=production || npm install --only=production

COPY . .

ENV PORT 8080
EXPOSE 8080

CMD ["node","index.js"]
