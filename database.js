const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const dbPath = path.join(dataDir, 'tickets.db');
const db = new Database(dbPath);

// Configuração para alta performance e integridade
db.pragma('journal_mode = WAL');

// Inicialização das tabelas
db.exec(`
  CREATE TABLE IF NOT EXISTS config (
    key TEXT PRIMARY KEY,
    value TEXT
  );

  CREATE TABLE IF NOT EXISTS tickets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT UNIQUE NOT NULL,
    buyer_name TEXT NOT NULL,
    buyer_phone TEXT DEFAULT '',
    quantity INTEGER NOT NULL DEFAULT 1,
    delivered_quantity INTEGER NOT NULL DEFAULT 0,
    unit_price REAL NOT NULL DEFAULT 35.0,
    total_price REAL NOT NULL DEFAULT 35.0,
    payment_status TEXT NOT NULL DEFAULT 'pago',
    payment_method TEXT NOT NULL DEFAULT 'pix',
    status TEXT NOT NULL DEFAULT 'ativo', -- 'ativo', 'parcial', 'entregue', 'cancelado'
    notes TEXT DEFAULT '',
    created_at DATETIME DEFAULT (datetime('now', 'localtime')),
    updated_at DATETIME DEFAULT (datetime('now', 'localtime'))
  );

  CREATE TABLE IF NOT EXISTS deliveries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ticket_id INTEGER NOT NULL,
    ticket_code TEXT NOT NULL,
    quantity_delivered INTEGER NOT NULL,
    delivered_by TEXT DEFAULT 'Balcão 1',
    delivered_at DATETIME DEFAULT (datetime('now', 'localtime')),
    FOREIGN KEY(ticket_id) REFERENCES tickets(id)
  );

  CREATE INDEX IF NOT EXISTS idx_tickets_code ON tickets(code);
  CREATE INDEX IF NOT EXISTS idx_tickets_status ON tickets(status);
  CREATE INDEX IF NOT EXISTS idx_deliveries_ticket ON deliveries(ticket_id);
`);

// Migração segura para adicionar payment_date se não existir
try {
  const tableInfo = db.prepare("PRAGMA table_info(tickets)").all();
  const hasPaymentDate = tableInfo.some(col => col.name === 'payment_date');
  if (!hasPaymentDate) {
    db.prepare("ALTER TABLE tickets ADD COLUMN payment_date TEXT DEFAULT ''").run();
    // Preencher tickets existentes com a data de criação
    db.prepare("UPDATE tickets SET payment_date = substr(created_at, 1, 10) WHERE payment_status = 'pago' AND (payment_date IS NULL OR payment_date = '')").run();
  }
} catch (e) {
  console.warn('Erro ao verificar/migrar payment_date:', e.message);
}

// Configuração inicial padrão do evento
const initConfig = db.prepare('INSERT OR IGNORE INTO config (key, value) VALUES (?, ?)');
initConfig.run('event_name', 'Feijoada Comunitária da Paróquia');
initConfig.run('event_date', '2026-10-18');
initConfig.run('event_time', '11:30 às 15:00');
initConfig.run('event_location', 'Salão Paroquial');
initConfig.run('unit_price', '1000');
initConfig.run('currency_symbol', '¥');

module.exports = db;
