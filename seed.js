const db = require('./database');
const QRCode = require('qrcode');

console.log('Populando dados de teste para a Feijoada Comunitária...');

// Limpar dados anteriores de teste se houver
db.prepare('DELETE FROM deliveries').run();
db.prepare('DELETE FROM tickets').run();

const sampleTickets = [
  { code: 'FEIJ-1001', name: 'Thiago Kurihara', phone: '080-1234-5678', qty: 2, method: 'paypay', status: 'ativo', notes: 'Retirada às 12:00' },
  { code: 'FEIJ-1002', name: 'Padre Antônio & Equipe', phone: '090-9999-0001', qty: 3, method: 'outro', status: 'ativo', notes: 'Cortesia Pastoral' },
  { code: 'FEIJ-1003', name: 'Família Santos (Ogaki)', phone: '080-8888-7777', qty: 4, method: 'dinheiro', status: 'ativo', notes: 'Caprichar na couve e farofa' },
  { code: 'FEIJ-1004', name: 'Marcos Vinícius (Gifu)', phone: '070-7777-6666', qty: 1, method: 'transferencia', status: 'ativo', notes: 'Viagem' },
  { code: 'FEIJ-1005', name: 'Mariana Takahashi', phone: '090-5555-4444', qty: 2, method: 'paypay', status: 'entregue', notes: 'Retirada antecipada' }
];

const insert = db.prepare(`
  INSERT INTO tickets (
    code, buyer_name, buyer_phone, quantity, delivered_quantity,
    unit_price, total_price, payment_status, payment_method, status, notes
  ) VALUES (?, ?, ?, ?, ?, 1500.0, ?, 'pago', ?, ?, ?)
`);

sampleTickets.forEach(t => {
  const delivered = t.status === 'entregue' ? t.qty : 0;
  const total = t.qty * 1500.0;
  const res = insert.run(t.code, t.name, t.phone, t.qty, delivered, total, t.method, t.status, t.notes);
  
  if (t.status === 'entregue') {
    db.prepare(`
      INSERT INTO deliveries (ticket_id, ticket_code, quantity_delivered, delivered_by, delivered_at)
      VALUES (?, ?, ?, 'Balcão Cozinha 1', datetime('now', '-30 minutes', 'localtime'))
    `).run(res.lastInsertRowid, t.code, t.qty);
  }
});

console.log('✅ Dados de teste inseridos com sucesso!');
console.log('5 vales criados, sendo 1 já entregue para demonstrar o alerta de reutilização.');
