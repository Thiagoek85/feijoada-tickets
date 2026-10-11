#!/usr/bin/env bash
# Script de gerenciamento do Vale Feijoada

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PID_FILE="$DIR/server.pid"
LOG_FILE="$DIR/server.log"
HTTP_PORT=3000
HTTPS_PORT=3443

start() {
  if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
    echo "⚠️  O servidor já está em execução (PID: $(cat "$PID_FILE"))."
    echo "🌐 HTTP: http://localhost:$HTTP_PORT"
    echo "🔒 HTTPS: https://localhost:$HTTPS_PORT"
    return 0
  fi

  echo "🚀 Iniciando Vale Feijoada..."
  cd "$DIR" || exit 1
  PORT=$HTTP_PORT HTTPS_PORT=$HTTPS_PORT nohup node server.js > "$LOG_FILE" 2>&1 &
  PID=$!
  echo $PID > "$PID_FILE"
  sleep 1

  if kill -0 "$PID" 2>/dev/null; then
    echo "✅ Servidor iniciado com sucesso! (PID: $PID)"
    echo "🌐 Acesso Local HTTP:  http://localhost:$HTTP_PORT"
    echo "🔒 Acesso Local HTTPS: https://localhost:$HTTPS_PORT (Libera Câmera no Celular)"
    IP=$(hostname -I 2>/dev/null | awk '{print $1}')
    if [ -n "$IP" ]; then
      echo "📱 Celular HTTP:  http://$IP:$HTTP_PORT"
      echo "📱 Celular HTTPS: https://$IP:$HTTPS_PORT (Recomendado para vídeo contínuo)"
    fi
  else
    echo "❌ Falha ao iniciar. Verifique o log: $LOG_FILE"
  fi
}

stop() {
  if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
    PID=$(cat "$PID_FILE")
    echo "🛑 Parando servidor (PID: $PID)..."
    kill "$PID" 2>/dev/null || true
    rm -f "$PID_FILE"
    echo "✅ Servidor finalizado."
  else
    echo "ℹ️  Encerrando processos residuais..."
  fi
  # Garante encerramento nas portas 3000 e 3443
  fuser -k $HTTP_PORT/tcp 2>/dev/null || true
  fuser -k $HTTPS_PORT/tcp 2>/dev/null || true
  rm -f "$PID_FILE"
}

status() {
  if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
    echo "🟢 Servidor ONLINE (PID: $(cat "$PID_FILE"))"
    echo "🌐 HTTP:  http://localhost:$HTTP_PORT"
    echo "🔒 HTTPS: https://localhost:$HTTPS_PORT"
  else
    echo "🔴 Servidor OFFLINE"
  fi
}

case "$1" in
  start)
    start
    ;;
  stop)
    stop
    ;;
  restart)
    stop
    sleep 1
    start
    ;;
  status)
    status
    ;;
  logs)
    tail -f "$LOG_FILE"
    ;;
  *)
    echo "Uso: $0 {start|stop|restart|status|logs}"
    exit 1
    ;;
esac
