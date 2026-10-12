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

// Obter PIN de Administrador configurado
function getAdminPin() {
  const row = db.prepare("SELECT value FROM config WHERE key = 'admin_pin'").get();
  return row?.value || '2026';
}

// Middleware de proteção por PIN para ações críticas e administrativas
function requireAdminPin(req, res, next) {
  const pinHeader = req.headers['x-admin-pin'];
  const pinBody = req.body?.admin_pin;
  const pinQuery = req.query?.admin_pin;
  const pin = pinHeader || pinBody || pinQuery;
  const correctPin = getAdminPin();

  if (!pin || String(pin).trim() !== String(correctPin).trim()) {
    return res.status(403).json({
      error: 'Acesso negado: PIN de administrador inválido ou não informado.',
      requires_pin: true
    });
  }
  next();
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

// Verificação de PIN administrativo
app.post('/api/auth/verify-pin', (req, res) => {
  const { pin } = req.body;
  const correctPin = getAdminPin();
  if (pin && String(pin).trim() === String(correctPin).trim()) {
    return res.json({ success: true, message: 'PIN verificado com sucesso.' });
  }
  return res.status(401).json({ success: false, error: 'PIN de administrador incorreto.' });
});

// Configurações do evento
app.get('/api/config', (req, res) => {
  const rows = db.prepare('SELECT key, value FROM config').all();
  const config = {};
  rows.forEach(r => {
    // Não expor admin_pin diretamente no get aberto para celulares
    if (r.key !== 'admin_pin') {
      config[r.key] = r.value;
    }
  });
  config.https_port = HTTPS_PORT;
  config.http_port = HTTP_PORT;
  res.json(config);
});

// Atualizar configurações (protegido por PIN de admin)
app.post('/api/config', requireAdminPin, (req, res) => {
  const { event_name, event_date, event_time, event_location, unit_price, currency_symbol, admin_pin } = req.body;
  const update = db.prepare('INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)');
  
  if (event_name !== undefined) update.run('event_name', String(event_name));
  if (event_date !== undefined) update.run('event_date', String(event_date));
  if (event_time !== undefined) update.run('event_time', String(event_time));
  if (event_location !== undefined) update.run('event_location', String(event_location));
  if (unit_price !== undefined) update.run('unit_price', String(unit_price));
  if (currency_symbol !== undefined) update.run('currency_symbol', String(currency_symbol));
  if (admin_pin !== undefined && String(admin_pin).trim().length >= 4) {
    update.run('admin_pin', String(admin_pin).trim());
  }

  broadcastEvent('config_updated', { message: 'Configurações atualizadas' });
  res.json({ success: true, message: 'Configurações atualizadas com sucesso!' });
});

// Estatísticas e Telemetria em Tempo Real (Dashboard da Logística e Caixa)
app.get('/api/stats', (req, res) => {
  try {
    // Estatísticas financeiras e de porções separadas com precisão
    const totalRow = db.prepare(`
      SELECT 
        COUNT(id) as total_tickets,
        COALESCE(SUM(quantity), 0) as total_feijoadas,
        COALESCE(SUM(delivered_quantity), 0) as total_delivered,
        COALESCE(SUM(CASE WHEN payment_status = 'pago' THEN total_price ELSE 0 END), 0) as total_revenue,
        COALESCE(SUM(CASE WHEN payment_status = 'pendente' THEN total_price ELSE 0 END), 0) as pending_revenue,
        COALESCE(SUM(CASE WHEN payment_status = 'pago' AND payment_method = 'dinheiro' THEN total_price ELSE 0 END), 0) as cash_revenue,
        COALESCE(SUM(CASE WHEN payment_status = 'pago' AND payment_method != 'dinheiro' THEN total_price ELSE 0 END), 0) as digital_revenue
      FROM tickets 
      WHERE status != 'cancelado'
    `).get();

    const balcaoRow = db.prepare(`
      SELECT 
        COUNT(id) as balcao_tickets,
        COALESCE(SUM(quantity), 0) as balcao_feijoadas,
        COALESCE(SUM(CASE WHEN payment_status = 'pago' THEN total_price ELSE 0 END), 0) as balcao_revenue
      FROM tickets 
      WHERE status != 'cancelado' AND sale_channel = 'balcao'
    `).get();

    const pendingFeijoadas = (totalRow.total_feijoadas || 0) - (totalRow.total_delivered || 0);

    const statusCounts = db.prepare(`
      SELECT status, COUNT(*) as count 
      FROM tickets 
      GROUP BY status
    `).all();

    // Apenas pagamentos efetivamente confirmados compõem a divisão por método
    const paymentMethods = db.prepare(`
      SELECT payment_method, COUNT(*) as count, SUM(total_price) as total
      FROM tickets 
      WHERE status != 'cancelado' AND payment_status = 'pago'
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
      pending_revenue: totalRow.pending_revenue || 0,
      cash_revenue: totalRow.cash_revenue || 0,
      digital_revenue: totalRow.digital_revenue || 0,
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

// Fechamento de Caixa Unificado do Final do Dia (Consolidação Multi-Smartphone)
app.get('/api/cashflow/summary', (req, res) => {
  try {
    const summary = db.prepare(`
      SELECT 
        COUNT(id) as total_tickets,
        COALESCE(SUM(quantity), 0) as total_feijoadas,
        COALESCE(SUM(delivered_quantity), 0) as total_delivered,
        COALESCE(SUM(CASE WHEN payment_status = 'pago' THEN total_price ELSE 0 END), 0) as total_collected,
        COALESCE(SUM(CASE WHEN payment_status = 'pago' AND payment_method = 'dinheiro' THEN total_price ELSE 0 END), 0) as confirmed_cash,
        COALESCE(SUM(CASE WHEN payment_status = 'pago' AND payment_method != 'dinheiro' THEN total_price ELSE 0 END), 0) as confirmed_digital,
        COALESCE(SUM(CASE WHEN payment_status = 'pendente' THEN total_price ELSE 0 END), 0) as pending_amount
      FROM tickets 
      WHERE status != 'cancelado'
    `).get();

    // Consolidação por Operador / Colaborador / Smartphone
    const byOperator = db.prepare(`
      SELECT 
        COALESCE(NULLIF(sold_by, ''), 'Administração') as operator,
        COUNT(id) as tickets_count,
        SUM(quantity) as feijoadas_count,
        SUM(CASE WHEN payment_status = 'pago' AND payment_method = 'dinheiro' THEN total_price ELSE 0 END) as cash_collected,
        SUM(CASE WHEN payment_status = 'pago' AND payment_method != 'dinheiro' THEN total_price ELSE 0 END) as digital_collected,
        SUM(CASE WHEN payment_status = 'pago' THEN total_price ELSE 0 END) as total_collected,
        SUM(CASE WHEN payment_status = 'pendente' THEN total_price ELSE 0 END) as pending_amount
      FROM tickets 
      WHERE status != 'cancelado'
      GROUP BY COALESCE(NULLIF(sold_by, ''), 'Administração')
      ORDER BY total_collected DESC
    `).all();

    // Entregas por operador
    const byDeliverer = db.prepare(`
      SELECT 
        COALESCE(NULLIF(delivered_by, ''), 'Balcão de Entrega') as deliverer,
        COUNT(id) as deliveries_count,
        SUM(quantity_delivered) as feijoadas_delivered
      FROM deliveries
      GROUP BY COALESCE(NULLIF(delivered_by, ''), 'Balcão de Entrega')
      ORDER BY feijoadas_delivered DESC
    `).all();

    // Consolidação por Canal (Balcão vs Antecipado)
    const byChannel = db.prepare(`
      SELECT 
        sale_channel,
        COUNT(id) as count,
        SUM(quantity) as feijoadas,
        SUM(CASE WHEN payment_status = 'pago' THEN total_price ELSE 0 END) as revenue
      FROM tickets 
      WHERE status != 'cancelado'
      GROUP BY sale_channel
    `).all();

    // Consolidação por Forma de Pagamento
    const byMethod = db.prepare(`
      SELECT 
        payment_method,
        COUNT(id) as count,
        SUM(total_price) as total
      FROM tickets 
      WHERE status != 'cancelado' AND payment_status = 'pago'
      GROUP BY payment_method
    `).all();

    res.json({
      summary: {
        ...summary,
        pending_deliveries: Math.max(0, (summary.total_feijoadas || 0) - (summary.total_delivered || 0))
      },
      by_operator: byOperator,
      by_deliverer: byDeliverer,
      by_channel: byChannel,
      by_method: byMethod
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
      query += ' AND (code LIKE ? OR buyer_name LIKE ? OR buyer_phone LIKE ? OR sold_by LIKE ?)';
      const term = `%${search.trim()}%`;
      params.push(term, term, term, term);
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
      sold_by,
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

    // Identificação do operador / smartphone que efetuou a venda
    const finalSoldBy = (sold_by && String(sold_by).trim()) 
      ? String(sold_by).trim() 
      : (finalSaleChannel === 'balcao' ? 'Balcão de Venda' : 'Administração');

    // Gerar código único
    let code = generateTicketCode();
    let exists = db.prepare('SELECT id FROM tickets WHERE code = ?').get(code);
    let attempts = 0;
    while (exists && attempts < 15) {
      code = generateTicketCode();
      exists = db.prepare('SELECT id FROM tickets WHERE code = ?').get(code);
      attempts++;
    }

    // Data de pagamento: padrão hoje se estiver pago
    const todayStr = new Date().toISOString().split('T')[0];
    const finalPaymentStatus = payment_status || 'pago';
    const finalPaymentDate = payment_date !== undefined ? payment_date : (finalPaymentStatus === 'pago' ? todayStr : '');

    const isAutoDeliver = Boolean(auto_deliver);
    const initialDeliveredQty = isAutoDeliver ? qty : 0;
    const initialStatus = isAutoDeliver ? 'entregue' : 'ativo';

    const insert = db.prepare(`
      INSERT INTO tickets (
        code, buyer_name, buyer_phone, quantity, delivered_quantity,
        unit_price, total_price, payment_status, payment_method, payment_date,
        status, notes, sale_channel, sold_by
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      finalSaleChannel,
      finalSoldBy
    );

    const ticketId = result.lastInsertRowid;

    if (isAutoDeliver) {
      db.prepare(`
        INSERT INTO deliveries (ticket_id, ticket_code, quantity_delivered, delivered_by)
        VALUES (?, ?, ?, ?)
      `).run(ticketId, code, qty, `${finalSoldBy} (Venda Direta)`);
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
      broadcastEvent('ticket_delivered', { ticket, delivered_now: qty, operator: finalSoldBy });
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
    const { count, prefix_name, quantity_per_ticket, unit_price, payment_method, sold_by } = req.body;
    const numTickets = parseInt(count, 10) || 10;
    const qtyPerTicket = parseInt(quantity_per_ticket, 10) || 1;
    const prefix = prefix_name ? prefix_name.trim() : 'Vale Avulso';
    const finalSoldBy = (sold_by && String(sold_by).trim()) ? String(sold_by).trim() : 'Administração (Lote Avulso)';

    const configPrice = db.prepare("SELECT value FROM config WHERE key = 'unit_price'").get();
    const finalUnitPrice = unit_price !== undefined ? parseFloat(unit_price) : parseFloat(configPrice?.value || 1000);
    const totalPrice = qtyPerTicket * finalUnitPrice;

    const createdTickets = [];
    const insert = db.prepare(`
      INSERT INTO tickets (
        code, buyer_name, buyer_phone, quantity, delivered_quantity,
        unit_price, total_price, payment_status, payment_method, status, notes, sold_by
      ) VALUES (?, ?, '', ?, 0, ?, ?, 'pago', ?, 'ativo', 'Venda em lote / Avulso', ?)
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
          payment_method || 'dinheiro',
          finalSoldBy
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

    // Sinaliza claramente se o ticket está pendente de pagamento
    const isPendingPayment = ticket.payment_status === 'pendente';

    res.json({
      valid: true,
      ticket,
      remaining_quantity: remaining,
      needs_payment: isPendingPayment,
      amount_due: isPendingPayment ? ticket.total_price : 0,
      deliveries,
      message: `Ticket válido! ${remaining} de ${ticket.quantity} porção(ões) pronta(s) para entrega.`
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Efetuar Baixa / Entrega do Ticket com Proteção Atômica contra Condição de Corrida
app.post('/api/tickets/:code/deliver', (req, res) => {
  try {
    const code = req.params.code.trim().toUpperCase();
    const { quantity_to_deliver, delivered_by, received_payment } = req.body;

    const result = db.transaction(() => {
      // 1. Busca dados sob transação
      const ticket = db.prepare('SELECT * FROM tickets WHERE code = ?').get(code);
      if (!ticket) {
        return { status: 404, data: { error: 'Ticket não encontrado.' } };
      }

      if (ticket.status === 'cancelado') {
        return { status: 400, data: { error: 'Ticket cancelado.' } };
      }

      const available = ticket.quantity - ticket.delivered_quantity;
      if (available <= 0) {
        return { 
          status: 409, 
          data: { error: 'Ticket já totalmente entregue!', ticket } 
        };
      }

      const qtyDeliver = quantity_to_deliver ? parseInt(quantity_to_deliver, 10) : available;
      if (qtyDeliver <= 0 || qtyDeliver > available) {
        return { 
          status: 400, 
          data: { error: `Quantidade inválida. Disponível para retirada: ${available} porção(ões).` } 
        };
      }

      // Se foi recebido o pagamento em dinheiro no momento da entrega
      let newPaymentStatus = ticket.payment_status;
      let newPaymentDate = ticket.payment_date;
      if (received_payment === true || received_payment === 'true' || received_payment === 1) {
        newPaymentStatus = 'pago';
        newPaymentDate = new Date().toISOString().split('T')[0];
      }

      const newDeliveredTotal = ticket.delivered_quantity + qtyDeliver;
      const newStatus = (newDeliveredTotal >= ticket.quantity) ? 'entregue' : 'parcial';
      const operator = (delivered_by && String(delivered_by).trim()) ? String(delivered_by).trim() : 'Balcão de Entrega';

      // 2. Atualização Atômica: garante que dois celulares simultâneos não ultrapassem quantity
      const updateRun = db.prepare(`
        UPDATE tickets 
        SET delivered_quantity = delivered_quantity + ?,
            status = ?,
            payment_status = ?,
            payment_date = ?,
            updated_at = datetime('now', 'localtime')
        WHERE id = ? AND (delivered_quantity + ?) <= quantity AND status != 'cancelado'
      `).run(qtyDeliver, newStatus, newPaymentStatus, newPaymentDate, ticket.id, qtyDeliver);

      if (updateRun.changes === 0) {
        return { 
          status: 409, 
          data: { error: 'Conflito de concorrência: porção já retirada em outro smartphone/balcão!' } 
        };
      }

      // 3. Registra na tabela de auditoria de entregas
      db.prepare(`
        INSERT INTO deliveries (ticket_id, ticket_code, quantity_delivered, delivered_by)
        VALUES (?, ?, ?, ?)
      `).run(ticket.id, ticket.code, qtyDeliver, operator);

      const updatedTicket = db.prepare('SELECT * FROM tickets WHERE id = ?').get(ticket.id);
      const deliveries = db.prepare('SELECT * FROM deliveries WHERE ticket_id = ? ORDER BY id DESC').all(ticket.id);

      return {
        status: 200,
        data: {
          success: true,
          message: `${qtyDeliver} porção(ões) entregue(s) com sucesso!`,
          ticket: updatedTicket,
          deliveries,
          operator,
          qtyDeliver
        }
      };
    })();

    if (result.status === 200) {
      broadcastEvent('ticket_delivered', {
        ticket: result.data.ticket,
        delivered_count: result.data.qtyDeliver,
        remaining: result.data.ticket.quantity - result.data.ticket.delivered_quantity,
        operator: result.data.operator
      });
    }

    return res.status(result.status).json(result.data);
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
      notes,
      sold_by
    } = req.body;

    const newName = buyer_name !== undefined ? buyer_name.trim() : ticket.buyer_name;
    const newPhone = buyer_phone !== undefined ? buyer_phone.trim() : ticket.buyer_phone;
    const newQty = quantity !== undefined ? Math.max(1, parseInt(quantity, 10)) : ticket.quantity;
    
    let newDelivered = delivered_quantity !== undefined ? Math.max(0, parseInt(delivered_quantity, 10)) : ticket.delivered_quantity;
    if (newDelivered > newQty) {
      newDelivered = newQty;
    }

    const newTotalPrice = newQty * ticket.unit_price;
    const newPayMethod = payment_method !== undefined ? payment_method : (ticket.payment_method || 'dinheiro');
    const newPayStatus = payment_status !== undefined ? payment_status : ticket.payment_status;
    const newPayDate = payment_date !== undefined ? payment_date : (ticket.payment_date || '');
    const newNotes = notes !== undefined ? notes.trim() : ticket.notes;
    const newSoldBy = sold_by !== undefined ? sold_by.trim() : (ticket.sold_by || 'Administração');

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
          sold_by = ?,
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
      newSoldBy,
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

// Excluir Permanentemente um Ticket Individual (Purge protegido por PIN de admin)
app.delete('/api/tickets/:code/purge', requireAdminPin, (req, res) => {
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

// Limpeza em Lote de Vales (Purge Bulk protegido por PIN de admin)
app.post('/api/tickets/purge-bulk', requireAdminPin, (req, res) => {
  try {
    const { target } = req.body;
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

// Exportar CSV completo para prestação de contas com operador e entregador
app.get('/api/export/csv', (req, res) => {
  try {
    const tickets = db.prepare('SELECT * FROM tickets ORDER BY id ASC').all();
    const config = db.prepare("SELECT value FROM config WHERE key = 'currency_symbol'").get();
    const symbol = config?.value || '¥';
    
    let csv = `ID;Codigo;Canal de Venda;Vendedor / Smartphone;Nome Comprador;Telefone;Qtd Vendida;Qtd Entregue;Preco Total (${symbol});Data Pagamento;Forma Pagamento;Status Pagamento;Status Ticket;Criado Em;Atualizado Em;Observacoes\n`;
    
    tickets.forEach(t => {
      const canalLabel = t.sale_channel === 'balcao' ? 'Balcão' : 'Antecipado';
      csv += `${t.id};"${t.code}";"${canalLabel}";"${(t.sold_by || 'Administração').replace(/"/g, '""')}";"${t.buyer_name.replace(/"/g, '""')}";"${t.buyer_phone}";${t.quantity};${t.delivered_quantity};${Math.round(t.total_price)};"${t.payment_date || ''}";"${t.payment_method || 'dinheiro'}";"${t.payment_status}";"${t.status}";"${t.created_at}";"${t.updated_at}";"${(t.notes || '').replace(/"/g, '""')}"\n`;
    });

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename=relatorio-feijoada-tickets-japao.csv');
    res.send('\uFEFF' + csv);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Exportar Relatório de Fechamento de Caixa Unificado do Evento
app.get('/api/export/cashflow-csv', (req, res) => {
  try {
    const configSymbol = db.prepare("SELECT value FROM config WHERE key = 'currency_symbol'").get()?.value || '¥';
    const eventName = db.prepare("SELECT value FROM config WHERE key = 'event_name'").get()?.value || 'Feijoada';
    const eventDate = db.prepare("SELECT value FROM config WHERE key = 'event_date'").get()?.value || '';

    const summary = db.prepare(`
      SELECT 
        COUNT(id) as total_tickets,
        COALESCE(SUM(quantity), 0) as total_feijoadas,
        COALESCE(SUM(delivered_quantity), 0) as total_delivered,
        COALESCE(SUM(CASE WHEN payment_status = 'pago' THEN total_price ELSE 0 END), 0) as total_collected,
        COALESCE(SUM(CASE WHEN payment_status = 'pago' AND payment_method = 'dinheiro' THEN total_price ELSE 0 END), 0) as confirmed_cash,
        COALESCE(SUM(CASE WHEN payment_status = 'pago' AND payment_method != 'dinheiro' THEN total_price ELSE 0 END), 0) as confirmed_digital,
        COALESCE(SUM(CASE WHEN payment_status = 'pendente' THEN total_price ELSE 0 END), 0) as pending_amount
      FROM tickets 
      WHERE status != 'cancelado'
    `).get();

    const byOperator = db.prepare(`
      SELECT 
        COALESCE(NULLIF(sold_by, ''), 'Administração') as operator,
        COUNT(id) as tickets_count,
        SUM(quantity) as feijoadas_count,
        SUM(CASE WHEN payment_status = 'pago' AND payment_method = 'dinheiro' THEN total_price ELSE 0 END) as cash_collected,
        SUM(CASE WHEN payment_status = 'pago' AND payment_method != 'dinheiro' THEN total_price ELSE 0 END) as digital_collected,
        SUM(CASE WHEN payment_status = 'pago' THEN total_price ELSE 0 END) as total_collected,
        SUM(CASE WHEN payment_status = 'pendente' THEN total_price ELSE 0 END) as pending_amount
      FROM tickets 
      WHERE status != 'cancelado'
      GROUP BY COALESCE(NULLIF(sold_by, ''), 'Administração')
      ORDER BY total_collected DESC
    `).all();

    let csv = `RELATORIO DE FECHAMENTO DE CAIXA UNIFICADO - ${eventName.toUpperCase()}\n`;
    csv += `Data do Evento:;${eventDate};Gerado em:;${new Date().toLocaleString('pt-BR')}\n\n`;

    csv += `--- RESUMO GERAL DO CAIXA ---\n`;
    csv += `Total Arrecadado Confirmado (${configSymbol}):;${Math.round(summary.total_collected || 0)}\n`;
    csv += `Dinheiro Fisico em Caixa (${configSymbol}):;${Math.round(summary.confirmed_cash || 0)}\n`;
    csv += `Pagamentos Digitais (PayPay/PIX) (${configSymbol}):;${Math.round(summary.confirmed_digital || 0)}\n`;
    csv += `Valores Pendentes a Receber (${configSymbol}):;${Math.round(summary.pending_amount || 0)}\n`;
    csv += `Total de Feijoadas Vendidas:;${summary.total_feijoadas || 0}\n`;
    csv += `Total de Feijoadas Entregues:;${summary.total_delivered || 0}\n`;
    csv += `Feijoadas Pendentes de Retirada:;${Math.max(0, (summary.total_feijoadas || 0) - (summary.total_delivered || 0))}\n\n`;

    csv += `--- PRESTACAO DE CONTAS INDIVIDUAL POR COLABORADOR / SMARTPHONE ---\n`;
    csv += `Colaborador / Smartphone;Qtd Vendas;Feijoadas Vendidas;Dinheiro em Especie (${configSymbol});Digital (${configSymbol});Total Arrecadado (${configSymbol});Pendente (${configSymbol})\n`;
    byOperator.forEach(op => {
      csv += `"${op.operator.replace(/"/g, '""')}";${op.tickets_count};${op.feijoadas_count};${Math.round(op.cash_collected)};${Math.round(op.digital_collected)};${Math.round(op.total_collected)};${Math.round(op.pending_amount)}\n`;
    });

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename=fechamento-caixa-feijoada.csv');
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
