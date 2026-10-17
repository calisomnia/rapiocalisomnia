# Usamos una imagen oficial de Node.js ligera basada en Debian/Ubuntu
FROM node:20-bullseye-slim

# Instalar Python, ffmpeg y herramientas necesarias para yt-dlp
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    python3-pip \
    ffmpeg \
    curl \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Instalar la última versión de yt-dlp directamente
RUN curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp \
    && chmod a+rx /usr/local/bin/yt-dlp

# Crear directorio de trabajo
WORKDIR /app

# Copiar archivos de dependencias
COPY package*.json ./

# Instalar dependencias de producción
RUN npm install --omit=dev

# Copiar el código del servidor
COPY server.js ./

# Variable de entorno para el puerto de Render
ENV PORT=10000
EXPOSE 10000

# Iniciar servidor
CMD ["node", "server.js"]
