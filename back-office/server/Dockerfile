# Dockerfile for the SiamEPOS Back Office API.
# Used in preference to Railpack/Nixpacks auto-detection because those
# scan source for process.env.X references and try to wire them up as
# BuildKit secret mounts at build time — fine for Next.js, wrong for
# this server (JWT_SECRET et al. are runtime-only). With this Dockerfile
# Railway's builder skips that scan entirely.

FROM node:20-alpine

# Pure-JS deps — bcryptjs replaces bcrypt so no native compile required.
# Keeping libc6-compat just in case any future dep wants glibc-style libs.
RUN apk add --no-cache libc6-compat

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
