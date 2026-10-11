# Imagem base Node.js 22 LTS
FROM node:22-slim

# Instala ferramentas essenciais para compilação nativa se necessário
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    make \
    g++ \
    openssl \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Diretório de trabalho da aplicação
WORKDIR /app

# Copia manifestos de dependências
COPY package*.json ./

# Instala dependências em modo produção
RUN npm install --omit=dev

# Copia código-fonte da aplicação
COPY . .

# Garante permissões adequadas
RUN chmod +x manage.sh 2>/dev/null || true

# Cria pastas de dados e certificados se não existirem
RUN mkdir -p /app/data /app/certs

# Expõe portas HTTP e HTTPS
EXPOSE 3000 3443

# Healthcheck do container
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD curl -f http://localhost:3000/api/config || exit 1

# Comando de inicialização
CMD ["node", "server.js"]
