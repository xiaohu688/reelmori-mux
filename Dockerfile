FROM node:22-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg curl ca-certificates \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY server.mjs package.json* ./
ENV PORT=8080
EXPOSE 8080
CMD ["node", "server.mjs"]
