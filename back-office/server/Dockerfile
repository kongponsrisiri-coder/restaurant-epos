# Dockerfile for the SiamEPOS Back Office API.
# Used in preference to Railpack/Nixpacks auto-detection because those
# scan source for process.env.X references and try to wire them up as
# BuildKit secret mounts at build time — fine for Next.js, wrong for
# this server (JWT_SECRET et al. are runtime-only). With this Dockerfile
# Railway's builder skips that scan entirely.

FROM node:20-alpine

# Build-time tools needed for bcrypt's native compile step (only matters
# if Alpine's musl can't find a prebuilt — usually it can).
RUN apk add --no-cache python3 make g++ libc6-compat

WORKDIR /app

# Copy manifest first so npm ci stays cached across code changes
COPY package*.json ./
RUN npm ci --omit=dev

# Now the rest of the server
COPY . .

# The port Railway maps to.
ENV PORT=3002
EXPOSE 3002

CMD ["npm", "start"]
