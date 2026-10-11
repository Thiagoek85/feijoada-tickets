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

// Configuração inicial padrão do evento
const initConfig = db.prepare('INSERT OR IGNORE INTO config (key, value) VALUES (?, ?)');
initConfig.run('event_name', 'Feijoada Comunitária da Paróquia');
initConfig.run('event_date', '2026-10-18');
initConfig.run('event_time', '11:30 às 15:00');
initConfig.run('event_location', 'Salão Paroquial');
initConfig.run('unit_price', '1500');
initConfig.run('currency_symbol', '¥');

module.exports = db;
