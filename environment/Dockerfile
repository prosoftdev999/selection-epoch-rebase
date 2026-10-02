FROM node:22.16.0-bookworm-slim

WORKDIR /app
COPY build_audit.mjs /app/build_audit.mjs
COPY reproduce.mjs /app/reproduce.mjs
COPY data/ /app/data/

RUN chmod 755 /app/build_audit.mjs /app/reproduce.mjs
CMD ["bash"]
