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

// Gerenciamento de Perfis (Operacional vs Administrativo)
const STORAGE_PROFILE_KEY = 'feijoada_app_profile';
let currentProfile = null; // 'operacional' | 'admin' | null

// Operador e Identificação do Smartphone
const STORAGE_OPERATOR_KEY = 'feijoada_app_operator_name_v1';
const SESSION_ADMIN_PIN_KEY = 'feijoada_admin_pin_session';

function getOperatorName() {
  try {
    return localStorage.getItem(STORAGE_OPERATOR_KEY) || 'Smartphone Balcão';
  } catch (e) {
    return 'Smartphone Balcão';
  }
}

function setOperatorName(name) {
  const trimmed = (name || '').trim();
  if (!trimmed) return;
  try {
    localStorage.setItem(STORAGE_OPERATOR_KEY, trimmed);
  } catch (e) {}
  updateOperatorUI();
}

function updateOperatorUI() {
  const el = document.getElementById('operator-pill-name');
  if (el) el.textContent = getOperatorName();
}

function getSessionAdminPin() {
  try {
    return sessionStorage.getItem(SESSION_ADMIN_PIN_KEY) || '';
  } catch (e) {
    return '';
  }
}

function setSessionAdminPin(pin) {
  try {
    sessionStorage.setItem(SESSION_ADMIN_PIN_KEY, pin);
  } catch (e) {}
}

function openPinModal(onSuccess) {
  const modal = document.getElementById('pin-modal');
  const input = document.getElementById('input-admin-pin');
  const errorMsg = document.getElementById('pin-error-msg');
  const btnConfirm = document.getElementById('btn-confirm-pin');
  const btnCancel = document.getElementById('btn-cancel-pin');
  const btnClose = document.getElementById('btn-close-pin-modal');

  if (errorMsg) errorMsg.style.display = 'none';
  if (input) {
    input.value = '';
    setTimeout(() => input.focus(), 150);
  }
  if (modal) modal.classList.add('active');

  const cleanup = () => {
    if (modal) modal.classList.remove('active');
    btnConfirm.onclick = null;
    btnCancel.onclick = null;
    if (btnClose) btnClose.onclick = null;
  };

  const doVerify = async () => {
    const pin = input ? input.value.trim() : '';
    if (!pin) return;
    try {
      btnConfirm.disabled = true;
      btnConfirm.textContent = 'Verificando...';
      const res = await fetch(`${BASE_PATH}/api/auth/verify-pin`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pin })
      });
      const data = await res.json();
      if (res.ok && data.success) {
        setSessionAdminPin(pin);
        cleanup();
        if (typeof onSuccess === 'function') onSuccess();
      } else {
        if (errorMsg) {
          errorMsg.textContent = data.error || 'PIN incorreto. Tente novamente.';
          errorMsg.style.display = 'block';
        }
        input.value = '';
        input.focus();
      }
    } catch (err) {
      alert('Erro de conexão ao verificar PIN.');
    } finally {
      btnConfirm.disabled = false;
      btnConfirm.textContent = '🔓 Acessar Administração';
    }
  };

  btnConfirm.onclick = doVerify;
  input.onkeypress = (e) => { if (e.key === 'Enter') doVerify(); };
  btnCancel.onclick = cleanup;
  if (btnClose) btnClose.onclick = cleanup;
}

function setupOperatorModal() {
  const modal = document.getElementById('operator-modal');
  const btnTrigger = document.getElementById('btn-edit-operator');
  const btnClose = document.getElementById('btn-close-operator-modal');
  const btnSave = document.getElementById('btn-save-operator-name');
  const input = document.getElementById('input-operator-name');

  function openModal() {
    triggerHaptic('light');
    if (input) input.value = getOperatorName();
    if (modal) modal.classList.add('active');
    setTimeout(() => { if (input) input.focus(); }, 150);
  }

  function closeModal() {
    if (modal) modal.classList.remove('active');
  }

  if (btnTrigger) btnTrigger.addEventListener('click', openModal);
  if (btnClose) btnClose.addEventListener('click', closeModal);
  if (modal) {
    modal.addEventListener('click', (e) => {
      if (e.target === modal) closeModal();
    });
  }

  if (btnSave) {
    btnSave.addEventListener('click', () => {
      triggerHaptic('success');
      const val = input ? input.value.trim() : '';
      if (val) {
        setOperatorName(val);
        closeModal();
      }
    });
  }
}

// Inicialização ao carregar
document.addEventListener('DOMContentLoaded', () => {
  updateOperatorUI();
  setupOperatorModal();
  setupCashflowModal();
  setupProfileManagement();
  setupDockNavigation();
  loadConfig();
  loadStats();
  loadTickets();
  setupScanner();
  setupSalesForm();
  setupBalcaoSale();
  setupEditForm();
  setupCalendarModal();
  setupPurgeModal();
  setupSSE();
});

// ==================== GERENCIAMENTO DE PERFIS ====================
function setupProfileManagement() {
  const btnChooseOperacional = document.getElementById('btn-choose-operacional');
  const btnChooseAdmin = document.getElementById('btn-choose-admin');
  const btnSwitchProfile = document.getElementById('btn-switch-profile');

  if (btnChooseOperacional) {
    btnChooseOperacional.addEventListener('click', () => {
      triggerHaptic('light');
      selectProfile('operacional');
    });
  }

  if (btnChooseAdmin) {
    btnChooseAdmin.addEventListener('click', () => {
      triggerHaptic('light');
      selectProfile('admin');
    });
  }

  if (btnSwitchProfile) {
    btnSwitchProfile.addEventListener('click', () => {
      triggerHaptic('light');
      openProfileSelector();
    });
  }

  // Verifica se há perfil persistido no aparelho
  let savedProfile = null;
  try {
    savedProfile = localStorage.getItem(STORAGE_PROFILE_KEY);
  } catch (e) {
    console.warn('Erro ao ler localStorage:', e);
  }

  if (savedProfile === 'operacional' || savedProfile === 'admin') {
    applyProfile(savedProfile, false);
  } else {
    openProfileSelector();
  }
}

function selectProfile(profile) {
  if (profile === 'admin') {
    const verifiedPin = getSessionAdminPin();
    if (verifiedPin) {
      applyProfileAndSave(profile);
    } else {
      openPinModal(() => {
        applyProfileAndSave(profile);
      });
    }
  } else {
    applyProfileAndSave(profile);
  }
}

function applyProfileAndSave(profile) {
  try {
    localStorage.setItem(STORAGE_PROFILE_KEY, profile);
  } catch (e) {
    console.warn('Erro ao salvar profile no storage', e);
  }
  applyProfile(profile, true);
}

function applyProfile(profile, shouldSwitchTab = true) {
  currentProfile = profile;
  document.body.classList.remove('profile-selector-open', 'mode-operacional', 'mode-admin');

  const pillText = document.getElementById('profile-pill-text');
  const pillIcon = document.getElementById('profile-pill-icon');
  const pillBtn = document.getElementById('btn-switch-profile');

  if (profile === 'operacional') {
    document.body.classList.add('mode-operacional');
    if (pillText) pillText.textContent = 'Operacional';
    if (pillIcon) pillIcon.textContent = '⚡';
    if (pillBtn) {
      pillBtn.classList.remove('pill-admin');
      pillBtn.title = 'Perfil Ativo: Operacional (Toque para alternar)';
    }

    // No modo operacional, abrir diretamente a aba de Escanear para agilidade do balcão
    if (shouldSwitchTab) {
      switchTab('tab-scanner');
    } else {
      const activeTab = document.querySelector('.tab-pane.active');
      if (!activeTab || activeTab.id === 'tab-edit' || activeTab.id === 'tab-list') {
        switchTab('tab-scanner');
      }
    }
  } else if (profile === 'admin') {
    document.body.classList.add('mode-admin');
    if (pillText) pillText.textContent = 'Administrativo';
    if (pillIcon) pillIcon.textContent = '👑';
    if (pillBtn) {
      pillBtn.classList.add('pill-admin');
      pillBtn.title = 'Perfil Ativo: Administrativo (Toque para alternar)';
    }

    if (shouldSwitchTab) {
      switchTab('tab-list');
    }
  }
}

function openProfileSelector() {
  document.body.classList.add('profile-selector-open');
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

// ==================== DOCK INFERIOR ESTILO IPHONE ====================
function setupDockNavigation() {
  const dockItems = document.querySelectorAll('.dock-item');
  const tabPanes = document.querySelectorAll('.tab-pane');

  dockItems.forEach(item => {
    item.addEventListener('click', () => {
      const targetId = item.getAttribute('data-tab');
      const profiles = (item.getAttribute('data-profiles') || '').split(',');

      // Se for restrito a admin e estiver no modo operacional, ignora
      if (currentProfile === 'operacional' && profiles.length && !profiles.includes('operacional')) {
        return;
      }

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
  if (dockBtn && dockBtn.offsetParent !== null) {
    dockBtn.click();
  } else {
    // Fallback: seleciona diretamente a pane e atualiza o dock se existir
    const dockItems = document.querySelectorAll('.dock-item');
    const tabPanes = document.querySelectorAll('.tab-pane');
    
    dockItems.forEach(d => {
      if (d.getAttribute('data-tab') === tabId) d.classList.add('active');
      else d.classList.remove('active');
    });

    tabPanes.forEach(p => {
      if (p.id === tabId) p.classList.add('active');
      else p.classList.remove('active');
    });

    if (tabId === 'tab-dashboard') loadStats();
    else if (tabId === 'tab-list') loadTickets();
  }
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
      if (['ticket_delivered', 'ticket_created', 'ticket_updated', 'ticket_deleted', 'tickets_purged', 'batch_created'].includes(parsed.type)) {
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

  // Inicializar data padrão de pagamento como hoje
  const todayIso = new Date().toISOString().split('T')[0];
  const salesPayDateHidden = document.getElementById('payment_date');
  if (salesPayDateHidden && !salesPayDateHidden.value) {
    salesPayDateHidden.value = todayIso;
  }

  const btnOpenCalendarSales = document.getElementById('btn-open-calendar-sales');
  if (btnOpenCalendarSales) {
    btnOpenCalendarSales.addEventListener('click', () => {
      triggerHaptic('light');
      openCalendarModal('sales', salesPayDateHidden ? salesPayDateHidden.value : todayIso);
    });
  }

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
      payment_method: 'dinheiro',
      payment_status: document.getElementById('payment_status')?.value || 'pago',
      payment_date: (salesPayDateHidden ? salesPayDateHidden.value : '') || todayIso,
      notes: document.getElementById('ticket_notes').value.trim(),
      sold_by: getOperatorName()
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

  const manualToggleBtn = document.getElementById('btn-toggle-manual-input');
  const manualContainer = document.getElementById('manual-code-container');
  if (manualToggleBtn && manualContainer) {
    manualToggleBtn.addEventListener('click', () => {
      triggerHaptic('light');
      const isVisible = manualContainer.style.display !== 'none';
      manualContainer.style.display = isVisible ? 'none' : 'block';
      if (!isVisible) manualInput.focus();
    });
  }

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
  const inlineBalcaoBox = document.getElementById('balcao-inline-box');
  if (inlineBalcaoBox) inlineBalcaoBox.style.display = 'none';

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

      const isPending = Boolean(data.needs_payment || data.ticket.payment_status === 'pendente');
      const amountDue = data.amount_due || data.ticket.total_price;

      if (isPending) {
        badge.style.background = '#d97706';
        badge.style.color = 'white';
        badge.textContent = '⚠️ PAGAMENTO PENDENTE!';

        actionContainer.innerHTML = `
          <div class="scan-pending-box">
            <div style="color: #92400e; font-weight: 900; font-size: 1.05rem;">⚠️ COBRAR ANTES DE ENTREGAR!</div>
            <div style="color: #b45309; font-size: 1.45rem; font-weight: 900; margin: 4px 0;">RECEBER ${formatMoney(amountDue)}</div>
            <div style="color: #78350f; font-size: 0.75rem;">Receba em dinheiro físico e confirme a entrega abaixo:</div>
          </div>
          <button type="button" id="btn-confirm-delivery-paid" class="btn-glass btn-large-hero" style="background: linear-gradient(135deg, #059669 0%, #047857 100%); color: white; margin-bottom: 8px;">
            💵 RECEBER ${formatMoney(amountDue)} & ENTREGAR 🍲
          </button>
          <button type="button" id="btn-confirm-delivery-unpaid" class="btn-glass btn-secondary-glass" style="font-size: 0.78rem; color: #b45309;">
            ⚠️ Entregar SEM cobrar (Cortesia / Autorizado)
          </button>
        `;
        document.getElementById('btn-confirm-delivery-paid').addEventListener('click', () => confirmDelivery({ receivedPayment: true }));
        document.getElementById('btn-confirm-delivery-unpaid').addEventListener('click', () => {
          if (confirm('Deseja realmente entregar SEM registrar o recebimento do dinheiro?')) {
            confirmDelivery({ receivedPayment: false });
          }
        });
      } else {
        actionContainer.innerHTML = `
          <button type="button" id="btn-confirm-delivery" class="btn-glass btn-success-glass btn-large-hero">
            🍲 CONFIRMAR ENTREGA DE ${rem} PORÇÃO(ÕES)
          </button>
        `;
        document.getElementById('btn-confirm-delivery').addEventListener('click', () => confirmDelivery({ receivedPayment: false }));
      }

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
async function confirmDelivery(options = {}) {
  if (!currentTicketData) return;

  const btn = document.getElementById('btn-confirm-delivery') || document.getElementById('btn-confirm-delivery-paid');
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '<span>⏳ Registrando Entrega...</span>';
  }

  const receivedPay = Boolean(options && options.receivedPayment);

  try {
    const res = await fetch(`${BASE_PATH}/api/tickets/${encodeURIComponent(currentTicketData.code)}/deliver`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        quantity_to_deliver: currentTicketData.quantity - currentTicketData.delivered_quantity,
        delivered_by: getOperatorName(),
        received_payment: receivedPay
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

    const cashRevEl = document.getElementById('dash-cash-revenue');
    if (cashRevEl) {
      cashRevEl.textContent = formatMoney(data.cash_revenue || 0);
    }

    const pendingRevEl = document.getElementById('dash-pending-revenue');
    if (pendingRevEl) {
      pendingRevEl.textContent = formatMoney(data.pending_revenue || 0);
    }

    const balcaoRevEl = document.getElementById('dash-balcao-revenue');
    if (balcaoRevEl) {
      balcaoRevEl.textContent = formatMoney(data.balcao_revenue || 0);
    }
    const balcaoCountEl = document.getElementById('dash-balcao-count');
    if (balcaoCountEl) {
      balcaoCountEl.textContent = `${data.balcao_feijoadas || 0} porções no balcão`;
    }

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
let currentFilterStatus = 'todos';

async function loadTickets() {
  const searchInput = document.getElementById('filter-search');
  const search = searchInput ? searchInput.value.trim() : '';
  const container = document.getElementById('tickets-cards-container');

  try {
    let url = `${BASE_PATH}/api/tickets?`;
    if (currentFilterStatus === 'balcao') {
      url += `channel=balcao`;
    } else {
      url += `status=${encodeURIComponent(currentFilterStatus)}`;
    }
    if (search) url += `&search=${encodeURIComponent(search)}`;

    const res = await fetch(url);
    const tickets = await res.json();

    if (!tickets || tickets.length === 0) {
      container.innerHTML = `<div style="text-align: center; color: var(--text-muted); padding: 24px;">Nenhum vale encontrado.</div>`;
      return;
    }

    container.innerHTML = tickets.map(t => {
      let badgeClass = 'badge-ativo';
      let badgeText = 'PENDENTE';
      let isCancelled = t.status === 'cancelado';
      let isDelivered = t.status === 'entregue';
      let isBalcao = t.sale_channel === 'balcao';
      let canDeletePermanently = isCancelled || isDelivered;

      if (isCancelled) {
        badgeClass = 'badge-cancelado';
        badgeText = 'CANCELADO';
      } else if (isDelivered) {
        badgeClass = 'badge-entregue';
        badgeText = 'ENTREGUE';
      } else if (t.status === 'parcial') {
        badgeClass = 'badge-parcial';
        badgeText = `PARCIAL (${t.delivered_quantity}/${t.quantity})`;
      }

      return `
        <div class="ticket-item-glass" style="${isCancelled ? 'opacity: 0.72; border-color: #fca5a5; background: rgba(254, 242, 242, 0.75);' : (isBalcao ? 'border-color: #a7f3d0;' : '')}">
          <div class="ticket-item-info">
            <div style="display: flex; align-items: center; gap: 8px; flex-wrap: wrap;">
              <span class="ticket-item-name" style="${isCancelled ? 'text-decoration: line-through; color: #6b7280;' : ''}">${escapeHtml(t.buyer_name)}</span>
              ${isBalcao ? `<span class="badge-balcao">🏪 Balcão</span>` : ''}
              <span class="ticket-item-badge ${badgeClass}">${badgeText}</span>
            </div>
            <div class="ticket-item-meta">
              Código: <strong style="color: #c2410c;">${t.code}</strong> • 
              <strong>${t.quantity} porção(ões)</strong> • ${formatMoney(t.total_price)}
            </div>
            <div style="font-size: 0.75rem; color: #15803d; font-weight: 700; margin-top: 2px;">
              💵 Dinheiro ${t.payment_date ? `• Pago em: ${formatDatePretty(t.payment_date)}` : (t.payment_status === 'pago' ? '• Pago' : '• Pendente')}
            </div>
            ${t.buyer_phone ? `<div style="font-size: 0.75rem; color: var(--text-light); margin-top: 2px;">📱 ${escapeHtml(t.buyer_phone)}</div>` : ''}
          </div>

          <!-- Botões Rápidos de Ação: Ver QR, Ajustar e Excluir se inativo -->
          <div class="ticket-item-actions">
            <button type="button" class="btn-glass btn-primary-glass" style="font-size: 0.85rem;" onclick="viewTicketQr('${t.code}')">
              👁️ Ver QR
            </button>
            <button type="button" class="btn-glass btn-secondary-glass" style="font-size: 0.85rem;" onclick="openEditTab('${t.code}')">
              ✏️ Ajustar
            </button>
            ${canDeletePermanently ? `
              <button type="button" class="btn-glass" style="font-size: 0.85rem; background: #fee2e2; color: #dc2626; border: 1px solid #fca5a5;" onclick="deleteTicketPermanently('${t.code}', '${escapeHtml(t.buyer_name)}')">
                🗑️ Excluir
              </button>
            ` : ''}
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

  // Desabilitar/Habilitar botão de salvar dependendo se está cancelado
  const saveBtn = document.getElementById('btn-save-edit');
  if (saveBtn) {
    if (ticket.status === 'cancelado') {
      saveBtn.disabled = true;
      saveBtn.style.opacity = '0.5';
      saveBtn.textContent = '⛔ VALE CANCELADO';
    } else {
      saveBtn.disabled = false;
      saveBtn.style.opacity = '1';
      saveBtn.textContent = '💾 SALVAR ALTERAÇÕES DO VALE';
    }
  }

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

  // PAGAMENTO: Data de Pagamento (padrão em Dinheiro)
  setEditPaymentDate(ticket.payment_date || '');

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

function setEditPaymentDate(dateStr) {
  const inputHidden = document.getElementById('edit_payment_date');
  const labelText = document.getElementById('edit-paydate-text');
  if (inputHidden) inputHidden.value = dateStr || '';
  if (labelText) {
    labelText.textContent = dateStr ? formatDatePretty(dateStr) : 'Não informada';
  }
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

  // Botão de Calendário para Data de Pagamento na Edição
  const btnOpenCalendarEdit = document.getElementById('btn-open-calendar-edit');
  if (btnOpenCalendarEdit) {
    btnOpenCalendarEdit.addEventListener('click', () => {
      triggerHaptic('light');
      const curDate = document.getElementById('edit_payment_date')?.value || new Date().toISOString().split('T')[0];
      openCalendarModal('edit', curDate);
    });
  }

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
        payment_method: 'dinheiro',
        payment_date: document.getElementById('edit_payment_date')?.value || '',
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

  // Botão Cancelar Vale - Modal Customizado Glass (100% responsivo)
  const btnCancel = document.getElementById('btn-cancel-ticket-action');
  const cancelModal = document.getElementById('cancel-confirm-modal');
  const btnCloseCancel = document.getElementById('btn-close-cancel-modal');
  const btnAbortCancel = document.getElementById('btn-abort-delete-action');
  const btnConfirmDelete = document.getElementById('btn-confirm-delete-action');

  function closeCancelModal() {
    if (cancelModal) cancelModal.classList.remove('active');
  }

  if (btnCloseCancel) btnCloseCancel.addEventListener('click', closeCancelModal);
  if (btnAbortCancel) btnAbortCancel.addEventListener('click', closeCancelModal);
  if (cancelModal) {
    cancelModal.addEventListener('click', (e) => {
      if (e.target === cancelModal) closeCancelModal();
    });
  }

  if (btnCancel) {
    btnCancel.addEventListener('click', () => {
      triggerHaptic('light');
      if (!currentEditTicket) {
        alert('Nenhum vale selecionado para cancelamento.');
        return;
      }
      document.getElementById('cancel-modal-code').textContent = currentEditTicket.code;
      document.getElementById('cancel-modal-name').textContent = currentEditTicket.buyer_name;
      if (cancelModal) cancelModal.classList.add('active');
    });
  }

  if (btnConfirmDelete) {
    btnConfirmDelete.addEventListener('click', async () => {
      if (!currentEditTicket) return;
      btnConfirmDelete.disabled = true;
      btnConfirmDelete.textContent = '⏳ Cancelando...';

      try {
        const res = await fetch(`${BASE_PATH}/api/tickets/${encodeURIComponent(currentEditTicket.code)}`, {
          method: 'DELETE'
        });
        const data = await res.json();
        if (res.ok) {
          playSuccessSound();
          closeCancelModal();

          // Atualizar estado em memória
          currentEditTicket.status = 'cancelado';

          // Atualizar badge do header
          const badgeEl = document.getElementById('edit-badge-status');
          if (badgeEl) {
            badgeEl.textContent = 'CANCELADO';
            badgeEl.className = 'ticket-item-badge badge-cancelado';
          }

          // Desabilitar botão de salvar para evitar reativação acidental
          const saveBtn = document.getElementById('btn-save-edit');
          if (saveBtn) {
            saveBtn.disabled = true;
            saveBtn.style.opacity = '0.5';
            saveBtn.textContent = '⛔ VALE CANCELADO';
          }

          loadStats();
          loadTickets();
          alert('🗑️ Vale cancelado com sucesso!');
        } else {
          playErrorSound();
          alert(`Erro: ${data.error || 'Não foi possível cancelar o vale'}`);
        }
      } catch (err) {
        playErrorSound();
        alert('Erro de comunicação ao cancelar o vale.');
      } finally {
        btnConfirmDelete.disabled = false;
        btnConfirmDelete.textContent = '🗑️ SIM, CANCELAR VALE';
      }
    });
  }
}

// ==================== CALENDÁRIO POP-UP PARA DATA DE PAGAMENTO ====================
let calendarContext = 'sales'; // 'sales' ou 'edit'

function formatDatePretty(isoDate) {
  if (!isoDate) return '';
  const parts = isoDate.split('-');
  if (parts.length === 3) {
    const y = parts[0];
    const m = parts[1];
    const d = parts[2];
    const today = new Date().toISOString().split('T')[0];
    if (isoDate === today) return `Hoje (${d}/${m}/${y})`;
    return `${d}/${m}/${y}`;
  }
  return isoDate;
}

function openCalendarModal(context, initialDate) {
  calendarContext = context;
  const modal = document.getElementById('calendar-modal');
  const dateInput = document.getElementById('calendar-date-picker');

  // Obter o status atual do contexto
  let currentStatus = 'pago';
  if (context === 'sales') {
    currentStatus = document.getElementById('payment_status')?.value || 'pago';
  } else if (context === 'edit') {
    currentStatus = document.getElementById('edit_payment_status')?.value || 'pago';
  }

  setModalPaymentStatus(currentStatus);

  const todayStr = new Date().toISOString().split('T')[0];
  const dateToUse = initialDate || todayStr;
  if (dateInput) dateInput.value = dateToUse;

  if (modal) modal.classList.add('active');
}

function setModalPaymentStatus(status) {
  const hiddenInput = document.getElementById('modal-payment-status-val');
  if (hiddenInput) hiddenInput.value = status;

  const chipPago = document.getElementById('modal-chip-status-pago');
  const chipPendente = document.getElementById('modal-chip-status-pendente');
  const dateSection = document.getElementById('modal-date-section');

  if (chipPago && chipPendente) {
    chipPago.classList.toggle('active', status === 'pago');
    chipPendente.classList.toggle('active', status === 'pendente');
  }

  if (dateSection) {
    // Se estiver pendente, diminuir a opacidade da data mas ainda permitir registrar
    if (status === 'pendente') {
      dateSection.style.opacity = '0.65';
    } else {
      dateSection.style.opacity = '1';
    }
  }
}

function closeCalendarModal() {
  const modal = document.getElementById('calendar-modal');
  if (modal) modal.classList.remove('active');
}

function setupCalendarModal() {
  const modal = document.getElementById('calendar-modal');
  const btnClose = document.getElementById('btn-close-calendar');
  const btnCancel = document.getElementById('btn-cancel-calendar-modal');
  const btnConfirm = document.getElementById('btn-confirm-calendar-date');
  const dateInput = document.getElementById('calendar-date-picker');

  const btnToday = document.getElementById('btn-date-shortcut-today');
  const btnYesterday = document.getElementById('btn-date-shortcut-yesterday');
  const btnEvent = document.getElementById('btn-date-shortcut-event');

  const chipPago = document.getElementById('modal-chip-status-pago');
  const chipPendente = document.getElementById('modal-chip-status-pendente');

  if (chipPago) {
    chipPago.addEventListener('click', () => {
      triggerHaptic('light');
      setModalPaymentStatus('pago');
    });
  }

  if (chipPendente) {
    chipPendente.addEventListener('click', () => {
      triggerHaptic('light');
      setModalPaymentStatus('pendente');
    });
  }

  if (btnClose) btnClose.addEventListener('click', closeCalendarModal);
  if (btnCancel) btnCancel.addEventListener('click', closeCalendarModal);

  if (modal) {
    modal.addEventListener('click', (e) => {
      if (e.target === modal) closeCalendarModal();
    });
  }

  // Atalho Hoje
  if (btnToday) {
    btnToday.addEventListener('click', () => {
      triggerHaptic('light');
      const todayStr = new Date().toISOString().split('T')[0];
      if (dateInput) dateInput.value = todayStr;
    });
  }

  // Atalho Ontem
  if (btnYesterday) {
    btnYesterday.addEventListener('click', () => {
      triggerHaptic('light');
      const d = new Date();
      d.setDate(d.getDate() - 1);
      const yStr = d.toISOString().split('T')[0];
      if (dateInput) dateInput.value = yStr;
    });
  }

  // Atalho Dia do Evento
  if (btnEvent) {
    btnEvent.addEventListener('click', () => {
      triggerHaptic('light');
      const evDate = eventConfig.event_date || '2026-10-18';
      if (dateInput) dateInput.value = evDate;
    });
  }

  // Confirmar Seleção
  if (btnConfirm) {
    btnConfirm.addEventListener('click', () => {
      triggerHaptic('success');
      const selectedStatus = document.getElementById('modal-payment-status-val')?.value || 'pago';
      const selectedDate = dateInput ? dateInput.value : '';

      if (calendarContext === 'sales') {
        const salesStatusHidden = document.getElementById('payment_status');
        const salesDateHidden = document.getElementById('payment_date');
        const salesStatusText = document.getElementById('sales-paystatus-text');
        const salesDateText = document.getElementById('sales-paydate-text');
        const salesLabel = document.getElementById('sales-paydate-label');

        if (salesStatusHidden) salesStatusHidden.value = selectedStatus;
        if (salesDateHidden) salesDateHidden.value = selectedDate;

        if (salesStatusText) {
          salesStatusText.textContent = selectedStatus === 'pago' ? 'Pago' : 'Pendente';
        }
        if (salesDateText) {
          salesDateText.textContent = selectedDate ? formatDatePretty(selectedDate) : 'Sem data';
        }
        if (salesLabel) {
          salesLabel.style.color = selectedStatus === 'pago' ? '#15803d' : '#d97706';
        }

      } else if (calendarContext === 'edit') {
        setEditPaymentStatus(selectedStatus);
        setEditPaymentDate(selectedDate);
      }

      closeCalendarModal();
    });
  }
}

// ==================== EXCLUSÃO PERMANENTE / LIMPEZA DE VALES ====================
async function deleteTicketPermanently(code, buyerName) {
  triggerHaptic('light');
  const ok = confirm(`⚠️ ATENÇÃO: Deseja apagar PERMANENTEMENTE o vale ${code} (${buyerName}) do banco de dados?\n\nEsta operação não pode ser desfeita.`);
  if (!ok) return;

  try {
    const res = await fetch(`${BASE_PATH}/api/tickets/${encodeURIComponent(code)}/purge`, {
      method: 'DELETE',
      headers: {
        'x-admin-pin': getSessionAdminPin()
      }
    });
    const data = await res.json();
    if (res.ok) {
      playSuccessSound();
      alert(`🗑️ Vale ${code} apagado com sucesso!`);
      loadStats();
      loadTickets();
    } else {
      playErrorSound();
      alert(`Erro: ${data.error || 'Falha ao excluir o vale'}`);
    }
  } catch (err) {
    playErrorSound();
    alert('Erro de comunicação ao excluir o vale.');
  }
}

function setupPurgeModal() {
  const modal = document.getElementById('purge-modal');
  const btnOpen = document.getElementById('btn-open-purge-modal');
  const btnClose = document.getElementById('btn-close-purge-modal');
  const btnAbort = document.getElementById('btn-abort-purge-modal');

  const btnPurgeCancelled = document.getElementById('btn-purge-cancelled');
  const btnPurgeDelivered = document.getElementById('btn-purge-delivered');
  const btnPurgeAllInactive = document.getElementById('btn-purge-all-inactive');

  function closePurgeModal() {
    if (modal) modal.classList.remove('active');
  }

  if (btnOpen) {
    btnOpen.addEventListener('click', () => {
      triggerHaptic('light');
      if (modal) modal.classList.add('active');
    });
  }

  if (btnClose) btnClose.addEventListener('click', closePurgeModal);
  if (btnAbort) btnAbort.addEventListener('click', closePurgeModal);
  if (modal) {
    modal.addEventListener('click', (e) => {
      if (e.target === modal) closePurgeModal();
    });
  }

  // Configuração dos botões de filtro de status na aba Vales
  const statusChips = document.querySelectorAll('.filter-status-chip');
  statusChips.forEach(chip => {
    chip.addEventListener('click', () => {
      triggerHaptic('light');
      statusChips.forEach(c => c.classList.remove('active'));
      chip.classList.add('active');
      currentFilterStatus = chip.getAttribute('data-filterstatus') || 'todos';
      loadTickets();
    });
  });

  async function executeBulkPurge(target, description) {
    triggerHaptic('light');
    const ok = confirm(`⚠️ ATENÇÃO: Deseja realmente excluir permanentemente todos os ${description}?\n\nEsta ação apagará os registros definitivamente do banco de dados.`);
    if (!ok) return;

    try {
      const res = await fetch(`${BASE_PATH}/api/tickets/purge-bulk`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-admin-pin': getSessionAdminPin()
        },
        body: JSON.stringify({ target })
      });
      const data = await res.json();
      if (res.ok) {
        playSuccessSound();
        closePurgeModal();
        alert(`🗑️ ${data.message || 'Exclusão concluída!'}`);
        loadStats();
        loadTickets();
      } else {
        playErrorSound();
        alert(`Erro: ${data.error || 'Falha ao executar limpeza'}`);
      }
    } catch (err) {
      playErrorSound();
      alert('Erro de conexão ao executar limpeza.');
    }
  }

  if (btnPurgeCancelled) {
    btnPurgeCancelled.addEventListener('click', () => {
      executeBulkPurge('cancelados', 'pedidos cancelados');
    });
  }

  if (btnPurgeDelivered) {
    btnPurgeDelivered.addEventListener('click', () => {
      executeBulkPurge('entregues', 'pedidos já entregues / finalizados');
    });
  }

  if (btnPurgeAllInactive) {
    btnPurgeAllInactive.addEventListener('click', () => {
      executeBulkPurge('finalizados', 'pedidos cancelados E entregues (todos inativos)');
    });
  }
}

// ==================== VENDA RÁPIDA DE BALCÃO (FLUXO OTIMIZADO NA TELA DO SCANNER) ====================
function setupBalcaoSale() {
  // Caixa Inline na própria tela do Scanner
  const inlineBox = document.getElementById('balcao-inline-box');
  const btnToggleInline = document.getElementById('btn-toggle-inline-balcao');
  const btnCloseInline = document.getElementById('btn-close-inline-balcao');
  const btnInlineMinus = document.getElementById('btn-inline-minus');
  const btnInlinePlus = document.getElementById('btn-inline-plus');
  const inlineQtyDisplay = document.getElementById('inline-stepper-display');
  const inlineQtyInput = document.getElementById('inline-ticket-qty');
  const inlineChips = document.querySelectorAll('[data-inlineqty]');
  const inlineTotalDisplay = document.getElementById('inline-total-display');
  const inlineBuyerName = document.getElementById('inline-buyer-name');
  const inlineAutoDeliver = document.getElementById('inline-auto-deliver');
  const btnConfirmSale = document.getElementById('btn-confirm-inline-sale');
  const formState = document.getElementById('inline-balcao-form-state');
  const successState = document.getElementById('inline-balcao-success-state');
  const btnNextSale = document.getElementById('btn-next-inline-sale');

  function updateInlineTotal() {
    const qty = parseInt(inlineQtyInput ? inlineQtyInput.value : 1, 10) || 1;
    if (inlineQtyDisplay) inlineQtyDisplay.textContent = qty;
    const unitPrice = Number(eventConfig.unit_price) || 1000;
    const total = qty * unitPrice;
    if (inlineTotalDisplay) inlineTotalDisplay.textContent = formatMoney(total);
    if (btnConfirmSale) {
      btnConfirmSale.textContent = `💰 CONFIRMAR VENDA & RECEBER (${formatMoney(total)})`;
    }

    inlineChips.forEach(chip => {
      const chipQty = parseInt(chip.getAttribute('data-inlineqty'), 10);
      chip.classList.toggle('active', chipQty === qty);
    });
  }

  function openInlineBalcao() {
    triggerHaptic('light');
    if (!inlineBox) return;

    // Fecha o resultado do scanner de leitura se estiver aberto
    const scanResult = document.getElementById('scan-result');
    if (scanResult) scanResult.style.display = 'none';

    // Reseta estado para formulário
    if (formState) formState.style.display = 'block';
    if (successState) successState.style.display = 'none';

    inlineBox.style.display = 'block';
    updateInlineTotal();

    // Rola suavemente até a caixa se necessário
    setTimeout(() => {
      inlineBox.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      if (inlineBuyerName) inlineBuyerName.focus();
    }, 100);
  }

  function closeInlineBalcao() {
    if (inlineBox) inlineBox.style.display = 'none';
  }

  if (btnToggleInline) {
    btnToggleInline.addEventListener('click', () => {
      if (inlineBox && inlineBox.style.display !== 'none') {
        closeInlineBalcao();
      } else {
        openInlineBalcao();
      }
    });
  }

  if (btnCloseInline) {
    btnCloseInline.addEventListener('click', closeInlineBalcao);
  }

  if (btnInlineMinus) {
    btnInlineMinus.addEventListener('click', () => {
      triggerHaptic('light');
      let val = parseInt(inlineQtyInput.value, 10) || 1;
      if (val > 1) {
        inlineQtyInput.value = val - 1;
        updateInlineTotal();
      }
    });
  }

  if (btnInlinePlus) {
    btnInlinePlus.addEventListener('click', () => {
      triggerHaptic('light');
      let val = parseInt(inlineQtyInput.value, 10) || 1;
      if (val < 50) {
        inlineQtyInput.value = val + 1;
        updateInlineTotal();
      }
    });
  }

  inlineChips.forEach(chip => {
    chip.addEventListener('click', () => {
      triggerHaptic('light');
      const qty = parseInt(chip.getAttribute('data-inlineqty'), 10);
      if (qty && inlineQtyInput) {
        inlineQtyInput.value = qty;
        updateInlineTotal();
      }
    });
  });

  if (btnConfirmSale) {
    btnConfirmSale.addEventListener('click', async () => {
      triggerHaptic('light');
      const qty = parseInt(inlineQtyInput ? inlineQtyInput.value : 1, 10) || 1;
      let buyerName = inlineBuyerName ? inlineBuyerName.value.trim() : '';
      if (!buyerName) {
        buyerName = `Cliente Balcão #${Math.floor(100 + Math.random() * 900)}`;
      }
      const autoDeliver = inlineAutoDeliver ? inlineAutoDeliver.checked : true;

      btnConfirmSale.disabled = true;
      btnConfirmSale.textContent = 'Gravando Venda...';

      try {
        const res = await fetch(`${BASE_PATH}/api/tickets`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            buyer_name: buyerName,
            quantity: qty,
            payment_method: 'dinheiro',
            payment_status: 'pago',
            sale_channel: 'balcao',
            auto_deliver: autoDeliver,
            sold_by: getOperatorName()
          })
        });

        const data = await res.json();
        if (res.ok && data.success) {
          playSuccessSound();

          // Exibe o estado de sucesso idêntico ao scan-result
          if (formState) formState.style.display = 'none';
          if (successState) {
            successState.style.display = 'block';
            const qtyText = document.getElementById('inline-success-qty-text');
            const detailsText = document.getElementById('inline-success-details-text');
            if (qtyText) qtyText.textContent = `${data.ticket.quantity} Porção(ões) • ${formatMoney(data.ticket.total_price)}`;
            if (detailsText) {
              detailsText.innerHTML = `
                Código: <strong style="color: #c2410c;">${data.ticket.code}</strong><br>
                Comprador: <strong>${escapeHtml(data.ticket.buyer_name)}</strong><br>
                Status: <strong>${autoDeliver ? 'Marmita Entregue 🍲' : 'Aguardando Retirada'}</strong><br>
                Caixa atualizado (+${formatMoney(data.ticket.total_price)})
              `;
            }
          }

          loadStats();
          if (document.getElementById('tab-list').classList.contains('active')) {
            loadTickets();
          }
        } else {
          playErrorSound();
          alert(`Erro: ${data.error || 'Falha ao registrar venda'}`);
        }
      } catch (err) {
        playErrorSound();
        console.error('Erro na venda de balcão:', err);
        alert('Erro de conexão ao registrar venda.');
      } finally {
        btnConfirmSale.disabled = false;
        updateInlineTotal();
      }
    });
  }

  if (btnNextSale) {
    btnNextSale.addEventListener('click', () => {
      triggerHaptic('light');
      // Reseta formulário para próximo cliente
      if (inlineQtyInput) inlineQtyInput.value = 1;
      if (inlineBuyerName) inlineBuyerName.value = '';
      if (inlineAutoDeliver) inlineAutoDeliver.checked = true;
      if (formState) formState.style.display = 'block';
      if (successState) successState.style.display = 'none';
      updateInlineTotal();
      if (inlineBuyerName) inlineBuyerName.focus();
    });
  }

  // Compatibilidade com modal popup se chamado de outros pontos
  const modal = document.getElementById('balcao-modal');
  const btnCloseModal = document.getElementById('btn-close-balcao-modal');
  const btnCancelModal = document.getElementById('btn-cancel-balcao');
  if (btnCloseModal && modal) btnCloseModal.addEventListener('click', () => modal.classList.remove('active'));
  if (btnCancelModal && modal) btnCancelModal.addEventListener('click', () => modal.classList.remove('active'));
}

// Registro PWA (Service Worker para Android e iOS)
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  });
}


// ==================== FECHAMENTO DE CAIXA UNIFICADO ====================
function setupCashflowModal() {
  const modal = document.getElementById('cashflow-modal');
  const btnTrigger = document.getElementById('btn-open-cashflow-modal');
  const btnClose = document.getElementById('btn-close-cashflow-modal');
  const btnPrint = document.getElementById('btn-print-cashflow');

  function openModal() {
    triggerHaptic('light');
    if (modal) modal.classList.add('active');
    loadCashflowSummary();
  }

  function closeModal() {
    if (modal) modal.classList.remove('active');
  }

  if (btnTrigger) btnTrigger.addEventListener('click', openModal);
  if (btnClose) btnClose.addEventListener('click', closeModal);
  if (modal) {
    modal.addEventListener('click', (e) => {
      if (e.target === modal) closeModal();
    });
  }

  if (btnPrint) {
    btnPrint.addEventListener('click', () => {
      window.print();
    });
  }
}

async function loadCashflowSummary() {
  try {
    const res = await fetch(`${BASE_PATH}/api/cashflow/summary`);
    const data = await res.json();
    if (!res.ok) return;

    const s = data.summary;
    const totalCashEl = document.getElementById('cf-total-cash');
    const totalDigitalEl = document.getElementById('cf-total-digital');
    const totalCollectedEl = document.getElementById('cf-total-collected');
    const totalPendingEl = document.getElementById('cf-total-pending');

    if (totalCashEl) totalCashEl.textContent = formatMoney(s.confirmed_cash || 0);
    if (totalDigitalEl) totalDigitalEl.textContent = formatMoney(s.confirmed_digital || 0);
    if (totalCollectedEl) totalCollectedEl.textContent = formatMoney(s.total_collected || 0);
    if (totalPendingEl) totalPendingEl.textContent = formatMoney(s.pending_amount || 0);

    const soldEl = document.getElementById('cf-feijoadas-sold');
    const delivEl = document.getElementById('cf-feijoadas-delivered');
    const pendEl = document.getElementById('cf-feijoadas-pending');

    if (soldEl) soldEl.textContent = s.total_feijoadas || 0;
    if (delivEl) delivEl.textContent = s.total_delivered || 0;
    if (pendEl) pendEl.textContent = s.pending_deliveries || 0;

    const container = document.getElementById('cf-operators-table-container');
    if (container) {
      if (data.by_operator && data.by_operator.length > 0) {
        container.innerHTML = `
          <table class="cf-table-glass">
            <thead>
              <tr>
                <th>Colaborador / Ponto</th>
                <th style="text-align: center;">Vendas</th>
                <th style="text-align: center;">Porções</th>
                <th style="text-align: right; color: #047857;">Dinheiro Físico</th>
                <th style="text-align: right; color: #2563eb;">Digital</th>
                <th style="text-align: right; font-weight: 900;">Total Caixa</th>
              </tr>
            </thead>
            <tbody>
              ${data.by_operator.map(op => `
                <tr>
                  <td><span class="cf-badge-operator">👤 ${escapeHtml(op.operator)}</span></td>
                  <td style="text-align: center;">${op.tickets_count}</td>
                  <td style="text-align: center; font-weight: 800;">${op.feijoadas_count}</td>
                  <td style="text-align: right; color: #047857; font-weight: 800;">${formatMoney(op.cash_collected)}</td>
                  <td style="text-align: right; color: #2563eb;">${formatMoney(op.digital_collected)}</td>
                  <td style="text-align: right; font-weight: 900; color: #0f172a;">${formatMoney(op.total_collected)}</td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        `;
      } else {
        container.innerHTML = `<div style="text-align: center; color: var(--text-muted); padding: 16px;">Nenhuma venda registrada ainda.</div>`;
      }
    }
  } catch (err) {
    console.error('Erro ao carregar fechamento de caixa:', err);
  }
}
