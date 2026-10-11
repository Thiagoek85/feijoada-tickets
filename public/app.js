// Estado da aplicação
let html5QrCode = null;
let isScannerRunning = false;
let currentTicketData = null;
let currentCreatedTicket = null;
let eventConfig = {
  unit_price: 1000,
  currency_symbol: '¥',
  event_name: 'Feijoada Comunitária da Paróquia',
  https_port: 3443,
  http_port: 3000
};

// Base path detection para suporte a Tailscale Funnel (/feijoada) ou acesso local
const BASE_PATH = window.location.pathname.startsWith('/feijoada') ? '/feijoada' : '';

// Feedback Háptico / Vibração Tátil para Android e iOS
function triggerHaptic(type = 'light') {
  try {
    if ('vibrate' in navigator) {
      if (type === 'light') navigator.vibrate(25);
      else if (type === 'success') navigator.vibrate([40, 50, 60]);
      else if (type === 'error') navigator.vibrate([160, 80, 160]);
    }
  } catch (e) {
    // silencioso se não suportado
  }
}

// Web Audio API para sons de confirmação e erro estilo iOS
const audioCtx = new (window.AudioContext || window.webkitAudioContext)();

function playSuccessSound() {
  triggerHaptic('success');
  try {
    if (audioCtx.state === 'suspended') audioCtx.resume();
    const now = audioCtx.currentTime;
    
    const osc1 = audioCtx.createOscillator();
    const gain1 = audioCtx.createGain();
    osc1.type = 'sine';
    osc1.frequency.setValueAtTime(587.33, now); // D5
    gain1.gain.setValueAtTime(0.3, now);
    gain1.gain.exponentialRampToValueAtTime(0.01, now + 0.15);
    osc1.connect(gain1);
    gain1.connect(audioCtx.destination);
    osc1.start(now);
    osc1.stop(now + 0.15);

    const osc2 = audioCtx.createOscillator();
    const gain2 = audioCtx.createGain();
    osc2.type = 'sine';
    osc2.frequency.setValueAtTime(880, now + 0.15); // A5
    gain2.gain.setValueAtTime(0.35, now + 0.15);
    gain2.gain.exponentialRampToValueAtTime(0.01, now + 0.35);
    osc2.connect(gain2);
    gain2.connect(audioCtx.destination);
    osc2.start(now + 0.15);
    osc2.stop(now + 0.35);
  } catch (e) {
    console.warn('Audio not supported or blocked', e);
  }
}

function playErrorSound() {
  triggerHaptic('error');
  try {
    if (audioCtx.state === 'suspended') audioCtx.resume();
    const now = audioCtx.currentTime;
    
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(220, now);
    osc.frequency.linearRampToValueAtTime(140, now + 0.35);
    gain.gain.setValueAtTime(0.4, now);
    gain.gain.exponentialRampToValueAtTime(0.01, now + 0.4);
    osc.connect(gain);
    gain.connect(audioCtx.destination);
    osc.start(now);
    osc.stop(now + 0.4);
  } catch (e) {
    console.warn('Audio error', e);
  }
}

// Formatação monetária (Ienes ¥)
function formatMoney(amount) {
  const sym = eventConfig.currency_symbol || '¥';
  const val = Math.round(Number(amount) || 0);
  return `${sym} ${val.toLocaleString('ja-JP')}`;
}

// Inicialização ao carregar
document.addEventListener('DOMContentLoaded', () => {
  setupDockNavigation();
  loadConfig();
  loadStats();
  loadTickets();
  setupScanner();
  setupSalesForm();
  setupEditForm();
  setupSSE();
});

// ==================== DOCK INFERIOR ESTILO IPHONE ====================
function setupDockNavigation() {
  const dockItems = document.querySelectorAll('.dock-item');
  const tabPanes = document.querySelectorAll('.tab-pane');

  dockItems.forEach(item => {
    item.addEventListener('click', () => {
      const targetId = item.getAttribute('data-tab');

      dockItems.forEach(d => d.classList.remove('active'));
      tabPanes.forEach(p => p.classList.remove('active'));

      item.classList.add('active');
      const targetPane = document.getElementById(targetId);
      if (targetPane) targetPane.classList.add('active');

      if (targetId === 'tab-dashboard') {
        loadStats();
      } else if (targetId === 'tab-list') {
        loadTickets();
      }
    });
  });
}

function switchTab(tabId) {
  const dockBtn = document.querySelector(`.dock-item[data-tab="${tabId}"]`);
  if (dockBtn) dockBtn.click();
}

// Carregar Configurações
async function loadConfig() {
  try {
    const res = await fetch(BASE_PATH + '/api/config');
    const data = await res.json();
    eventConfig = { ...eventConfig, ...data };
    document.getElementById('app-event-name').textContent = eventConfig.event_name || 'Vale Feijoada';
    updateSalesTotal();
  } catch (e) {
    console.error('Erro ao carregar configurações:', e);
  }
}

// Configurar SSE (Server-Sent Events)
function setupSSE() {
  try {
    const evtSource = new EventSource(BASE_PATH + '/api/events');
    evtSource.onmessage = (event) => {
      const parsed = JSON.parse(event.data);
      if (['ticket_delivered', 'ticket_created', 'ticket_updated', 'batch_created'].includes(parsed.type)) {
        loadStats();
        if (document.getElementById('tab-list').classList.contains('active')) {
          loadTickets();
        }
      }
    };
  } catch (e) {
    console.warn('SSE falhou ou não suportado:', e);
  }
}

// ==================== ABA 1: ADICIONAR COMPRA (NOVA VENDA) ====================
function setupSalesForm() {
  const form = document.getElementById('form-new-ticket');
  const qtyHidden = document.getElementById('ticket_quantity');
  const stepperDisplay = document.getElementById('stepper-display');
  const btnMinus = document.getElementById('btn-qty-minus');
  const btnPlus = document.getElementById('btn-qty-plus');
  const qtyChips = document.querySelectorAll('.qty-chip');
  const paymentChips = document.querySelectorAll('.payment-chip');
  const methodHidden = document.getElementById('payment_method');
  const successBox = document.getElementById('ticket-success-box');
  const btnNewSaleReset = document.getElementById('btn-new-sale-reset');

  // Controle de quantidade Stepper (-) e (+)
  btnMinus.addEventListener('click', () => {
    let current = parseInt(qtyHidden.value, 10) || 1;
    if (current > 1) {
      current--;
      triggerHaptic('light');
      setQuantity(current);
    }
  });

  btnPlus.addEventListener('click', () => {
    let current = parseInt(qtyHidden.value, 10) || 1;
    if (current < 100) {
      current++;
      triggerHaptic('light');
      setQuantity(current);
    }
  });

  // Atalhos de quantidade (chips)
  qtyChips.forEach(chip => {
    chip.addEventListener('click', () => {
      triggerHaptic('light');
      const qty = parseInt(chip.getAttribute('data-qty'), 10);
      setQuantity(qty);
    });
  });

  function setQuantity(val) {
    qtyHidden.value = val;
    stepperDisplay.textContent = val;
    qtyChips.forEach(c => {
      const chipQty = parseInt(c.getAttribute('data-qty'), 10);
      c.classList.toggle('active', chipQty === val);
    });
    updateSalesTotal();
  }

  // Seletor de forma de pagamento
  paymentChips.forEach(chip => {
    chip.addEventListener('click', () => {
      triggerHaptic('light');
      paymentChips.forEach(c => c.classList.remove('active'));
      chip.classList.add('active');
      methodHidden.value = chip.getAttribute('data-method');
    });
  });

  // Submissão da Nova Compra
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btnSubmit = document.getElementById('btn-submit-sale');
    btnSubmit.disabled = true;
    btnSubmit.innerHTML = '<span>⏳ Registrando Compra...</span>';

    const payload = {
      buyer_name: document.getElementById('buyer_name').value.trim(),
      buyer_phone: document.getElementById('buyer_phone').value.trim(),
      quantity: parseInt(qtyHidden.value, 10) || 1,
      payment_method: methodHidden.value,
      payment_status: 'pago',
      notes: document.getElementById('ticket_notes').value.trim()
    };

    try {
      const res = await fetch(BASE_PATH + '/api/tickets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const data = await res.json();

      if (res.ok) {
        playSuccessSound();
        currentCreatedTicket = data.ticket;
        showSuccessTicket(data.ticket, data.qr_code);
        loadStats();
      } else {
        alert(`Erro: ${data.error || 'Falha ao registrar compra'}`);
      }
    } catch (err) {
      alert('Erro de conexão ao registrar compra');
    } finally {
      btnSubmit.disabled = false;
      btnSubmit.innerHTML = '<span>🍲 CONFIRMAR COMPRA & GERAR VALE</span>';
    }
  });

  // Exibir o QR Code gerado diretamente na tela após a compra
  function showSuccessTicket(ticket, qrCodeUrl) {
    form.style.display = 'none';
    successBox.style.display = 'block';

    document.getElementById('success-qr-img').src = qrCodeUrl;
    document.getElementById('success-code').textContent = ticket.code;
    document.getElementById('success-buyer').textContent = ticket.buyer_name;
    document.getElementById('success-qty').textContent = `${ticket.quantity} Porção(ões) • ${formatMoney(ticket.total_price)}`;

    const ticketUrl = `${window.location.origin}${BASE_PATH}/ticket/${ticket.code}`;
    document.getElementById('btn-open-ticket-direct').href = ticketUrl;

    // Enviar no WhatsApp
    document.getElementById('btn-share-whatsapp-direct').onclick = () => {
      shareWhatsApp(ticket, ticketUrl);
    };
  }

  // Botão para Adicionar Outra Compra
  btnNewSaleReset.addEventListener('click', () => {
    form.reset();
    setQuantity(1);
    form.style.display = 'block';
    successBox.style.display = 'none';
    document.getElementById('buyer_name').focus();
  });
}

function updateSalesTotal() {
  const qty = parseInt(document.getElementById('ticket_quantity')?.value, 10) || 1;
  const unitPrice = parseFloat(eventConfig.unit_price) || 1000;
  const total = qty * unitPrice;
  const label = document.getElementById('calculated-total');
  if (label) label.textContent = formatMoney(total);
}

// Compartilhamento no WhatsApp com formatação Japão/Brasil
function shareWhatsApp(ticket, ticketUrl) {
  const text = encodeURIComponent(
    `🍲 Olá ${ticket.buyer_name}!\n\n` +
    `Aqui está o seu *Vale Feijoada da Comunidade Católica*!\n` +
    `*Código:* ${ticket.code}\n` +
    `*Quantidade:* ${ticket.quantity} porção(ões)\n` +
    `*Valor:* ${formatMoney(ticket.total_price)}\n\n` +
    `📲 Acesse seu vale digital e apresente o QR Code no balcão de retirada:\n${ticketUrl}\n\n` +
    `Deus abençoe pela colaboração!`
  );

  let rawPhone = (ticket.buyer_phone || '').replace(/\D/g, '');
  let finalPhone = '';

  if (rawPhone.length > 0) {
    if (rawPhone.startsWith('090') || rawPhone.startsWith('080') || rawPhone.startsWith('070')) {
      finalPhone = '81' + rawPhone.substring(1);
    } else if (rawPhone.startsWith('81')) {
      finalPhone = rawPhone;
    } else if (rawPhone.length === 10 || rawPhone.length === 11) {
      finalPhone = '55' + rawPhone;
    } else {
      finalPhone = rawPhone;
    }
  }

  const waUrl = finalPhone 
    ? `https://api.whatsapp.com/send?phone=${finalPhone}&text=${text}`
    : `https://api.whatsapp.com/send?text=${text}`;

  window.open(waUrl, '_blank');
}

// ==================== ABA 2: LEITOR QR CODE (SCANNER) ====================
function setupScanner() {
  const toggleBtn = document.getElementById('btn-toggle-camera');
  const manualBtn = document.getElementById('btn-manual-validate');
  const manualInput = document.getElementById('manual-code-input');
  const cameraInput = document.getElementById('qr-camera-capture');
  const fileInput = document.getElementById('qr-file-upload');
  const deliverBtn = document.getElementById('btn-confirm-delivery');

  toggleBtn.addEventListener('click', () => {
    if (isScannerRunning) {
      stopScanner();
    } else {
      startScanner();
    }
  });

  // Leitura Instantânea por Foto
  cameraInput.addEventListener('change', handleImageFileScan);
  fileInput.addEventListener('change', handleImageFileScan);

  // Validação manual
  manualBtn.addEventListener('click', () => {
    const code = manualInput.value.trim();
    if (code) validateCode(code);
  });

  manualInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') {
      const code = manualInput.value.trim();
      if (code) validateCode(code);
    }
  });

  deliverBtn.addEventListener('click', confirmDelivery);
}

function ensureHtml5QrInstance() {
  if (typeof Html5Qrcode !== 'undefined' && !html5QrCode) {
    html5QrCode = new Html5Qrcode("reader");
  }
}

async function handleImageFileScan(e) {
  const file = e.target.files && e.target.files[0];
  if (!file) return;

  ensureHtml5QrInstance();
  const statusEl = document.getElementById('scanner-status-text');
  statusEl.innerHTML = '⏳ <strong>Analisando imagem do QR Code...</strong>';

  try {
    const decodedText = await html5QrCode.scanFile(file, true);
    statusEl.innerHTML = '✅ QR Code lido com sucesso!';
    onScanSuccess(decodedText);
  } catch (err) {
    statusEl.innerHTML = '❌ <strong>Não foi possível identificar o QR Code na foto.</strong> Tente aproximar mais a câmera.';
    playErrorSound();
  } finally {
    e.target.value = '';
  }
}

function startScanner() {
  ensureHtml5QrInstance();
  if (!html5QrCode) return;

  const qrConfig = { fps: 10, qrbox: { width: 250, height: 250 } };
  const statusEl = document.getElementById('scanner-status-text');

  html5QrCode.start(
    { facingMode: "environment" },
    qrConfig,
    onScanSuccess,
    () => {}
  ).then(() => {
    isScannerRunning = true;
    document.getElementById('btn-toggle-camera').textContent = '⏹️ Pausar Câmera';
    statusEl.textContent = '🎥 Câmera ativa. Aponte para o QR Code.';
  }).catch(err => {
    isScannerRunning = false;
    document.getElementById('btn-toggle-camera').textContent = '🎥 Vídeo Contínuo';
    statusEl.innerHTML = `
      <span style="color:#dc2626;">Acesso ao vídeo bloqueado neste link.</span> Toque no botão grande <strong>"📸 TIRAR FOTO"</strong> acima para ler instantaneamente!
    `;
  });
}

function stopScanner() {
  if (html5QrCode && isScannerRunning) {
    html5QrCode.stop().then(() => {
      isScannerRunning = false;
      document.getElementById('btn-toggle-camera').textContent = '🎥 Vídeo Contínuo';
      document.getElementById('scanner-status-text').textContent = 'Câmera pausada.';
    }).catch(err => console.error(err));
  }
}

let lastScanTime = 0;
let lastScannedCode = '';

function onScanSuccess(decodedText) {
  const now = Date.now();
  if (decodedText === lastScannedCode && (now - lastScanTime) < 2000) return;
  lastScanTime = now;
  lastScannedCode = decodedText;

  let code = decodedText.trim();
  if (code.includes('/ticket/')) {
    code = code.split('/ticket/')[1].split('?')[0].split('/')[0];
  }

  document.getElementById('manual-code-input').value = code;
  validateCode(code);
}

// Validar código com a API
async function validateCode(code) {
  const resultCard = document.getElementById('scan-result');
  const badge = document.getElementById('scan-badge');
  const buyerEl = document.getElementById('scan-buyer-name');
  const qtyEl = document.getElementById('scan-qty');
  const detailsEl = document.getElementById('scan-details');
  const actionContainer = document.getElementById('scan-action-container');

  resultCard.style.display = 'block';
  resultCard.className = 'scan-feedback-glass';

  try {
    const res = await fetch(`${BASE_PATH}/api/tickets/${encodeURIComponent(code)}/validate`, {
      method: 'POST'
    });
    const data = await res.json();

    if (res.status === 200 && data.valid) {
      // ✅ TICKET VÁLIDO E PRONTO
      currentTicketData = data.ticket;
      playSuccessSound();

      resultCard.classList.add('success');
      badge.style.background = '#22c55e';
      badge.style.color = 'white';
      badge.textContent = '✅ VÁLIDO PARA RETIRADA';

      buyerEl.textContent = data.ticket.buyer_name;
      const rem = data.remaining_quantity;
      qtyEl.textContent = `${rem} Porção(ões) a Retirar`;

      detailsEl.innerHTML = `
        Código: <strong>${data.ticket.code}</strong> • Tel: <strong>${data.ticket.buyer_phone || 'Não informado'}</strong><br>
        Pagamento: <strong>${data.ticket.payment_status.toUpperCase()} (${data.ticket.payment_method.toUpperCase()})</strong><br>
        ${data.ticket.notes ? `Obs: <em>${escapeHtml(data.ticket.notes)}</em><br>` : ''}
        ${data.ticket.delivered_quantity > 0 ? `<span style="color: #92400e;">⚠️ Atenção: ${data.ticket.delivered_quantity} porção(ões) já foram retiradas anteriormente.</span>` : ''}
      `;

      actionContainer.innerHTML = `
        <button type="button" id="btn-confirm-delivery" class="btn-glass btn-success-glass btn-large-hero">
          🍲 CONFIRMAR ENTREGA DE ${rem} PORÇÃO(ÕES)
        </button>
      `;
      document.getElementById('btn-confirm-delivery').addEventListener('click', confirmDelivery);

    } else if (data.already_delivered || data.status === 'entregue') {
      // 🔴 JÁ UTILIZADO / BLOQUEADO
      currentTicketData = null;
      playErrorSound();

      resultCard.classList.add('danger');
      badge.style.background = '#ef4444';
      badge.style.color = 'white';
      badge.textContent = '⚠️ ALERTA: JÁ UTILIZADO!';

      buyerEl.textContent = data.ticket ? data.ticket.buyer_name : 'Vale Feijoada';
      qtyEl.textContent = `Todas as ${data.ticket?.quantity || 1} porções JÁ FORAM ENTREGUES!`;

      const lastDel = data.last_delivery;
      detailsEl.innerHTML = `
        <strong style="color: #b91c1c; font-size: 1.05rem;">❌ ESTE TICKET JÁ FOI BAIXADO!</strong><br>
        ${lastDel ? `Retirado em: <strong>${lastDel.delivered_at}</strong> por <strong>${lastDel.delivered_by}</strong>` : ''}<br>
        Código: <strong>${code}</strong>
      `;

      actionContainer.innerHTML = `
        <button type="button" class="btn-glass btn-secondary-glass" style="opacity: 0.6; cursor: not-allowed;" disabled>
          ⛔ ENTREGA BLOQUEADA (TICKET ESGOTADO)
        </button>
      `;

    } else {
      // ⚠️ INVÁLIDO
      currentTicketData = null;
      playErrorSound();

      resultCard.classList.add('danger');
      badge.style.background = '#f59e0b';
      badge.style.color = 'white';
      badge.textContent = '❌ CÓDIGO INVÁLIDO';

      buyerEl.textContent = 'Não Encontrado';
      qtyEl.textContent = 'Código inexistente no sistema';
      detailsEl.innerHTML = `O código <strong>"${escapeHtml(code)}"</strong> não foi cadastrado.`;

      actionContainer.innerHTML = '';
    }

  } catch (err) {
    playErrorSound();
    resultCard.classList.add('danger');
    badge.textContent = 'ERRO DE CONEXÃO';
    buyerEl.textContent = 'Erro ao verificar';
    detailsEl.textContent = 'Verifique a conexão com o servidor local.';
    actionContainer.innerHTML = '';
  }
}

// Confirmar Baixa
async function confirmDelivery() {
  if (!currentTicketData) return;

  const btn = document.getElementById('btn-confirm-delivery');
  btn.disabled = true;
  btn.innerHTML = '<span>⏳ Registrando...</span>';

  try {
    const res = await fetch(`${BASE_PATH}/api/tickets/${encodeURIComponent(currentTicketData.code)}/deliver`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        quantity_to_deliver: currentTicketData.quantity - currentTicketData.delivered_quantity,
        delivered_by: 'Balcão de Entrega'
      })
    });

    const data = await res.json();
    if (res.ok) {
      playSuccessSound();
      const resultCard = document.getElementById('scan-result');
      resultCard.className = 'scan-feedback-glass success';

      document.getElementById('scan-badge').textContent = '🎉 ENTREGA CONCLUÍDA!';
      document.getElementById('scan-qty').textContent = 'Feijoada liberada com sucesso!';
      document.getElementById('scan-details').innerHTML = `
        Entregue para: <strong>${escapeHtml(data.ticket.buyer_name)}</strong><br>
        Horário: <strong>${new Date().toLocaleTimeString('pt-BR')}</strong><br>
        Estoque e fila da cozinha atualizados!
      `;

      document.getElementById('scan-action-container').innerHTML = `
        <button type="button" class="btn-glass btn-primary-glass" onclick="resetScannerResult()">
          ➡️ Próxima Leitura
        </button>
      `;

      currentTicketData = null;
      loadStats();
    } else {
      alert(`Erro: ${data.error || 'Não foi possível efetuar a entrega'}`);
      btn.disabled = false;
      btn.textContent = 'Tentar Novamente';
    }
  } catch (e) {
    alert('Erro de conexão ao registrar entrega');
    btn.disabled = false;
    btn.textContent = 'Tentar Novamente';
  }
}

function resetScannerResult() {
  document.getElementById('scan-result').style.display = 'none';
  document.getElementById('manual-code-input').value = '';
  currentTicketData = null;
}

// ==================== ABA 3: LOGÍSTICA & COZINHA (DASHBOARD) ====================
async function loadStats() {
  try {
    const res = await fetch(BASE_PATH + '/api/stats');
    const data = await res.json();

    document.getElementById('dash-total-qty').textContent = data.total_feijoadas;
    document.getElementById('dash-total-tickets').textContent = `${data.total_tickets} vales emitidos`;

    document.getElementById('dash-delivered-qty').textContent = data.total_delivered;
    document.getElementById('dash-delivered-pct').textContent = `${data.completion_percentage}% entregue`;

    document.getElementById('dash-pending-qty').textContent = data.pending_feijoadas;
    document.getElementById('dash-revenue').textContent = formatMoney(data.total_revenue);

    const bar = document.getElementById('dash-progress-bar');
    const label = document.getElementById('dash-progress-label');
    const pct = `${data.completion_percentage}%`;
    bar.style.width = pct;
    label.textContent = `${data.total_delivered} de ${data.total_feijoadas} porções (${pct})`;

    // Feed de entregas recentes
    const feed = document.getElementById('recent-deliveries-list');
    if (data.recent_deliveries && data.recent_deliveries.length > 0) {
      feed.innerHTML = data.recent_deliveries.map(d => `
        <div style="background: rgba(255,255,255,0.7); padding: 10px 14px; border-radius: 14px; display: flex; justify-content: space-between; align-items: center; border: 1px solid rgba(255,255,255,0.8);">
          <div>
            <div style="font-weight: 800; font-size: 0.95rem; color: #1c1917;">${escapeHtml(d.buyer_name)}</div>
            <div style="font-size: 0.75rem; color: var(--text-muted);">${d.delivered_at.split(' ')[1] || d.delivered_at} • Código: <strong>${d.ticket_code}</strong></div>
          </div>
          <div style="font-weight: 800; font-size: 0.95rem; color: #16a34a;">
            +${d.quantity_delivered} porção(ões)
          </div>
        </div>
      `).join('');
    } else {
      feed.innerHTML = `<div style="text-align: center; color: var(--text-muted); padding: 20px;">Nenhuma saída registrada ainda hoje.</div>`;
    }
  } catch (e) {
    console.error('Erro ao carregar estatísticas:', e);
  }
}

document.getElementById('btn-refresh-stats').addEventListener('click', loadStats);

// ==================== ABA 4: VALES & QR CODES (GESTÃO) ====================
async function loadTickets() {
  const searchInput = document.getElementById('filter-search');
  const search = searchInput ? searchInput.value.trim() : '';
  const container = document.getElementById('tickets-cards-container');

  try {
    let url = `${BASE_PATH}/api/tickets?status=todos`;
    if (search) url += `&search=${encodeURIComponent(search)}`;

    const res = await fetch(url);
    const tickets = await res.json();

    if (!tickets || tickets.length === 0) {
      container.innerHTML = `<div style="text-align: center; color: var(--text-muted); padding: 24px;">Nenhum vale encontrado.</div>`;
      return;
    }

    container.innerHTML = tickets.map(t => {
      const isDone = t.status === 'entregue';
      const badgeClass = isDone ? 'badge-entregue' : 'badge-ativo';
      const badgeText = isDone ? 'ENTREGUE' : 'PENDENTE';

      return `
        <div class="ticket-item-glass">
          <div class="ticket-item-info">
            <div style="display: flex; align-items: center; gap: 8px;">
              <span class="ticket-item-name">${escapeHtml(t.buyer_name)}</span>
              <span class="ticket-item-badge ${badgeClass}">${badgeText}</span>
            </div>
            <div class="ticket-item-meta">
              Código: <strong style="color: #c2410c;">${t.code}</strong> • 
              <strong>${t.quantity} porção(ões)</strong> • ${formatMoney(t.total_price)}
            </div>
            ${t.buyer_phone ? `<div style="font-size: 0.75rem; color: var(--text-light); margin-top: 2px;">📱 ${escapeHtml(t.buyer_phone)}</div>` : ''}
          </div>

          <!-- Botões Rápidos de Ação: Ver QR e Ajustar -->
          <div style="display: flex; gap: 6px; flex-shrink: 0;">
            <button type="button" class="btn-glass btn-primary-glass" style="width: auto; min-height: 42px; padding: 0 12px; font-size: 0.8rem;" onclick="viewTicketQr('${t.code}')">
              👁️ QR
            </button>
            <button type="button" class="btn-glass btn-secondary-glass" style="width: auto; min-height: 42px; padding: 0 12px; font-size: 0.8rem;" onclick="openEditTab('${t.code}')">
              ✏️ Ajustar
            </button>
          </div>
        </div>
      `;
    }).join('');

  } catch (e) {
    console.error('Erro ao listar tickets:', e);
  }
}

// Visualizar qualquer QR Code no modal
async function viewTicketQr(code) {
  try {
    const res = await fetch(`${BASE_PATH}/api/tickets/${encodeURIComponent(code)}`);
    if (!res.ok) return alert('Vale não encontrado');
    const ticket = await res.json();

    const modal = document.getElementById('ticket-modal');
    document.getElementById('modal-qr-image').src = ticket.qr_code;
    document.getElementById('modal-code').textContent = ticket.code;
    document.getElementById('modal-buyer').textContent = ticket.buyer_name;
    document.getElementById('modal-qty').textContent = `${ticket.quantity} Porção(ões) • ${formatMoney(ticket.total_price)}`;

    const ticketUrl = `${window.location.origin}${BASE_PATH}/ticket/${ticket.code}`;
    document.getElementById('btn-open-ticket-link').href = ticketUrl;

    document.getElementById('btn-share-whatsapp').onclick = () => {
      shareWhatsApp(ticket, ticketUrl);
    };

    document.getElementById('btn-download-qr').onclick = () => {
      const a = document.createElement('a');
      a.href = ticket.qr_code;
      a.download = `QR-Feijoada-${ticket.code}.png`;
      a.click();
    };

    modal.classList.add('active');
  } catch (e) {
    alert('Erro ao carregar detalhes do vale');
  }
}

document.getElementById('btn-close-modal').addEventListener('click', () => {
  document.getElementById('ticket-modal').classList.remove('active');
});

// Fechar modal ao clicar fora
document.getElementById('ticket-modal').addEventListener('click', (e) => {
  if (e.target === document.getElementById('ticket-modal')) {
    document.getElementById('ticket-modal').classList.remove('active');
  }
});

const searchFilterEl = document.getElementById('filter-search');
if (searchFilterEl) {
  searchFilterEl.addEventListener('input', () => {
    loadTickets();
  });
}

function escapeHtml(text) {
  if (!text) return '';
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// ==================== ABA 5: AJUSTES / EDIÇÃO DE VALE ====================
let currentEditTicket = null;

function openEditTab(code) {
  triggerHaptic('light');
  switchTab('tab-edit');
  const searchInput = document.getElementById('edit-search-input');
  if (searchInput) searchInput.value = code;
  loadTicketToEdit(code);
}

async function loadTicketToEdit(codeOrQuery) {
  if (!codeOrQuery) return;
  const cleanCode = codeOrQuery.trim().toUpperCase();

  try {
    const res = await fetch(`${BASE_PATH}/api/tickets/${encodeURIComponent(cleanCode)}`);
    if (!res.ok) {
      alert(`Vale "${cleanCode}" não encontrado.`);
      return;
    }
    const ticket = await res.json();
    populateEditForm(ticket);
  } catch (err) {
    console.error('Erro ao buscar ticket para edição:', err);
    alert('Erro ao carregar dados do vale.');
  }
}

function populateEditForm(ticket) {
  currentEditTicket = ticket;

  // Atualizar visibilidade dos containers
  document.getElementById('edit-empty-state').style.display = 'none';
  const formContainer = document.getElementById('edit-form-container');
  formContainer.style.display = 'block';

  // Badges e Header
  document.getElementById('edit-badge-code').textContent = ticket.code;
  const badgeStatus = document.getElementById('edit-badge-status');
  badgeStatus.textContent = (ticket.status || 'ativo').toUpperCase();
  badgeStatus.className = `ticket-item-badge badge-${ticket.status || 'ativo'}`;

  // Campos básicos
  document.getElementById('edit-buyer-name').value = ticket.buyer_name || '';
  document.getElementById('edit-buyer-phone').value = ticket.buyer_phone || '';
  document.getElementById('edit-notes').value = ticket.notes || '';

  // ENTRADA: Quantidade comprada
  setEditQuantity(ticket.quantity || 1);

  // SAÍDA: Quantidade entregue
  setEditDelivered(ticket.delivered_quantity || 0);

  // PAGAMENTO: Status (pago / pendente)
  setEditPaymentStatus(ticket.payment_status || 'pago');

  // PAGAMENTO: Forma (dinheiro, paypay, transferencia, cartao)
  setEditPaymentMethod(ticket.payment_method || 'dinheiro');

  formContainer.scrollIntoView({ behavior: 'smooth' });
}

function setEditQuantity(qty) {
  const q = Math.max(1, parseInt(qty, 10) || 1);
  document.getElementById('edit_ticket_quantity').value = q;
  document.getElementById('edit-qty-display').textContent = q;

  const unitPrice = currentEditTicket ? currentEditTicket.unit_price : (eventConfig.unit_price || 1000);
  const total = q * unitPrice;
  document.getElementById('edit-total-preview').textContent = formatMoney(total);

  // Revalidar limite de saída
  const currentDelivered = parseInt(document.getElementById('edit_delivered_quantity').value, 10) || 0;
  if (currentDelivered > q) {
    setEditDelivered(q);
  } else {
    updateEditRemainingPreview();
  }
}

function setEditDelivered(qty) {
  const maxQty = parseInt(document.getElementById('edit_ticket_quantity').value, 10) || 1;
  const d = Math.max(0, Math.min(maxQty, parseInt(qty, 10) || 0));
  document.getElementById('edit_delivered_quantity').value = d;
  document.getElementById('edit-delivered-display').textContent = d;
  updateEditRemainingPreview();
}

function updateEditRemainingPreview() {
  const qty = parseInt(document.getElementById('edit_ticket_quantity').value, 10) || 1;
  const delivered = parseInt(document.getElementById('edit_delivered_quantity').value, 10) || 0;
  const remaining = Math.max(0, qty - delivered);
  const previewEl = document.getElementById('edit-remaining-preview');

  if (remaining === 0) {
    previewEl.textContent = 'Tudo entregue (0 restante)';
    previewEl.style.color = '#15803d';
  } else {
    previewEl.textContent = `Resta ${remaining} porção(ões)`;
    previewEl.style.color = '#d97706';
  }
}

function setEditPaymentStatus(status) {
  document.getElementById('edit_payment_status').value = status;
  const chips = [document.getElementById('chip-status-pago'), document.getElementById('chip-status-pendente')];
  chips.forEach(c => {
    if (!c) return;
    const s = c.getAttribute('data-paystatus');
    c.classList.toggle('active', s === status);
  });
}

function setEditPaymentMethod(method) {
  document.getElementById('edit_payment_method').value = method;
  const chips = document.querySelectorAll('[data-editmethod]');
  chips.forEach(c => {
    const m = c.getAttribute('data-editmethod');
    c.classList.toggle('active', m === method);
  });
}

function setupEditForm() {
  const loadBtn = document.getElementById('btn-edit-load');
  const searchInput = document.getElementById('edit-search-input');
  const form = document.getElementById('form-edit-ticket');

  if (loadBtn && searchInput) {
    loadBtn.addEventListener('click', () => {
      const code = searchInput.value.trim();
      if (code) loadTicketToEdit(code);
    });

    searchInput.addEventListener('keypress', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        const code = searchInput.value.trim();
        if (code) loadTicketToEdit(code);
      }
    });
  }

  // Steppers Entrada (+) e (-)
  const btnQtyMinus = document.getElementById('btn-edit-qty-minus');
  const btnQtyPlus = document.getElementById('btn-edit-qty-plus');
  if (btnQtyMinus && btnQtyPlus) {
    btnQtyMinus.addEventListener('click', () => {
      triggerHaptic('light');
      const cur = parseInt(document.getElementById('edit_ticket_quantity').value, 10) || 1;
      if (cur > 1) setEditQuantity(cur - 1);
    });
    btnQtyPlus.addEventListener('click', () => {
      triggerHaptic('light');
      const cur = parseInt(document.getElementById('edit_ticket_quantity').value, 10) || 1;
      if (cur < 200) setEditQuantity(cur + 1);
    });
  }

  // Steppers Saída (+) e (-)
  const btnDeliveredMinus = document.getElementById('btn-edit-delivered-minus');
  const btnDeliveredPlus = document.getElementById('btn-edit-delivered-plus');
  if (btnDeliveredMinus && btnDeliveredPlus) {
    btnDeliveredMinus.addEventListener('click', () => {
      triggerHaptic('light');
      const cur = parseInt(document.getElementById('edit_delivered_quantity').value, 10) || 0;
      if (cur > 0) setEditDelivered(cur - 1);
    });
    btnDeliveredPlus.addEventListener('click', () => {
      triggerHaptic('light');
      const cur = parseInt(document.getElementById('edit_delivered_quantity').value, 10) || 0;
      setEditDelivered(cur + 1);
    });
  }

  // Botões rápidos de Saída (Zerar ou Marcar Tudo)
  const btnResetDelivered = document.getElementById('btn-edit-reset-delivered');
  const btnCompleteDelivered = document.getElementById('btn-edit-complete-delivered');
  if (btnResetDelivered) {
    btnResetDelivered.addEventListener('click', () => {
      triggerHaptic('light');
      setEditDelivered(0);
    });
  }
  if (btnCompleteDelivered) {
    btnCompleteDelivered.addEventListener('click', () => {
      triggerHaptic('light');
      const totalQty = parseInt(document.getElementById('edit_ticket_quantity').value, 10) || 1;
      setEditDelivered(totalQty);
    });
  }

  // Chips de Status de Pagamento
  const chipStatusPago = document.getElementById('chip-status-pago');
  const chipStatusPendente = document.getElementById('chip-status-pendente');
  if (chipStatusPago && chipStatusPendente) {
    chipStatusPago.addEventListener('click', () => {
      triggerHaptic('light');
      setEditPaymentStatus('pago');
    });
    chipStatusPendente.addEventListener('click', () => {
      triggerHaptic('light');
      setEditPaymentStatus('pendente');
    });
  }

  // Chips de Método de Pagamento
  const methodChips = document.querySelectorAll('[data-editmethod]');
  methodChips.forEach(chip => {
    chip.addEventListener('click', () => {
      triggerHaptic('light');
      const method = chip.getAttribute('data-editmethod');
      setEditPaymentMethod(method);
    });
  });

  // Salvar Alterações
  if (form) {
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (!currentEditTicket) return;

      const btnSave = document.getElementById('btn-save-edit');
      btnSave.disabled = true;
      btnSave.textContent = '⏳ Salvando Alterações...';

      const payload = {
        buyer_name: document.getElementById('edit-buyer-name').value.trim(),
        buyer_phone: document.getElementById('edit-buyer-phone').value.trim(),
        quantity: parseInt(document.getElementById('edit_ticket_quantity').value, 10) || 1,
        delivered_quantity: parseInt(document.getElementById('edit_delivered_quantity').value, 10) || 0,
        payment_status: document.getElementById('edit_payment_status').value,
        payment_method: document.getElementById('edit_payment_method').value,
        notes: document.getElementById('edit-notes').value.trim()
      };

      try {
        const res = await fetch(`${BASE_PATH}/api/tickets/${encodeURIComponent(currentEditTicket.code)}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });

        const data = await res.json();
        if (res.ok) {
          playSuccessSound();
          alert('✅ Vale atualizado com sucesso!');
          currentEditTicket = data.ticket;
          populateEditForm(data.ticket);
          loadStats();
          loadTickets();
        } else {
          playErrorSound();
          alert(`Erro: ${data.error || 'Falha ao atualizar o vale'}`);
        }
      } catch (err) {
        playErrorSound();
        console.error(err);
        alert('Erro de conexão ao salvar alterações.');
      } finally {
        btnSave.disabled = false;
        btnSave.textContent = '💾 SALVAR ALTERAÇÕES DO VALE';
      }
    });
  }

  // Botão Ver QR Code a partir da edição
  const btnViewQr = document.getElementById('btn-view-qr-from-edit');
  if (btnViewQr) {
    btnViewQr.addEventListener('click', () => {
      if (currentEditTicket) {
        viewTicketQr(currentEditTicket.code);
      }
    });
  }

  // Botão Cancelar Vale
  const btnCancel = document.getElementById('btn-cancel-ticket-action');
  if (btnCancel) {
    btnCancel.addEventListener('click', async () => {
      if (!currentEditTicket) return;
      const ok = confirm(`Tem certeza que deseja cancelar o vale ${currentEditTicket.code} de ${currentEditTicket.buyer_name}?`);
      if (!ok) return;

      try {
        const res = await fetch(`${BASE_PATH}/api/tickets/${encodeURIComponent(currentEditTicket.code)}`, {
          method: 'DELETE'
        });
        const data = await res.json();
        if (res.ok) {
          playSuccessSound();
          alert('🗑️ Vale cancelado com sucesso.');
          document.getElementById('edit-badge-status').textContent = 'CANCELADO';
          document.getElementById('edit-badge-status').className = 'ticket-item-badge';
          document.getElementById('edit-badge-status').style.background = '#6b7280';
          loadStats();
          loadTickets();
        } else {
          alert(`Erro: ${data.error || 'Não foi possível cancelar o vale'}`);
        }
      } catch (err) {
        alert('Erro de comunicação ao cancelar o vale.');
      }
    });
  }
}

// Registro PWA (Service Worker para Android e iOS)
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  });
}

