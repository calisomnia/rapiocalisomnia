# Usamos una imagen de Alpine Linux ligera, rápida y sin problemas de repositorios
FROM node:20-alpine

# Instalar Python, ffmpeg y herramientas en Alpine
RUN apk update && apk add --no-cache \
    python3 \
    py3-pip \
    ffmpeg \
    curl \
    ca-certificates

# Instalar la última versión del binario de yt-dlp
RUN curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp \
    && chmod a+rx /usr/local/bin/yt-dlp

# Crear directorio de trabajo
WORKDIR /app

# Copiar archivos del proyecto
COPY package*.json ./
RUN npm install --omit=dev

COPY server.js ./

# Puerto para Render
ENV PORT=10000
EXPOSE 10000

CMD ["node", "server.js"]
