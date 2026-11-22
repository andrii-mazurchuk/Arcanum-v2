# Frozen production install on the pinned Bun (S-241). The build fails if the image's Bun differs
# from package.json's engines.bun. No credential or setting is baked in: settings arrive through
# the container's environment (see compose.yaml).
FROM oven/bun:1.3.14
WORKDIR /app
COPY package.json bun.lock tsconfig.json ./
RUN bun install --frozen-lockfile --production
COPY src ./src
RUN bun run check:bun
VOLUME /data
EXPOSE 8080
CMD ["bun", "src/app/bin.ts", "service"]
