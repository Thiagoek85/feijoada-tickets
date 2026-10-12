const express = require('express');
const cors = require('cors');
const path = require('path');
const http = require('http');
const https = require('https');
const fs = require('fs');
const QRCode = require('qrcode');
const db = require('./database');

const app = express();
const HTTP_PORT = parseInt(process.env.PORT, 10) || 3000;
const HTTPS_PORT = parseInt(process.env.HTTPS_PORT, 10) || 3443;

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// Gerador de código legível e único (Ex: FEIJ-7842)
function generateTicketCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let random = '';
  for (let i = 0; i < 4; i++) {
    random += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return `FEIJ-${random}`;
}

// Lista de clientes conectados a SSE para atualizações em tempo real
let sseClients = [];

function broadcastEvent(type, data) {
  const payload = `data: ${JSON.stringify({ type, data })}\n\n`;
  sseClients.forEach(client => {
    try {
      client.res.write(payload);
    } catch (e) {
      // conexão fechada
    }
  });
}

// Endpoint SSE para tempo real (Dashboard da Cozinha e Scanner)
app.get('/api/events', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive'
  });

  const clientId = Date.now();
  const newClient = { id: clientId, res };
  sseClients.push(newClient);

  req.on('close', () => {
    sseClients = sseClients.filter(c => c.id !== clientId);
  });
});

// Configurações do evento
app.get('/api/config', (req, res) => {
  const rows = db.prepare('SELECT key, value FROM config').all();
  const config = {};
  rows.forEach(r => config[r.key] = r.value);
  config.https_port = HTTPS_PORT;
  config.http_port = HTTP_PORT;
  res.json(config);
});

app.post('/api/config', (req, res) => {
  const { event_name, event_date, event_time, event_location, unit_price, currency_symbol } = req.body;
  const update = db.prepare('INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)');
  
  if (event_name !== undefined) update.run('event_name', String(event_name));
  if (event_date !== undefined) update.run('event_date', String(event_date));
  if (event_time !== undefined) update.run('event_time', String(event_time));
  if (event_location !== undefined) update.run('event_location', String(event_location));
  if (unit_price !== undefined) update.run('unit_price', String(unit_price));
  if (currency_symbol !== undefined) update.run('currency_symbol', String(currency_symbol));

  broadcastEvent('config_updated', { message: 'Configurações atualizadas' });
  res.json({ success: true });
});

// Estatísticas e Telemetria em Tempo Real (Dashboard da Logística e Caixa)
app.get('/api/stats', (req, res) => {
  try {
    const totalRow = db.prepare(`
      SELECT 
        COUNT(id) as total_tickets,
        COALESCE(SUM(quantity), 0) as total_feijoadas,
        COALESCE(SUM(delivered_quantity), 0) as total_delivered,
        COALESCE(SUM(total_price), 0) as total_revenue
      FROM tickets WHERE status != 'cancelado'
    `).get();

    const balcaoRow = db.prepare(`
      SELECT 
        COUNT(id) as balcao_tickets,
        COALESCE(SUM(quantity), 0) as balcao_feijoadas,
        COALESCE(SUM(total_price), 0) as balcao_revenue
      FROM tickets 
      WHERE status != 'cancelado' AND sale_channel = 'balcao'
    `).get();

    const pendingFeijoadas = (totalRow.total_feijoadas || 0) - (totalRow.total_delivered || 0);

    const statusCounts = db.prepare(`
      SELECT status, COUNT(*) as count 
      FROM tickets 
      GROUP BY status
    `).all();

    const paymentMethods = db.prepare(`
      SELECT payment_method, COUNT(*) as count, SUM(total_price) as total
      FROM tickets WHERE status != 'cancelado'
      GROUP BY payment_method
    `).all();

    const recentDeliveries = db.prepare(`
      SELECT d.*, t.buyer_name
      FROM deliveries d
      JOIN tickets t ON t.id = d.ticket_id
      ORDER BY d.id DESC
      LIMIT 10
    `).all();

    res.json({
      total_tickets: totalRow.total_tickets || 0,
      total_feijoadas: totalRow.total_feijoadas || 0,
      total_delivered: totalRow.total_delivered || 0,
      pending_feijoadas: Math.max(0, pendingFeijoadas),
      total_revenue: totalRow.total_revenue || 0,
      balcao_tickets: balcaoRow.balcao_tickets || 0,
      balcao_feijoadas: balcaoRow.balcao_feijoadas || 0,
      balcao_revenue: balcaoRow.balcao_revenue || 0,
      completion_percentage: totalRow.total_feijoadas > 0 
        ? Math.round((totalRow.total_delivered / totalRow.total_feijoadas) * 100) 
        : 0,
      status_counts: statusCounts,
      payment_methods: paymentMethods,
      recent_deliveries: recentDeliveries
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Listar Tickets com Filtro
app.get('/api/tickets', (req, res) => {
  try {
    const { search, status, channel } = req.query;
    let query = 'SELECT * FROM tickets WHERE 1=1';
    const params = [];

    if (search) {
      query += ' AND (code LIKE ? OR buyer_name LIKE ? OR buyer_phone LIKE ?)';
      const term = `%${search.trim()}%`;
      params.push(term, term, term);
    }

    if (status && status !== 'todos') {
      query += ' AND status = ?';
      params.push(status);
    }

    if (channel && channel !== 'todos') {
      query += ' AND sale_channel = ?';
      params.push(channel);
    }

    query += ' ORDER BY id DESC';
    const tickets = db.prepare(query).all(...params);
    res.json(tickets);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Criar Novo Ticket (Venda Antecipada ou Venda de Balcão)
app.post('/api/tickets', async (req, res) => {
  try {
    const { 
      buyer_name, 
      buyer_phone, 
      quantity, 
      unit_price, 
      payment_status, 
      payment_method, 
      payment_date, 
      notes, 
      sale_channel, 
      auto_deliver 
    } = req.body;

    const finalSaleChannel = sale_channel === 'balcao' ? 'balcao' : 'antecipado';
    const finalBuyerName = (buyer_name && buyer_name.trim()) 
      ? buyer_name.trim() 
      : (finalSaleChannel === 'balcao' ? 'Cliente Balcão' : '');

    if (!finalBuyerName) {
      return res.status(400).json({ error: 'O nome do comprador é obrigatório.' });
    }

    const qty = parseInt(quantity, 10) || 1;
    if (qty <= 0) {
      return res.status(400).json({ error: 'A quantidade deve ser pelo menos 1.' });
    }

    // Obter preço unitário configurado se não fornecido
    const configPrice = db.prepare("SELECT value FROM config WHERE key = 'unit_price'").get();
    const finalUnitPrice = unit_price !== undefined ? parseFloat(unit_price) : parseFloat(configPrice?.value || 1000);
    const totalPrice = qty * finalUnitPrice;

    // Gerar código único
    let code = generateTicketCode();
    let exists = db.prepare('SELECT id FROM tickets WHERE code = ?').get(code);
    let attempts = 0;
    while (exists && attempts < 10) {
      code = generateTicketCode();
      exists = db.prepare('SELECT id FROM tickets WHERE code = ?').get(code);
      attempts++;
    }

    // Data de pagamento: padrão hoje (YYYY-MM-DD) se estiver pago
    const todayStr = new Date().toISOString().split('T')[0];
    const finalPaymentStatus = payment_status || 'pago';
    const finalPaymentDate = payment_date !== undefined ? payment_date : (finalPaymentStatus === 'pago' ? todayStr : '');

    const isAutoDeliver = Boolean(auto_deliver);
    const initialDeliveredQty = isAutoDeliver ? qty : 0;
    const initialStatus = isAutoDeliver ? 'entregue' : 'ativo';

    const insert = db.prepare(`
      INSERT INTO tickets (
        code, buyer_name, buyer_phone, quantity, delivered_quantity,
        unit_price, total_price, payment_status, payment_method, payment_date, status, notes, sale_channel
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const result = insert.run(
      code,
      finalBuyerName,
      (buyer_phone || '').trim(),
      qty,
      initialDeliveredQty,
      finalUnitPrice,
      totalPrice,
      finalPaymentStatus,
      payment_method || 'dinheiro',
      finalPaymentDate,
      initialStatus,
      (notes || '').trim(),
      finalSaleChannel
    );

    const ticketId = result.lastInsertRowid;

    if (isAutoDeliver) {
      db.prepare(`
        INSERT INTO deliveries (ticket_id, ticket_code, quantity_delivered, delivered_by)
        VALUES (?, ?, ?, ?)
      `).run(ticketId, code, qty, 'Balcão (Venda Direta)');
    }

    const ticket = db.prepare('SELECT * FROM tickets WHERE id = ?').get(ticketId);
    
    // Gera QR Code base64 data URL
    const qrDataUrl = await QRCode.toDataURL(ticket.code, {
      errorCorrectionLevel: 'H',
      margin: 2,
      width: 320,
      color: {
        dark: '#1c1917',
        light: '#ffffff'
      }
    });

    broadcastEvent('ticket_created', ticket);
    if (isAutoDeliver) {
      broadcastEvent('ticket_delivered', { ticket, delivered_now: qty });
    }

    res.status(201).json({
      success: true,
      ticket,
      qr_code: qrDataUrl
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Gerar Lote de Tickets Avulsos (para venda presencial na porta)
app.post('/api/tickets/batch', async (req, res) => {
  try {
    const { count, prefix_name, quantity_per_ticket, unit_price, payment_method } = req.body;
    const numTickets = parseInt(count, 10) || 10;
    const qtyPerTicket = parseInt(quantity_per_ticket, 10) || 1;
    const prefix = prefix_name ? prefix_name.trim() : 'Vale Avulso';

    const configPrice = db.prepare("SELECT value FROM config WHERE key = 'unit_price'").get();
    const finalUnitPrice = unit_price !== undefined ? parseFloat(unit_price) : parseFloat(configPrice?.value || 1000);
    const totalPrice = qtyPerTicket * finalUnitPrice;

    const createdTickets = [];
    const insert = db.prepare(`
      INSERT INTO tickets (
        code, buyer_name, buyer_phone, quantity, delivered_quantity,
        unit_price, total_price, payment_status, payment_method, status, notes
      ) VALUES (?, ?, '', ?, 0, ?, ?, 'pago', ?, 'ativo', 'Venda em lote / Avulso')
    `);

    const insertMany = db.transaction(() => {
      for (let i = 1; i <= numTickets; i++) {
        let code = generateTicketCode();
        while (db.prepare('SELECT id FROM tickets WHERE code = ?').get(code)) {
          code = generateTicketCode();
        }
        const buyerName = `${prefix} #${i.toString().padStart(3, '0')}`;
        const res = insert.run(
          code,
          buyerName,
          qtyPerTicket,
          finalUnitPrice,
          totalPrice,
          payment_method || 'dinheiro'
        );
        createdTickets.push({ id: res.lastInsertRowid, code, buyer_name: buyerName, quantity: qtyPerTicket, total_price: totalPrice });
      }
    });

    insertMany();
    broadcastEvent('batch_created', { count: createdTickets.length });

    res.json({
      success: true,
      message: `${createdTickets.length} vales gerados com sucesso!`,
      tickets: createdTickets
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Buscar Detalhes do Ticket por Código ou ID
app.get('/api/tickets/:code', async (req, res) => {
  try {
    const code = req.params.code.trim().toUpperCase();
    const ticket = db.prepare('SELECT * FROM tickets WHERE code = ? OR id = ?').get(code, code);

    if (!ticket) {
      return res.status(404).json({ error: 'Ticket não encontrado.' });
    }

    const deliveries = db.prepare('SELECT * FROM deliveries WHERE ticket_id = ? ORDER BY id DESC').all(ticket.id);

    const qrDataUrl = await QRCode.toDataURL(ticket.code, {
      errorCorrectionLevel: 'H',
      margin: 2,
      width: 320
    });

    res.json({
      ...ticket,
      deliveries,
      qr_code: qrDataUrl
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Imagem PNG do QR Code
app.get('/api/tickets/:code/qr.png', async (req, res) => {
  try {
    const code = req.params.code.trim().toUpperCase();
    res.setHeader('Content-Type', 'image/png');
    await QRCode.toFileStream(res, code, {
      errorCorrectionLevel: 'H',
      margin: 2,
      width: 400
    });
  } catch (error) {
    res.status(500).send('Erro ao gerar QR Code');
  }
});

// Validação de Leitura do QR Code (Scanner)
app.post('/api/tickets/:code/validate', (req, res) => {
  try {
    const code = req.params.code.trim().toUpperCase();
    const ticket = db.prepare('SELECT * FROM tickets WHERE code = ?').get(code);

    if (!ticket) {
      return res.status(404).json({
        valid: false,
        error: 'TICKET NÃO ENCONTRADO',
        message: `O código "${code}" não existe no sistema da paróquia.`
      });
    }

    const deliveries = db.prepare('SELECT * FROM deliveries WHERE ticket_id = ? ORDER BY id DESC').all(ticket.id);
    const remaining = ticket.quantity - ticket.delivered_quantity;

    if (ticket.status === 'cancelado') {
      return res.status(400).json({
        valid: false,
        status: 'cancelado',
        error: 'TICKET CANCELADO',
        message: 'Este ticket foi cancelado e não pode ser entregue.',
        ticket,
        deliveries
      });
    }

    if (remaining <= 0 || ticket.status === 'entregue') {
      return res.status(409).json({
        valid: false,
        already_delivered: true,
        status: 'entregue',
        error: 'TICKET JÁ UTILIZADO!',
        message: `Todas as ${ticket.quantity} porções já foram entregues anteriormente!`,
        ticket,
        deliveries,
        last_delivery: deliveries[0] || null
      });
    }

    // Ticket válido e com porções disponíveis
    res.json({
      valid: true,
      ticket,
      remaining_quantity: remaining,
      deliveries,
      message: `Ticket válido! ${remaining} de ${ticket.quantity} porção(ões) pronta(s) para entrega.`
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Efetuar Baixa / Entrega do Ticket
app.post('/api/tickets/:code/deliver', (req, res) => {
  try {
    const code = req.params.code.trim().toUpperCase();
    const { quantity_to_deliver, delivered_by } = req.body;

    const ticket = db.prepare('SELECT * FROM tickets WHERE code = ?').get(code);
    if (!ticket) {
      return res.status(404).json({ error: 'Ticket não encontrado.' });
    }

    if (ticket.status === 'cancelado') {
      return res.status(400).json({ error: 'Ticket cancelado.' });
    }

    const available = ticket.quantity - ticket.delivered_quantity;
    if (available <= 0) {
      return res.status(409).json({ 
        error: 'Ticket já totalmente entregue!',
        ticket 
      });
    }

    const qtyDeliver = quantity_to_deliver ? parseInt(quantity_to_deliver, 10) : available;
    if (qtyDeliver <= 0 || qtyDeliver > available) {
      return res.status(400).json({ 
        error: `Quantidade inválida. Disponível para retirada: ${available} porção(ões).` 
      });
    }

    const newDeliveredTotal = ticket.delivered_quantity + qtyDeliver;
    const newStatus = (newDeliveredTotal >= ticket.quantity) ? 'entregue' : 'parcial';
    const operator = delivered_by || 'Balcão de Entrega';

    const performDelivery = db.transaction(() => {
      // 1. Registra entrega
      db.prepare(`
        INSERT INTO deliveries (ticket_id, ticket_code, quantity_delivered, delivered_by)
        VALUES (?, ?, ?, ?)
      `).run(ticket.id, ticket.code, qtyDeliver, operator);

      // 2. Atualiza ticket
      db.prepare(`
        UPDATE tickets 
        SET delivered_quantity = ?, status = ?, updated_at = datetime('now', 'localtime')
        WHERE id = ?
      `).run(newDeliveredTotal, newStatus, ticket.id);
    });

    performDelivery();

    const updatedTicket = db.prepare('SELECT * FROM tickets WHERE id = ?').get(ticket.id);
    const deliveries = db.prepare('SELECT * FROM deliveries WHERE ticket_id = ? ORDER BY id DESC').all(ticket.id);

    // Notifica todos em tempo real
    broadcastEvent('ticket_delivered', {
      ticket: updatedTicket,
      delivered_count: qtyDeliver,
      remaining: updatedTicket.quantity - updatedTicket.delivered_quantity,
      operator
    });

    res.json({
      success: true,
      message: `${qtyDeliver} porção(ões) entregue(s) com sucesso!`,
      ticket: updatedTicket,
      deliveries
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Atualizar / Editar Ticket (Entrada, Saída, Pagamento, Dados)
app.put('/api/tickets/:code', (req, res) => {
  try {
    const code = req.params.code.trim().toUpperCase();
    const ticket = db.prepare('SELECT * FROM tickets WHERE code = ?').get(code);

    if (!ticket) {
      return res.status(404).json({ error: 'Ticket não encontrado.' });
    }

    const {
      buyer_name,
      buyer_phone,
      quantity,
      delivered_quantity,
      payment_method,
      payment_status,
      payment_date,
      status,
      notes
    } = req.body;

    const newName = buyer_name !== undefined ? buyer_name.trim() : ticket.buyer_name;
    const newPhone = buyer_phone !== undefined ? buyer_phone.trim() : ticket.buyer_phone;
    const newQty = quantity !== undefined ? Math.max(1, parseInt(quantity, 10)) : ticket.quantity;
    
    // Saída / Quantidade entregue
    let newDelivered = delivered_quantity !== undefined ? Math.max(0, parseInt(delivered_quantity, 10)) : ticket.delivered_quantity;
    if (newDelivered > newQty) {
      newDelivered = newQty;
    }

    const newTotalPrice = newQty * ticket.unit_price;
    const newPayMethod = payment_method !== undefined ? payment_method : (ticket.payment_method || 'dinheiro');
    const newPayStatus = payment_status !== undefined ? payment_status : ticket.payment_status;
    const newPayDate = payment_date !== undefined ? payment_date : (ticket.payment_date || '');
    const newNotes = notes !== undefined ? notes.trim() : ticket.notes;

    // Calcular novo status
    let calculatedStatus = ticket.status;
    if (status !== undefined) {
      calculatedStatus = status;
    } else {
      if (newDelivered >= newQty) {
        calculatedStatus = 'entregue';
      } else if (newDelivered > 0) {
        calculatedStatus = 'parcial';
      } else {
        calculatedStatus = 'ativo';
      }
    }

    db.prepare(`
      UPDATE tickets 
      SET buyer_name = ?,
          buyer_phone = ?,
          quantity = ?,
          delivered_quantity = ?,
          total_price = ?,
          payment_method = ?,
          payment_status = ?,
          payment_date = ?,
          status = ?,
          notes = ?,
          updated_at = datetime('now', 'localtime')
      WHERE id = ?
    `).run(
      newName,
      newPhone,
      newQty,
      newDelivered,
      newTotalPrice,
      newPayMethod,
      newPayStatus,
      newPayDate,
      calculatedStatus,
      newNotes,
      ticket.id
    );

    const updated = db.prepare('SELECT * FROM tickets WHERE id = ?').get(ticket.id);

    broadcastEvent('ticket_updated', updated);

    res.json({
      success: true,
      message: 'Vale atualizado com sucesso!',
      ticket: updated
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Cancelar Ticket (Soft delete / Anulação)
app.delete('/api/tickets/:code', (req, res) => {
  try {
    const code = req.params.code.trim().toUpperCase();
    const ticket = db.prepare('SELECT * FROM tickets WHERE code = ?').get(code);

    if (!ticket) {
      return res.status(404).json({ error: 'Ticket não encontrado.' });
    }

    db.prepare("UPDATE tickets SET status = 'cancelado', updated_at = datetime('now', 'localtime') WHERE id = ?").run(ticket.id);
    broadcastEvent('ticket_updated', { ...ticket, status: 'cancelado' });

    res.json({ success: true, message: 'Vale cancelado com sucesso!' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Excluir Permanentemente um Ticket Individual (Purge)
app.delete('/api/tickets/:code/purge', (req, res) => {
  try {
    const code = req.params.code.trim().toUpperCase();
    const ticket = db.prepare('SELECT * FROM tickets WHERE code = ?').get(code);

    if (!ticket) {
      return res.status(404).json({ error: 'Ticket não encontrado.' });
    }

    db.transaction(() => {
      db.prepare('DELETE FROM deliveries WHERE ticket_id = ?').run(ticket.id);
      db.prepare('DELETE FROM tickets WHERE id = ?').run(ticket.id);
    })();

    broadcastEvent('ticket_deleted', { code, id: ticket.id });

    res.json({ success: true, message: `Vale ${code} excluído permanentemente do sistema.` });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Limpeza em Lote de Vales (Purge Bulk: cancelados, entregues ou ambos)
app.post('/api/tickets/purge-bulk', (req, res) => {
  try {
    const { target } = req.body; // 'cancelados', 'entregues' ou 'finalizados' (ambos)
    let condition = '';

    if (target === 'cancelados') {
      condition = "status = 'cancelado'";
    } else if (target === 'entregues') {
      condition = "status = 'entregue'";
    } else if (target === 'finalizados' || target === 'todos_inativos') {
      condition = "status IN ('cancelado', 'entregue')";
    } else {
      return res.status(400).json({ error: "Alvo inválido. Use 'cancelados', 'entregues' ou 'finalizados'." });
    }

    const ticketsToDelete = db.prepare(`SELECT id, code FROM tickets WHERE ${condition}`).all();
    if (ticketsToDelete.length === 0) {
      return res.json({ success: true, count: 0, message: 'Nenhum pedido encontrado para exclusão.' });
    }

    const ticketIds = ticketsToDelete.map(t => t.id);
    const placeholders = ticketIds.map(() => '?').join(',');

    db.transaction(() => {
      db.prepare(`DELETE FROM deliveries WHERE ticket_id IN (${placeholders})`).run(...ticketIds);
      db.prepare(`DELETE FROM tickets WHERE id IN (${placeholders})`).run(...ticketIds);
    })();

    broadcastEvent('tickets_purged', { count: ticketsToDelete.length, target });

    res.json({
      success: true,
      count: ticketsToDelete.length,
      message: `${ticketsToDelete.length} vale(s) excluído(s) permanentemente com sucesso!`
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Exportar CSV completo para prestação de contas da paróquia (formato Ienes)
app.get('/api/export/csv', (req, res) => {
  try {
    const tickets = db.prepare('SELECT * FROM tickets ORDER BY id ASC').all();
    const config = db.prepare("SELECT value FROM config WHERE key = 'currency_symbol'").get();
    const symbol = config?.value || '¥';
    
    let csv = `ID;Codigo;Canal de Venda;Nome Comprador;Telefone;Qtd Vendida;Qtd Entregue;Preco Total (${symbol});Data Pagamento;Forma Pagamento;Status Pagamento;Status Ticket;Criado Em;Atualizado Em;Observacoes\n`;
    
    tickets.forEach(t => {
      const canalLabel = t.sale_channel === 'balcao' ? 'Balcão' : 'Antecipado';
      csv += `${t.id};"${t.code}";"${canalLabel}";"${t.buyer_name.replace(/"/g, '""')}";"${t.buyer_phone}";${t.quantity};${t.delivered_quantity};${Math.round(t.total_price)};"${t.payment_date || ''}";"${t.payment_method || 'dinheiro'}";"${t.payment_status}";"${t.status}";"${t.created_at}";"${t.updated_at}";"${(t.notes || '').replace(/"/g, '""')}"\n`;
    });

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename=relatorio-feijoada-tickets-japao.csv');
    // Adiciona BOM para abrir certinho com caracteres e acentos no Excel
    res.send('\uFEFF' + csv);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Servir página do ticket para visualização no celular do comprador
app.get('/ticket/:code', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'ticket.html'));
});

// Servir página para impressão em lote
app.get('/print-batch', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'print-batch.html'));
});

// Servir página do tutorial ilustrado
app.get('/tutorial', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'tutorial.html'));
});

// Servidor HTTP
const httpServer = http.createServer(app);
httpServer.listen(HTTP_PORT, '0.0.0.0', () => {
  console.log(`====================================================`);
  console.log(`🥘 SISTEMA DE TICKETS - VALE FEIJOADA NO JAPÃO`);
  console.log(`📡 HTTP ativo na porta: ${HTTP_PORT}`);
  console.log(`🌐 Acesso Local: http://localhost:${HTTP_PORT}`);
});

// Servidor HTTPS para liberação de Câmera em navegadores móveis via URL
const certPath = path.join(__dirname, 'certs', 'server.crt');
const keyPath = path.join(__dirname, 'certs', 'server.key');

if (fs.existsSync(certPath) && fs.existsSync(keyPath)) {
  try {
    const sslOptions = {
      key: fs.readFileSync(keyPath),
      cert: fs.readFileSync(certPath)
    };
    const httpsServer = https.createServer(sslOptions, app);
    httpsServer.listen(HTTPS_PORT, '0.0.0.0', () => {
      console.log(`🔒 HTTPS ativo na porta: ${HTTPS_PORT} (Permite acesso irrestrito à câmera!)`);
      console.log(`📱 Acesso Seguro Celular: https://localhost:${HTTPS_PORT}`);
      console.log(`====================================================`);
    });
  } catch (sslErr) {
    console.warn('Não foi possível iniciar HTTPS:', sslErr.message);
  }
}
