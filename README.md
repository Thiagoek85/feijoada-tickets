# 🍲 Vale Feijoada Comunitária no Japão - Sistema de Tickets Digitais & Logística

Sistema completo desenvolvido para controle de vendas, emissão de vales com **QR Code individual**, validação na entrega via câmera de smartphone e telemetria da cozinha em tempo real.

Configurado nativamente para a comunidade no Japão (moeda em **Ienes ¥**, pagamentos via PayPay, Dinheiro e Transferência Bancária Yucho).

---

## 🚀 Como Executar

No diretório do projeto (`/home/thiagoek85/projetos/feijoada-tickets`):

```bash
# Iniciar o servidor
./manage.sh start

# Verificar status
./manage.sh status

# Parar o servidor
./manage.sh stop

# Ver logs em tempo real
./manage.sh logs
```

---

## 📱 Como Acessar no Computador e Smartphones

O sistema roda com suporte duplo a **HTTP** e **HTTPS** simultâneos:

1. **Acesso pelo PC / Homelab:**
   - [http://localhost:3000](http://localhost:3000) ou [https://localhost:3443](https://localhost:3443)
2. **Acesso pelos Celulares dos Voluntários (Wi-Fi ou Tailscale):**
   - **HTTPS Seguro (Recomendado para Câmera Contínua):** `https://<IP-DO-HOMELAB>:3443`
     *(Ex: `https://100.101.32.70:3443` ou `https://10.171.148.132:3443`)*
   - **HTTP Comum:** `http://<IP-DO-HOMELAB>:3000`
     *(Ex: `http://100.101.32.70:3000`)*

---

## 📷 Como Funciona o Acesso à Câmera para Leitura do QR Code

Navegadores móveis (Safari no iOS e Chrome no Android) possuem diretrizes rígidas de segurança para acesso à câmera através de URLs de rede. O sistema conta com **duas soluções automáticas integradas**:

### 1. Botão "📸 Tirar Foto / Ler QR" (Compatibilidade Universal 100%)
- **Funciona em qualquer URL (HTTP ou HTTPS)** em qualquer celular (iPhone ou Android).
- Ao tocar no botão, o app aciona diretamente a câmera fotográfica nativa do aparelho.
- O voluntário tira a foto do QR Code e a decodificação acontece imediatamente.
- Também possui o botão **"📁 Galeria"** para ler capturas de tela enviadas pelo WhatsApp.

### 2. Modo Vídeo Contínuo ao Vivo (HTTPS)
- Ao acessar via **HTTPS** (`https://<IP>:3443`), o navegador libera o streaming de vídeo em tempo real da câmera traseira, permitindo ler os QR Codes continuamente apenas apontando o aparelho.

---

## 💴 Precificação e Moeda Japonesa (Ienes)
- **Moeda:** Ienes Japoneses (`¥` / JPY).
- **Preço Unitário Padrão:** `¥ 1.500` por feijoada (editável nas configurações).
- **Formas de Pagamento Adaptadas:**
  - 💵 Dinheiro em Espécie (¥ Cash)
  - 📱 PayPay
  - 🏦 Transferência Bancária (Banco Yucho / SMBC)
  - 💳 Cartão de Crédito
  - 🇧🇷 PIX (para compradores que preferirem acertar em conta do Brasil)
- **WhatsApp Inteligente:** Identifica automaticamente números celulares japoneses iniciados em `090`, `080` ou `070` e formata o link internacional (`+81`).

---

## 📂 Links Úteis do Sistema
- **Painel Geral:** [http://localhost:3000](http://localhost:3000)
- **Exemplo de Vale Digital do Comprador:** [http://localhost:3000/ticket/FEIJ-1001](http://localhost:3000/ticket/FEIJ-1001)
- **Folha de Impressão A4 (Vales com Picote):** [http://localhost:3000/print-batch](http://localhost:3000/print-batch)
- **Exportação de Prestação de Contas:** [http://localhost:3000/api/export/csv](http://localhost:3000/api/export/csv)
