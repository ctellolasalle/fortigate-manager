/**
 * app.js — FortiGate DHCP V170 Manager SPA
 * Gestión de arrendamientos DHCP vía API REST (Node proxy → FastAPI Python → FortiGate)
 */

'use strict';

// ─── Estado global ─────────────────────────────────────────────────────────────
const State = {
  user: null,
  leases: [],
  filteredLeases: [],
  availableIPs: [],
  printers: [],
  filteredPrinters: [],
  printerSummary: null,
  stats: null,
  fortiStatus: null,
  currentView: 'dashboard',
  sort: { col: 'ip', dir: 'asc' },
  actionFilter: 'ALL',
  selectedLeases: new Set(),
  searchDebounce: null,
  printerDebounce: null,
  candidateDebounce: null,
  printerCandidates: [],
  pendingDelete: null,
  pendingPrinterDelete: null,
  editingId: null,
};

// ─── API helper ────────────────────────────────────────────────────────────────
const API = {
  async request(method, path, body = null) {
    const opts = {
      method,
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
    };
    if (body) opts.body = JSON.stringify(body);

    const res = await fetch(`/api${path}`, opts);
    const data = await res.json().catch(() => ({ success: false, message: `HTTP ${res.status}` }));

    if (res.status === 401) {
      window.location.href = '/login?error=session_required';
      throw new Error('Sesión expirada');
    }

    if (!res.ok && data.detail) {
      throw new Error(data.detail);
    }
    if (!res.ok && data.message) {
      throw new Error(data.message);
    }
    if (!res.ok) {
      throw new Error(`Error HTTP ${res.status}`);
    }

    return data;
  },

  get: (p) => API.request('GET', p),
  post: (p, b) => API.request('POST', p, b),
  put: (p, b) => API.request('PUT', p, b),
  del: (p) => API.request('DELETE', p),
};

// ─── Toast ─────────────────────────────────────────────────────────────────────
function toast(msg, type = 'info', duration = 4000) {
  const icons = { success: '✅', error: '❌', info: 'ℹ️', warning: '⚠️' };
  const container = document.getElementById('toast-container');
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.innerHTML = `<span class="toast-icon">${icons[type]}</span><span class="toast-msg">${msg}</span>`;
  container.appendChild(el);

  setTimeout(() => {
    el.classList.add('hide');
    setTimeout(() => el.remove(), 280);
  }, duration);
}

// ─── DOM helpers ───────────────────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);
const setText = (id, val) => { const el = $(id); if (el) el.textContent = val; };

// ─── Modals ────────────────────────────────────────────────────────────────────
function openModal(id) {
  const el = $(id);
  if (el) el.classList.add('open');
}

function closeModal(id) {
  const el = $(id);
  if (el) el.classList.remove('open');
}

// ─── Navigation ────────────────────────────────────────────────────────────────
function switchView(name) {
  // Update nav items
  document.querySelectorAll('.nav-item').forEach((el) => {
    el.classList.toggle('active', el.dataset.view === name);
  });

  // Show/hide views
  document.querySelectorAll('.view').forEach((el) => {
    el.classList.toggle('active', el.id === `view-${name}`);
  });

  State.currentView = name;

  const titles = {
    dashboard: 'Dashboard',
    leases: 'Arrendamientos DHCP',
    available: 'IPs Disponibles',
    printers: 'Control de Acceso a Impresoras',
    audit: 'Registro de Auditoría',
  };
  setText('breadcrumb', titles[name] || name);

  // Load data for view
  if (name === 'available') loadAvailableIPs();
  if (name === 'printers') loadPrinterPermissions();
  if (name === 'audit') {
    loadAuditUsers();
    loadAuditLogs();
  }
}

// ─── Auth / User ────────────────────────────────────────────────────────────────
async function loadUser() {
  try {
    const res = await fetch('/auth/status', { credentials: 'same-origin' });
    const data = await res.json();
    if (!data.authenticated) {
      window.location.href = '/login';
      return;
    }
    State.user = data.user;
    renderUser(data.user);
  } catch (err) {
    console.warn('loadUser error:', err);
  }
}

function renderUser(user) {
  const avatar = $('user-avatar');
  const fallbackUrl = `https://ui-avatars.com/api/?name=${encodeURIComponent(user.name || user.email || 'U')}&background=1e3a8a&color=ffffff&bold=true`;

  if (avatar) {
    avatar.onerror = () => {
      avatar.onerror = null;
      avatar.src = fallbackUrl;
    };

    if (user.photo) {
      avatar.src = user.photo;
      avatar.alt = user.name || 'Usuario';
    } else {
      avatar.src = fallbackUrl;
      avatar.alt = user.name || 'Usuario';
    }
  }

  setText('user-name', user.name || user.email?.split('@')[0] || 'Usuario');
  setText('user-email', user.email || '');

  // Pestaña de Auditoría: Solo visible para administradores
  const navAudit = $('nav-audit');
  if (navAudit) {
    if (user.isAdmin) {
      navAudit.classList.remove('hidden');
    } else {
      navAudit.classList.add('hidden');
    }
  }
}

// ─── FortiGate status ──────────────────────────────────────────────────────────
async function loadFortiStatus() {
  const dot = $('status-dot');
  const txt = $('status-text');

  try {
    const data = await API.get('/system/status');
    State.fortiStatus = data;

    dot.className = 'status-dot online';
    txt.textContent = `${data.model} · ${data.hostname}`;

    setText('info-model', data.model);
    setText('info-firmware', data.firmware);
    setText('info-host', `${data.host}:${data.port}`);
    setText('info-hostname', data.hostname);
    setText('info-dhcp-id', `ID ${data.dhcp_server_id}`);
    setText('info-range', data.v170_range);
  } catch (err) {
    dot.className = 'status-dot offline';
    txt.textContent = 'Sin conexión';
    toast(`Error de conectividad: ${err.message}`, 'error', 6000);
  }
}

// ─── DHCP Stats ────────────────────────────────────────────────────────────────
async function loadStats() {
  try {
    const data = await API.get('/dhcp/stats');
    State.stats = data;

    setText('stat-reserved', data.reserved_v170 ?? data.reserved);
    setText('stat-free', data.available);
    setText('stat-util', data.utilization_pct);
    setText('info-total', data.total_addresses);
    setText('info-available', data.available);
    setText('prog-used', `${data.reserved_v170 ?? data.reserved} con IP fija · ${data.mac_only ?? 0} solo MAC`);
    setText('prog-total', `${data.total_addresses} IPs en pool`);

    const bar = $('progress-bar');
    if (bar) bar.style.width = `${Math.min(100, data.utilization_pct)}%`;
  } catch (err) {
    console.warn('loadStats error:', err);
  }
}

// ─── Leases ────────────────────────────────────────────────────────────────────
async function loadLeases() {
  const tbody = $('leases-tbody');
  const recentTbody = $('recent-tbody');

  if (tbody) tbody.innerHTML = `<tr><td colspan="5" class="empty-row"><div class="loading-spinner"></div> Cargando arrendamientos...</td></tr>`;

  try {
    const data = await API.get('/dhcp/reservations');
    State.leases = data.reservations || [];
    // Limpiar IDs seleccionados que ya no existan o que ya no sean 'reserved'
    const validReservedIds = new Set(
      State.leases
        .filter((l) => (l.action || (l.ip && l.ip !== '0.0.0.0' ? 'reserved' : 'assign')) === 'reserved')
        .map((l) => l.id)
    );
    State.selectedLeases = new Set([...State.selectedLeases].filter((id) => validReservedIds.has(id)));

    applyLeaseFilters();
    renderRecentLeases(recentTbody);
  } catch (err) {
    if (tbody) tbody.innerHTML = `<tr><td colspan="5" class="empty-row">❌ Error: ${err.message}</td></tr>`;
    toast(`Error cargando arrendamientos: ${err.message}`, 'error');
  }
}

function renderLeases() {
  const tbody = $('leases-tbody');
  if (!tbody) return;

  const leases = State.filteredLeases;
  setText('record-count', `${leases.length} registros`);

  if (!leases.length) {
    tbody.innerHTML = `<tr><td colspan="7" class="empty-row">No hay arrendamientos que coincidan con la búsqueda y filtro</td></tr>`;
    updateBulkActionBar();
    return;
  }

  tbody.innerHTML = leases.map((l) => {
    const action = l.action || (l.ip && l.ip !== '0.0.0.0' ? 'reserved' : 'assign-ip');
    const isReserved = action === 'reserved';
    const actionBadge = isReserved
      ? `<span class="badge-action badge-action-reserved">Reserve IP</span>`
      : `<span class="badge-action badge-action-assign">Assign IP</span>`;

    const ipDisplay = (isReserved && l.ip && l.ip !== '0.0.0.0')
      ? l.ip
      : `<span style="color:var(--text-secondary);font-style:italic">Dynamic (Pool)</span>`;

    const isChecked = State.selectedLeases.has(l.id);
    // Solo permitir checkbox en reglas de tipo Reserve IP (para pasarlas a Assign IP)
    const checkCell = isReserved
      ? `<input type="checkbox" class="lease-check-input lease-item-check" data-id="${l.id}" ${isChecked ? 'checked' : ''}>`
      : `<span style="color:var(--border-color);font-size:0.9rem;" title="Ya es dinámica">—</span>`;

    return `
      <tr class="lease-row ${isChecked ? 'selected' : ''}" data-id="${l.id}">
        <td style="text-align: center;">${checkCell}</td>
        <td class="td-id">
          <span class="cell-label-mobile">#</span><span class="id-number">${l.id}</span>
        </td>
        <td class="td-desc">
          <div class="desc-main">${escapeHtml(l.description) || '<span style="color:var(--text-secondary);font-style:italic">Sin descripción</span>'}</div>
        </td>
        <td class="td-mac">
          <span class="cell-label-mobile">MAC</span>
          <span class="mac-text mono">${l.mac}</span>
        </td>
        <td class="td-action">${actionBadge}</td>
        <td class="td-ip">
          <span class="cell-label-mobile">IP</span>
          <span class="ip-text mono">${ipDisplay}</span>
        </td>
        <td class="td-actions">
          <button class="btn btn-ghost btn-sm action-btn-edit" data-action="edit" data-id="${l.id}" title="Editar" aria-label="Editar">
            <span>✏️</span><span class="mobile-action-text">Editar</span>
          </button>
          <button class="btn btn-ghost btn-sm action-btn-del" data-action="delete" data-id="${l.id}" title="Eliminar" aria-label="Eliminar" style="color:var(--error-color, #ef4444)">
            <span>🗑️</span><span class="mobile-action-text">Eliminar</span>
          </button>
        </td>
      </tr>
    `;
  }).join('');

  updateBulkActionBar();
}

function updateBulkActionBar() {
  const bar = $('bulk-action-bar');
  const countText = $('bulk-selected-count');
  const thSelectAll = $('th-select-all');

  const count = State.selectedLeases.size;

  if (count > 0) {
    if (bar) bar.classList.remove('hidden');
    if (countText) countText.textContent = `${count} regla${count > 1 ? 's' : ''} seleccionada${count > 1 ? 's' : ''} para convertir`;
  } else {
    if (bar) bar.classList.add('hidden');
  }

  // Actualizar checkbox maestro del encabezado
  if (thSelectAll) {
    const selectable = State.filteredLeases.filter((l) => {
      const act = l.action || (l.ip && l.ip !== '0.0.0.0' ? 'reserved' : 'assign-ip');
      return act === 'reserved';
    });
    if (!selectable.length) {
      thSelectAll.checked = false;
      thSelectAll.disabled = true;
    } else {
      thSelectAll.disabled = false;
      thSelectAll.checked = selectable.every((l) => State.selectedLeases.has(l.id));
    }
  }
}

function applyLeaseFilters() {
  const searchVal = ($('search-input')?.value || '').trim().toLowerCase();
  const actionVal = State.actionFilter || 'ALL';

  let list = [...State.leases];

  // Filtro por Acción
  if (actionVal !== 'ALL') {
    list = list.filter((l) => {
      const act = l.action || (l.ip && l.ip !== '0.0.0.0' ? 'reserved' : 'assign');
      return actionVal === 'reserved' ? act === 'reserved' : (act === 'assign' || act === 'assign-ip');
    });
  }

  // Filtro por Búsqueda (Texto)
  if (searchVal) {
    const qClean = searchVal.replace(/[^0-9a-f]/g, '');
    const qColon = searchVal.replace(/-/g, ':');
    const qHyphen = searchVal.replace(/:/g, '-');

    list = list.filter((l) => {
      const mac = (l.mac || '').toLowerCase();
      const macPlain = mac.replace(/[^0-9a-f]/g, '');
      const macHyphen = mac.replace(/:/g, '-');
      const ip = (l.ip || '').toLowerCase();
      const desc = (l.description || '').toLowerCase();

      const matchMac =
        mac.includes(searchVal) ||
        mac.includes(qColon) ||
        macHyphen.includes(searchVal) ||
        macHyphen.includes(qHyphen) ||
        (qClean.length >= 2 && macPlain.includes(qClean));

      const matchIp = ip.includes(searchVal);
      const matchDesc = desc.includes(searchVal);

      return matchMac || matchIp || matchDesc;
    });
  }

  State.filteredLeases = list;
  applySort();
  renderLeases();
}

function handleSearch(query) {
  applyLeaseFilters();
}

// ─── Sort ──────────────────────────────────────────────────────────────────────
function applySort() {
  const { col, dir } = State.sort;
  State.filteredLeases.sort((a, b) => {
    let va = a[col] ?? '';
    let vb = b[col] ?? '';

    if (col === 'ip') {
      va = ipToNum(va);
      vb = ipToNum(vb);
    } else if (col === 'id') {
      va = Number(va);
      vb = Number(vb);
    } else {
      va = String(va).toLowerCase();
      vb = String(vb).toLowerCase();
    }

    if (va < vb) return dir === 'asc' ? -1 : 1;
    if (va > vb) return dir === 'asc' ? 1 : -1;
    return 0;
  });
}

function ipToNum(ip) {
  return ip.split('.').reduce((acc, oct) => (acc << 8) + parseInt(oct || 0, 10), 0) >>> 0;
}

// ─── Available IPs ─────────────────────────────────────────────────────────────
async function loadAvailableIPs() {
  const tbody = $('available-tbody');
  if (tbody) tbody.innerHTML = `<tr><td colspan="3" class="empty-row"><div class="loading-spinner"></div> Calculando IPs disponibles...</td></tr>`;

  try {
    const data = await API.get('/dhcp/available-ips?limit=50');
    State.availableIPs = data.available || [];
    renderAvailableIPs();
  } catch (err) {
    if (tbody) tbody.innerHTML = `<tr><td colspan="3" class="empty-row">❌ ${err.message}</td></tr>`;
    toast(`Error: ${err.message}`, 'error');
  }
}

function renderAvailableIPs() {
  const tbody = $('available-tbody');
  if (!tbody) return;

  const ips = State.availableIPs;
  if (!ips.length) {
    tbody.innerHTML = `<tr><td colspan="3" class="empty-row">No hay IPs disponibles en el pool</td></tr>`;
    return;
  }

  tbody.innerHTML = ips.map((ip, i) => `
    <tr class="available-row">
      <td class="td-id td-avail-id"><span class="cell-label-mobile">#</span>${i + 1}</td>
      <td class="td-avail-ip"><span class="ip-badge mono">${ip}</span></td>
      <td class="td-avail-action">
        <button class="btn btn-ghost btn-sm btn-quick-reserve" data-action="reserve" data-ip="${ip}">
          <span>+</span> Reservar IP
        </button>
      </td>
    </tr>
  `).join('');
}

function quickReserve(ip) {
  openAddModal();
  setActionType('reserved');
  const ipInput = $('form-ip');
  if (ipInput) {
    ipInput.value = ip;
    $('form-description').focus();
  }
}

// ─── Modal Helpers: Action Segmented Control ──────────────────────────────
function setActionType(actionVal) {
  const a = (actionVal === 'reserved') ? 'reserved' : 'assign';
  $('form-action').value = a;
  document.querySelectorAll('#action-selector .segment-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.actionType === a);
  });

  const ipGroup = $('ip-field-group');
  const suggestBtn = $('suggest-ip-btn');

  clearError('form-ip', 'err-ip');

  if (a === 'reserved') {
    // Modo Reserve IP: El textbox de IP ES VISIBLE Y OBLIGATORIO
    if (ipGroup) ipGroup.classList.remove('hidden');
    if (suggestBtn) suggestBtn.style.display = 'inline-flex';
  } else {
    // Modo Assign IP: El textbox de IP SE OCULTA (asignación dinámica por pool)
    if (ipGroup) ipGroup.classList.add('hidden');
    $('form-ip').value = '';
  }
}

// ─── Modal: Add / Edit ─────────────────────────────────────────────────────────
function openAddModal() {
  State.editingId = null;
  clearForm();
  setText('modal-title', 'Create New IP Address Assignment Rule');
  setText('modal-save-text', 'OK');
  $('form-entry-id').value = '';
  if ($('form-type')) $('form-type').value = 'mac';
  setActionType('assign');
  setText('desc-chars', '0');
  openModal('modal-overlay');
  setTimeout(() => $('form-description').focus(), 100);
}

function openEditModal(entryId) {
  const lease = State.leases.find((l) => l.id === entryId);
  if (!lease) return;

  State.editingId = entryId;
  clearForm();

  $('form-entry-id').value = entryId;
  $('form-description').value = lease.description || '';
  $('form-mac').value = lease.mac || '';
  if ($('form-type')) $('form-type').value = 'mac';

  // Deshabilitar MAC en edición (no se cambia la MAC de una regla existente)
  $('form-mac').disabled = true;
  $('form-mac').style.opacity = '.6';

  let action = lease.action;
  if (action === 'assign-ip') action = 'assign';
  if (!action) {
    action = (lease.ip && lease.ip !== '0.0.0.0') ? 'reserved' : 'assign';
  }

  // Si es assign, el campo IP queda limpio; si es reserved, se carga su IP
  $('form-ip').value = (action === 'reserved' && lease.ip && lease.ip !== '0.0.0.0') ? lease.ip : '';

  setActionType(action);
  setText('desc-chars', (lease.description || '').length);

  setText('modal-title', `Edit IP Address Assignment Rule #${entryId}`);
  setText('modal-save-text', 'OK');
  openModal('modal-overlay');
  setTimeout(() => $('form-description').focus(), 100);
}

function clearForm() {
  ['form-description', 'form-mac', 'form-ip'].forEach((id) => {
    const el = $(id);
    if (el) {
      el.value = '';
      el.classList.remove('error');
      el.disabled = false;
      el.style.opacity = '';
    }
  });
  ['err-description', 'err-mac', 'err-ip'].forEach((id) => setText(id, ''));
  setText('desc-chars', '0');
}

// ─── Modal: Delete ─────────────────────────────────────────────────────────────
function openDeleteModal(entryId) {
  const lease = State.leases.find((l) => l.id === entryId);
  if (!lease) return;

  State.pendingDelete = entryId;
  setText('delete-target-desc', lease.description || `ID ${entryId}`);
  setText('delete-target-mac', lease.mac);
  setText('delete-target-ip', lease.action === 'reserved' ? (lease.ip || '—') : 'Asignación Dinámica (Pool)');
  openModal('delete-overlay');
}

// ─── Suggest IP ────────────────────────────────────────────────────────────────
async function suggestNextIP() {
  try {
    const data = await API.get('/dhcp/available-ips?limit=1');
    const ip = data.available?.[0];
    if (ip) {
      $('form-ip').value = ip;
      toast(`IP sugerida: ${ip}`, 'info', 2500);
    } else {
      toast('No hay IPs disponibles en el pool', 'warning');
    }
  } catch (err) {
    toast(`Error: ${err.message}`, 'error');
  }
}

// ─── Validation ────────────────────────────────────────────────────────────────
function validateForm(isEdit = false) {
  let valid = true;
  const action = ($('form-action').value === 'reserved') ? 'reserved' : 'assign';

  if (!isEdit) {
    let mac = $('form-mac').value.trim();
    mac = normalizeMac(mac);
    $('form-mac').value = mac;
    const macRe = /^([0-9a-fA-F]{2}:){5}[0-9a-fA-F]{2}$/;
    if (!mac || !macRe.test(mac)) {
      setError('form-mac', 'err-mac', 'Formato MAC inválido. Ej: 00:15:5D:AE:A3:A0 o 00-15-5D-AE-A3-A0');
      valid = false;
    } else {
      clearError('form-mac', 'err-mac');
    }
  }

  // La IP del textbox SOLO es obligatoria cuando Action type es 'Reserve IP' ('reserved')
  if (action === 'reserved') {
    const ip = $('form-ip').value.trim();
    const ipRe = /^192\.168\.171\.(([1-9])|([1-9]\d)|(1\d{2})|(2[0-4]\d)|(25[0-4]))$/;
    if (!ip) {
      setError('form-ip', 'err-ip', 'La dirección IP es obligatoria para Reserve IP');
      valid = false;
    } else if (!ipRe.test(ip)) {
      setError('form-ip', 'err-ip', 'IP debe estar en el rango 192.168.171.1 - 192.168.171.254');
      valid = false;
    } else {
      clearError('form-ip', 'err-ip');
    }
  } else {
    clearError('form-ip', 'err-ip');
  }

  return valid;
}

function setError(inputId, errId, msg) {
  const input = $(inputId);
  if (input) input.classList.add('error');
  setText(errId, msg);
}

function clearError(inputId, errId) {
  const input = $(inputId);
  if (input) input.classList.remove('error');
  setText(errId, '');
}

// ─── Save (Create / Update) ────────────────────────────────────────────────────
async function saveLease() {
  const isEdit = !!State.editingId;

  if (!validateForm(isEdit)) return;

  const saveBtn = $('modal-save');
  const saveText = $('modal-save-text');
  const spinner = $('modal-spinner');

  saveBtn.disabled = true;
  saveText.textContent = 'Guardando...';
  spinner.classList.remove('hidden');

  const action = ($('form-action').value === 'reserved') ? 'reserved' : 'assign';
  const type = 'mac';
  const description = $('form-description').value.trim();
  const rawIp = $('form-ip').value.trim();
  // Solo en Reserve IP se envía la IP elegida; en Assign IP se envía vacío
  const ip = action === 'reserved' ? rawIp : '';

  try {
    if (isEdit) {
      await API.put(`/dhcp/reservations/${State.editingId}`, {
        ip,
        description,
        action,
        type,
      });
      toast('✅ Regla de asignación actualizada correctamente', 'success');
    } else {
      await API.post('/dhcp/reservations', {
        mac: $('form-mac').value.trim(),
        ip,
        description,
        action,
        type,
      });
      toast('✅ Nueva regla de asignación creada correctamente', 'success');
    }

    closeModal('modal-overlay');
    await Promise.all([loadLeases(), loadStats()]);
    if (State.currentView === 'available') loadAvailableIPs();
  } catch (err) {
    toast(`❌ ${err.message}`, 'error', 6000);
  } finally {
    saveBtn.disabled = false;
    saveText.textContent = 'OK';
    spinner.classList.add('hidden');
  }
}

// ─── Delete ────────────────────────────────────────────────────────────────────
async function confirmDelete() {
  if (!State.pendingDelete) return;

  const btn = $('delete-confirm');
  const txt = $('delete-confirm-text');
  const spinner = $('delete-spinner');

  btn.disabled = true;
  txt.textContent = 'Eliminando...';
  spinner.classList.remove('hidden');

  try {
    await API.del(`/dhcp/reservations/${State.pendingDelete}`);
    toast('✅ Reserva eliminada', 'success');
    closeModal('delete-overlay');
    State.pendingDelete = null;
    await Promise.all([loadLeases(), loadStats()]);
    if (State.currentView === 'available') loadAvailableIPs();
  } catch (err) {
    toast(`❌ ${err.message}`, 'error', 6000);
  } finally {
    btn.disabled = false;
    txt.textContent = 'Eliminar';
    spinner.classList.add('hidden');
  }
}

// ─── Bulk Convert to Assign IP ───────────────────────────────────────────────
function openBulkConvertModal() {
  const count = State.selectedLeases.size;
  if (!count) {
    toast('No hay reglas seleccionadas para convertir', 'warning');
    return;
  }

  setText('bulk-convert-count', count);
  const input = $('bulk-confirm-input');
  if (input) {
    input.value = '';
    input.classList.remove('error');
  }
  setText('err-bulk-confirm', '');

  const confirmBtn = $('bulk-convert-confirm-btn');
  if (confirmBtn) confirmBtn.disabled = true;

  openModal('bulk-convert-overlay');
  setTimeout(() => input?.focus(), 150);
}

async function confirmBulkConvert() {
  const count = State.selectedLeases.size;
  if (!count) return;

  const input = $('bulk-confirm-input');
  const val = (input?.value || '').trim();
  if (val !== 'CONVERTIR') {
    setError('bulk-confirm-input', 'err-bulk-confirm', 'Escribe exactamente "CONVERTIR" en mayúsculas para continuar.');
    input?.focus();
    return;
  }
  clearError('bulk-confirm-input', 'err-bulk-confirm');

  const btn = $('bulk-convert-confirm-btn');
  const txt = $('bulk-convert-confirm-text');
  const spinner = $('bulk-convert-spinner');

  btn.disabled = true;
  txt.textContent = 'Convirtiendo...';
  spinner.classList.remove('hidden');

  try {
    const ids = Array.from(State.selectedLeases);
    const res = await API.post('/dhcp/reservations/bulk-convert-to-assign', { ids });

    toast(res.message || `✅ Se convirtieron ${count} reglas a Assign IP exitosamente`, 'success', 4000);
    closeModal('bulk-convert-overlay');
    State.selectedLeases.clear();

    await Promise.all([loadLeases(), loadStats()]);
  } catch (err) {
    toast(`❌ Error en conversión en lote: ${err.message}`, 'error', 6000);
  } finally {
    btn.disabled = false;
    txt.textContent = 'Convertir a Assign IP';
    spinner.classList.add('hidden');
  }
}
async function logout() {
  try {
    await fetch('/auth/logout', { method: 'POST', credentials: 'same-origin' });
  } catch (_) {}
  window.location.href = '/login';
}

// ─── Export CSV ────────────────────────────────────────────────────────────────
function exportCSV() {
  const rows = [['ID', 'Descripción', 'MAC', 'IP Asignada']];
  State.filteredLeases.forEach((l) => {
    rows.push([l.id, `"${(l.description || '').replace(/"/g, '""')}"`, l.mac, l.ip]);
  });

  const csv = rows.map((r) => r.join(',')).join('\r\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `dhcp-v170-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
  toast('CSV exportado', 'success', 2500);
}

// ─── Refresh all ───────────────────────────────────────────────────────────────
async function refreshAll() {
  const btn = $('refresh-btn');
  if (btn) {
    btn.style.transform = 'rotate(360deg)';
    btn.style.transition = 'transform .6s ease';
    setTimeout(() => {
      btn.style.transform = '';
      btn.style.transition = '';
    }, 700);
  }

  await Promise.all([loadFortiStatus(), loadLeases(), loadStats()]);
  if (State.currentView === 'available') await loadAvailableIPs();
  toast('Datos actualizados', 'info', 2000);
}

// ─── MAC Normalization & Auto-format ──────────────────────────────────────────
function normalizeMac(input) {
  if (!input) return '';
  // Extraer sólo caracteres hexadecimales (0-9, a-f, A-F)
  const hexOnly = input.replace(/[^0-9a-fA-F]/g, '').toUpperCase();
  // Tomar hasta 12 caracteres hex (6 bytes)
  const trimmed = hexOnly.slice(0, 12);
  // Agrupar de a 2 caracteres y unir con dos puntos ':'
  const parts = trimmed.match(/.{1,2}/g);
  return parts ? parts.join(':') : '';
}

function formatMacInput(e) {
  const oldVal = e.target.value;
  const formatted = normalizeMac(oldVal);
  e.target.value = formatted;
}

function handleMacPaste(e) {
  e.preventDefault();
  const pastedText = (e.clipboardData || window.clipboardData)?.getData('text') || '';
  const formatted = normalizeMac(pastedText);
  e.target.value = formatted;
  clearError('form-mac', 'err-mac');
}

// ─── Utilities ─────────────────────────────────────────────────────────────────
function escapeHtml(str) {
  if (!str) return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ─── Control de Impresoras (Firewall Address Groups) ───────────────────────────
async function loadPrinterPermissions() {
  const tbody = $('printers-tbody');
  if (tbody) {
    tbody.innerHTML = `<tr><td colspan="6" class="empty-row"><div class="loading-spinner"></div> Consultando FortiGate...</td></tr>`;
  }

  try {
    const data = await API.get('/printers/permissions');
    State.printers = data.devices || [];
    State.filteredPrinters = [...State.printers];
    State.printerSummary = data.summary || {};

    // Actualizar contadores
    setText('stat-printer-ini', data.summary?.ini_count ?? '0');
    setText('stat-printer-pri', data.summary?.pri_count ?? '0');
    setText('stat-printer-sec', data.summary?.sec_count ?? '0');
    setText('printers-count', data.devices?.length ?? '0');
    setText('printer-count-badge', `${data.devices?.length ?? 0} dispositivo${(data.devices?.length ?? 0) === 1 ? '' : 's'}`);

    renderPrinterPermissions();
  } catch (err) {
    console.error('Error cargando permisos de impresoras:', err);
    if (tbody) {
      tbody.innerHTML = `<tr><td colspan="6" class="empty-row" style="color:var(--error-color,#ef4444);">❌ Error al consultar FortiGate: ${escapeHtml(err.message)}</td></tr>`;
    }
    toast(`Error al obtener permisos de impresoras: ${err.message}`, 'error', 5000);
  }
}

function renderPrinterPermissions() {
  const tbody = $('printers-tbody');
  if (!tbody) return;

  const devices = State.filteredPrinters;
  if (!devices || devices.length === 0) {
    tbody.innerHTML = `<tr><td colspan="6" class="empty-row">No hay dispositivos registrados con acceso a impresoras</td></tr>`;
    return;
  }

  tbody.innerHTML = devices.map((d) => {
    const iniBadge = d.ini
      ? `<span class="badge-printer-access badge-printer-active" title="Autorizado en CLIENT_PRINT_INI (VLAN 210)">✓ Inicial</span>`
      : `<span class="badge-printer-access badge-printer-inactive" title="Sin acceso">✕ No</span>`;

    const priBadge = d.pri
      ? `<span class="badge-printer-access badge-printer-active" title="Autorizado en CLIENT_PRINT_PRI (VLAN 220)">✓ Primaria</span>`
      : `<span class="badge-printer-access badge-printer-inactive" title="Sin acceso">✕ No</span>`;

    const secBadge = d.sec
      ? `<span class="badge-printer-access badge-printer-active" title="Autorizado en CLIENT_PRINT_SEC (VLAN 230)">✓ Secundaria</span>`
      : `<span class="badge-printer-access badge-printer-inactive" title="Sin acceso">✕ No</span>`;

    return `
      <tr>
        <td class="mono font-semibold">${escapeHtml(d.mac)}</td>
        <td>
          <div style="display:flex; flex-direction:column; gap:0.2rem;">
            <span>${escapeHtml(d.description || '—')}</span>
            ${d.ip ? `<span class="mono" style="font-size:0.75rem; color:var(--text-secondary);">IP DHCP: ${escapeHtml(d.ip)}</span>` : ''}
          </div>
        </td>
        <td style="text-align:center;">${iniBadge}</td>
        <td style="text-align:center;">${priBadge}</td>
        <td style="text-align:center;">${secBadge}</td>
        <td style="text-align:right;">
          <div class="printer-actions-cell">
            <button class="btn btn-ghost btn-xs" data-printer-action="edit" data-mac="${escapeHtml(d.mac)}" title="Editar permisos">✏️</button>
            <button class="btn btn-ghost btn-xs" data-printer-action="delete" data-mac="${escapeHtml(d.mac)}" title="Revocar todos los accesos" style="color:var(--error-color);">🗑️</button>
          </div>
        </td>
      </tr>
    `;
  }).join('');
}

function handlePrinterSearch(query) {
  const q = (query || '').toLowerCase().trim();
  if (!q) {
    State.filteredPrinters = [...State.printers];
  } else {
    State.filteredPrinters = State.printers.filter((d) => {
      const mac = (d.mac || '').toLowerCase();
      const desc = (d.description || '').toLowerCase();
      const ip = (d.ip || '').toLowerCase();
      return mac.includes(q) || desc.includes(q) || ip.includes(q);
    });
  }
  setText('printer-count-badge', `${State.filteredPrinters.length} de ${State.printers.length} dispositivos`);
  renderPrinterPermissions();
}

function openPrinterModal(mac = null) {
  const isEdit = !!mac;
  $('printer-modal-title').textContent = isEdit ? 'Editar Acceso a Impresoras' : 'Asignar Acceso a Impresoras';
  $('printer-modal-save-text').textContent = isEdit ? 'Actualizar Accesos' : 'Guardar Accesos';

  // Limpiar errores
  clearError('printer-form-mac', 'err-printer-mac');

  // Controlar visibilidad del selector de candidatos existentes (solo al agregar)
  const candidateGroup = $('group-printer-candidate-selector');
  if (candidateGroup) {
    candidateGroup.style.display = isEdit ? 'none' : 'block';
  }
  const candidateSearch = $('printer-candidate-search');
  if (candidateSearch) candidateSearch.value = '';
  closePrinterCandidateDropdown();

  if (isEdit) {
    const dev = State.printers.find((p) => p.mac.toLowerCase() === mac.toLowerCase());
    $('printer-form-mac').value = dev?.mac || mac;
    $('printer-form-mac').disabled = true;
    $('printer-form-desc').value = dev?.description || '';
    $('printer-check-ini').checked = !!dev?.ini;
    $('printer-check-pri').checked = !!dev?.pri;
    $('printer-check-sec').checked = !!dev?.sec;
  } else {
    $('printer-form-mac').value = '';
    $('printer-form-mac').disabled = false;
    $('printer-form-desc').value = '';
    $('printer-check-ini').checked = false;
    $('printer-check-pri').checked = false;
    $('printer-check-sec').checked = false;
    // Cargar lista de candidatos disponibles desde backend
    loadPrinterCandidates('');
  }

  openModal('printer-modal-overlay');
}

// ─── Selector / Buscador de Dispositivos Existentes ────────────────────────────
async function loadPrinterCandidates(query = '') {
  try {
    const qParam = query ? `?q=${encodeURIComponent(query)}` : '';
    const res = await API.get(`/printers/candidates${qParam}`);
    State.printerCandidates = res.candidates || [];
    renderPrinterCandidateDropdown();
  } catch (err) {
    console.warn('[Printer Candidates] Error buscando candidatos:', err);
  }
}

function renderPrinterCandidateDropdown() {
  const dropdown = $('printer-candidate-dropdown');
  const list = $('printer-candidate-list');
  if (!dropdown || !list) return;

  const candidates = State.printerCandidates || [];
  if (!candidates.length) {
    list.innerHTML = `<div class="printer-candidate-empty">No se encontraron dispositivos o reglas existentes</div>`;
    dropdown.classList.remove('hidden');
    return;
  }

  list.innerHTML = candidates.map((c) => {
    const desc = c.description ? escapeHtml(c.description) : 'Sin nombre asignado';
    const ipBadge = c.ip ? `<span class="printer-cand-ip mono">${escapeHtml(c.ip)}</span>` : '';
    const sourceLabel = escapeHtml(c.source || 'FortiGate');
    return `
      <div class="printer-candidate-item" data-mac="${escapeHtml(c.mac)}" data-desc="${escapeHtml(c.description || '')}">
        <div class="printer-cand-info">
          <div class="printer-cand-desc">${desc}</div>
          <div class="printer-cand-mac-line">
            <span class="printer-cand-mac mono">${escapeHtml(c.mac)}</span>
            ${ipBadge}
          </div>
        </div>
        <span class="printer-cand-source">${sourceLabel}</span>
      </div>
    `;
  }).join('');

  dropdown.classList.remove('hidden');
}

function selectPrinterCandidate(mac, desc) {
  const macInput = $('printer-form-mac');
  const descInput = $('printer-form-desc');
  const searchInput = $('printer-candidate-search');

  if (macInput) {
    macInput.value = mac;
    clearError('printer-form-mac', 'err-printer-mac');
  }
  if (descInput && desc) {
    descInput.value = desc;
  }
  if (searchInput) {
    searchInput.value = `${desc ? desc + ' · ' : ''}${mac}`;
  }

  // Si este dispositivo ya tiene accesos en la lista activa, marcar sus checkboxes
  const existingDev = State.printers.find((p) => p.mac.toLowerCase() === mac.toLowerCase());
  if (existingDev) {
    $('printer-check-ini').checked = !!existingDev.ini;
    $('printer-check-pri').checked = !!existingDev.pri;
    $('printer-check-sec').checked = !!existingDev.sec;
  }

  closePrinterCandidateDropdown();
}

function closePrinterCandidateDropdown() {
  const dropdown = $('printer-candidate-dropdown');
  if (dropdown) dropdown.classList.add('hidden');
}

async function savePrinterPermission() {
  const macInput = $('printer-form-mac');
  const mac = (macInput.value || '').trim();
  const desc = $('printer-form-desc').value.trim();
  const ini = $('printer-check-ini').checked;
  const pri = $('printer-check-pri').checked;
  const sec = $('printer-check-sec').checked;

  const macNormalized = normalizeMac(mac);
  $('printer-form-mac').value = macNormalized;
  const macRe = /^([0-9a-fA-F]{2}:){5}[0-9a-fA-F]{2}$/;

  if (!macNormalized || !macRe.test(macNormalized)) {
    setError('printer-form-mac', 'err-printer-mac', 'Ingresa una MAC válida (ej: 00:15:5D:AE:A3:A0)');
    macInput.focus();
    return;
  }
  clearError('printer-form-mac', 'err-printer-mac');

  const saveBtn = $('printer-modal-save');
  const saveText = $('printer-modal-save-text');
  const spinner = $('printer-modal-spinner');

  saveBtn.disabled = true;
  saveText.textContent = 'Aplicando en FortiGate...';
  spinner.classList.remove('hidden');

  try {
    const res = await API.post('/printers/permissions', {
      mac,
      description: desc,
      ini,
      pri,
      sec,
    });

    toast(res.message || 'Permisos de impresora actualizados', 'success');
    closeModal('printer-modal-overlay');
    await loadPrinterPermissions();
  } catch (err) {
    toast(`Error: ${err.message}`, 'error', 5000);
  } finally {
    saveBtn.disabled = false;
    saveText.textContent = macInput.disabled ? 'Actualizar Accesos' : 'Guardar Accesos';
    spinner.classList.add('hidden');
  }
}

function openPrinterDeleteModal(mac) {
  const dev = State.printers.find((p) => p.mac.toLowerCase() === mac.toLowerCase());
  State.pendingPrinterDelete = mac;
  setText('printer-delete-desc', dev?.description ? `${dev.description} (${mac})` : mac);
  setText('printer-delete-mac', mac);
  openModal('printer-delete-overlay');
}

async function confirmPrinterDelete() {
  const mac = State.pendingPrinterDelete;
  if (!mac) return;

  const btn = $('printer-delete-confirm');
  const text = $('printer-delete-confirm-text');
  const spinner = $('printer-delete-spinner');

  btn.disabled = true;
  text.textContent = 'Revocando...';
  spinner.classList.remove('hidden');

  try {
    const res = await API.del(`/printers/permissions/${encodeURIComponent(mac)}`);
    toast(res.message || 'Accesos revocados exitosamente', 'success');
    closeModal('printer-delete-overlay');
    await loadPrinterPermissions();
  } catch (err) {
    toast(`Error al revocar accesos: ${err.message}`, 'error', 5000);
  } finally {
    btn.disabled = false;
    text.textContent = 'Revocar Accesos';
    spinner.classList.add('hidden');
    State.pendingPrinterDelete = null;
  }
}

// ─── Auditoría (Admin) ────────────────────────────────────────────────────────
async function loadAuditUsers() {
  const select = $('audit-filter-user');
  if (!select) return;

  try {
    const res = await API.get('/audit/users');
    const users = res.users || [];
    const currentVal = select.value;
    select.innerHTML = '<option value="">Todas las personas</option>' +
      users.map((u) => {
        const label = u.user_name ? `${u.user_name} (${u.user_email})` : u.user_email;
        return `<option value="${escapeHtml(u.user_email)}">${escapeHtml(label)}</option>`;
      }).join('');
    if (currentVal) select.value = currentVal;
  } catch (err) {
    console.warn('Error cargando usuarios de auditoría:', err);
  }
}

async function loadAuditLogs() {
  const tbody = $('audit-tbody');
  const countBadge = $('audit-count-badge');
  if (!tbody) return;

  tbody.innerHTML = `<tr><td colspan="6" class="empty-row"><div class="loading-spinner"></div> Cargando registros de auditoría...</td></tr>`;

  const eventType = $('audit-filter-event')?.value || 'ALL';
  const userEmail = $('audit-filter-user')?.value || '';
  const search = $('audit-search-input')?.value.trim() || '';

  const params = new URLSearchParams();
  if (eventType && eventType !== 'ALL') params.append('event_type', eventType);
  if (userEmail) params.append('user_email', userEmail);
  if (search) params.append('search', search);
  params.append('limit', '100');

  try {
    const res = await API.get(`/audit/logs?${params.toString()}`);
    const logs = res.logs || [];
    if (countBadge) countBadge.textContent = `${res.total || logs.length} registro${(res.total || logs.length) === 1 ? '' : 's'}`;
    renderAuditLogs(logs);
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="6" class="empty-row" style="color:var(--error-color, #ef4444);">❌ Error cargando logs: ${escapeHtml(err.message)}</td></tr>`;
    if (countBadge) countBadge.textContent = 'Error';
  }
}

function renderAuditLogs(logs) {
  const tbody = $('audit-tbody');
  if (!tbody) return;

  if (!logs || !logs.length) {
    tbody.innerHTML = `<tr><td colspan="6" class="empty-row">No hay registros de auditoría para los filtros seleccionados</td></tr>`;
    return;
  }

  tbody.innerHTML = logs.map((log) => {
    const badge = getAuditBadge(log.event_type, log.action_status);
    const dateFormatted = formatAuditDate(log.timestamp);
    const detailsHtml = formatAuditDetails(log);
    let targetResource = '<span style="color:var(--text-secondary);font-style:italic">—</span>';
    if (log.target_mac && (log.target_ip === 'Impresoras' || log.event_type?.startsWith('PRINTER_'))) {
      targetResource = `<div style="display:flex;flex-direction:column;gap:0.2rem;"><span class="mono" style="font-weight:600;">${escapeHtml(log.target_mac)}</span><span class="audit-printer-tag">🖨️ Impresoras</span></div>`;
    } else if (log.target_mac && log.target_ip) {
      targetResource = `<span class="mono">${escapeHtml(log.target_mac)}</span><span class="mobile-resource-sep"> · </span><span class="mono audit-ip-sub">${escapeHtml(log.target_ip)}</span>`;
    } else if (log.target_mac) {
      targetResource = `<span class="mono">${escapeHtml(log.target_mac)}</span>`;
    } else if (log.target_ip) {
      targetResource = `<span class="mono audit-ip-sub">${escapeHtml(log.target_ip)}</span>`;
    }

    const userName = log.user_name || log.user_email?.split('@')[0] || 'Sistema';
    const userEmail = log.user_email || 'sistema';

    return `
      <tr class="audit-row">
        <td class="td-audit-date mono">
          <span class="audit-mobile-date">${dateFormatted}</span>
        </td>
        <td class="td-audit-user">
          <div class="audit-user-cell">
            <span class="audit-user-name">${escapeHtml(userName)}</span>
            <span class="audit-user-email mono">${escapeHtml(userEmail)}</span>
          </div>
        </td>
        <td class="td-audit-event">${badge}</td>
        <td class="td-audit-resource">
          <span class="audit-mobile-label">Recurso: </span>
          <div class="audit-resource-content">${targetResource}</div>
        </td>
        <td class="td-audit-details">
          <span class="audit-mobile-label">Detalle: </span>
          <div class="audit-details-content">${detailsHtml}</div>
        </td>
        <td class="td-audit-ip mono">
          <span class="audit-mobile-label">IP Origen: </span>
          <span class="audit-ip-val">${escapeHtml(log.client_ip || '—')}</span>
        </td>
      </tr>
    `;
  }).join('');
}

function getAuditBadge(eventType, status) {
  if (status === 'FAILED' || eventType === 'LOGIN_FAILED') {
    return `<span class="badge-event badge-event-failed">⛔ Intento Denegado</span>`;
  }
  switch (eventType) {
    case 'LOGIN':
      return `<span class="badge-event badge-event-login">🔑 Login</span>`;
    case 'LOGOUT':
      return `<span class="badge-event badge-event-logout">🚪 Logout</span>`;
    case 'CREATE':
      return `<span class="badge-event badge-event-create">➕ Alta Regla</span>`;
    case 'UPDATE':
      return `<span class="badge-event badge-event-update">✏️ Modificación</span>`;
    case 'DELETE':
      return `<span class="badge-event badge-event-delete">🗑️ Baja Regla</span>`;
    case 'PRINTER_PERM':
      return `<span class="badge-event badge-event-create">🖨️ Permisos Impresora</span>`;
    case 'PRINTER_REVOKE':
      return `<span class="badge-event badge-event-delete">🖨️ Revocación Impresora</span>`;
    default:
      return `<span class="badge-event">${escapeHtml(eventType)}</span>`;
  }
}

function formatAuditDate(isoStr) {
  if (!isoStr) return '—';
  try {
    const d = new Date(isoStr);
    return d.toLocaleString('es-AR', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  } catch {
    return isoStr;
  }
}

function formatAuditDetails(log) {
  let text = escapeHtml(log.description || '');
  const d = log.details;

  // Formato detallado para asignación / modificación de permisos de impresoras
  if (log.event_type === 'PRINTER_PERM') {
    const descText = log.description ? `<div class="audit-printer-desc">"${escapeHtml(log.description)}"</div>` : '';
    const objText = d?.object_name ? `<div class="audit-printer-object mono">${escapeHtml(d.object_name)}</div>` : '';
    
    // Si tenemos desglose booleano de accesos actuales o cambios
    let badgesHtml = '';
    if (d && (d.ini !== undefined || d.pri !== undefined || d.sec !== undefined)) {
      const iniBadge = `<span class="audit-printer-badge ${d.ini ? 'active' : 'inactive'}">Inicial (V210): ${d.ini ? '✓ Sí' : '✗ No'}</span>`;
      const priBadge = `<span class="audit-printer-badge ${d.pri ? 'active' : 'inactive'}">Primaria (V220): ${d.pri ? '✓ Sí' : '✗ No'}</span>`;
      const secBadge = `<span class="audit-printer-badge ${d.sec ? 'active' : 'inactive'}">Secundaria (V230): ${d.sec ? '✓ Sí' : '✗ No'}</span>`;
      badgesHtml = `<div class="audit-printer-badges">${iniBadge}${priBadge}${secBadge}</div>`;
    } else if (d?.changes) {
      badgesHtml = `<div class="audit-printer-object" style="color:var(--text-primary);font-weight:600;">${escapeHtml(d.changes)}</div>`;
    }

    return `
      <div class="audit-printer-details">
        ${descText}
        ${badgesHtml}
        ${objText}
      </div>
    `;
  }

  // Formato para revocación de accesos de impresora
  if (log.event_type === 'PRINTER_REVOKE') {
    const objText = d?.object_name ? `<span class="audit-printer-object mono">(${escapeHtml(d.object_name)})</span>` : '';
    return `
      <div class="audit-printer-details">
        <div style="color: #b91c1c; font-weight: 500;">Revocados todos los accesos de impresora ${objText}</div>
        <div class="audit-printer-badges">
          <span class="audit-printer-badge removed">-Inicial (V210)</span>
          <span class="audit-printer-badge removed">-Primaria (V220)</span>
          <span class="audit-printer-badge removed">-Secundaria (V230)</span>
        </div>
      </div>
    `;
  }

  if (log.event_type === 'UPDATE' && d?.previous && d?.updated) {
    const diffs = [];
    if (d.previous.action !== d.updated.action) {
      diffs.push(`
        <div class="audit-diff-row">
          <span>Acción:</span>
          <span class="audit-diff-old">${escapeHtml(d.previous.action)}</span>
          <span class="audit-diff-arrow">➜</span>
          <span class="audit-diff-new">${escapeHtml(d.updated.action)}</span>
        </div>
      `);
    }
    if (d.previous.ip !== d.updated.ip) {
      diffs.push(`
        <div class="audit-diff-row">
          <span>IP:</span>
          <span class="audit-diff-old mono">${escapeHtml(d.previous.ip || 'Dinámica')}</span>
          <span class="audit-diff-arrow">➜</span>
          <span class="audit-diff-new mono">${escapeHtml(d.updated.ip || 'Dinámica')}</span>
        </div>
      `);
    }
    if (d.previous.description !== d.updated.description) {
      diffs.push(`
        <div class="audit-diff-row">
          <span>Desc:</span>
          <span class="audit-diff-old">"${escapeHtml(d.previous.description || '—')}"</span>
          <span class="audit-diff-arrow">➜</span>
          <span class="audit-diff-new">"${escapeHtml(d.updated.description || '—')}"</span>
        </div>
      `);
    }
    if (diffs.length) {
      return `<div class="audit-diff">${diffs.join('')}</div>`;
    }
  }

  return text || '<span style="color:var(--text-secondary);font-style:italic">Operación registrada</span>';
}

// ─── Event Listeners ──────────────────────────────────────────────────────────
function initEvents() {
  // Navigation
  document.querySelectorAll('.nav-item').forEach((el) => {
    el.addEventListener('click', (e) => {
      e.preventDefault();
      switchView(el.dataset.view);
      // Auto-cerrar sidebar en pantallas táctiles/móviles
      if (window.innerWidth <= 768) {
        $('sidebar')?.classList.remove('open');
        $('sidebar-backdrop')?.classList.remove('open');
      }
    });
  });

  // Sidebar toggle (mobile)
  const toggleSidebar = () => {
    const isOpen = $('sidebar')?.classList.toggle('open');
    $('sidebar-backdrop')?.classList.toggle('open', isOpen);
  };

  const closeSidebar = () => {
    $('sidebar')?.classList.remove('open');
    $('sidebar-backdrop')?.classList.remove('open');
  };

  $('menu-toggle')?.addEventListener('click', toggleSidebar);
  $('sidebar-backdrop')?.addEventListener('click', closeSidebar);

  // Refresh
  $('refresh-btn')?.addEventListener('click', refreshAll);

  // Delegación de eventos para la tabla de arrendamientos (evita violaciones de CSP)
  $('leases-tbody')?.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-action]');
    if (btn) {
      const action = btn.dataset.action;
      const id = parseInt(btn.dataset.id, 10);
      if (action === 'edit') openEditModal(id);
      else if (action === 'delete') openDeleteModal(id);
      return;
    }

    // Manejo de checkbox de selección múltiple por fila
    const check = e.target.closest('.lease-item-check');
    if (check) {
      const id = parseInt(check.dataset.id, 10);
      if (check.checked) {
        State.selectedLeases.add(id);
      } else {
        State.selectedLeases.delete(id);
      }
      const row = check.closest('tr');
      if (row) row.classList.toggle('selected', check.checked);
      updateBulkActionBar();
    }
  });

  // Filtro por tipo de Acción (Reserve IP / Assign IP / ALL)
  $('filter-action')?.addEventListener('change', (e) => {
    State.actionFilter = e.target.value;
    applyLeaseFilters();
  });

  // Checkbox de selección maestro (th-select-all)
  $('th-select-all')?.addEventListener('change', (e) => {
    const checked = e.target.checked;
    const selectable = State.filteredLeases.filter((l) => {
      const act = l.action || (l.ip && l.ip !== '0.0.0.0' ? 'reserved' : 'assign-ip');
      return act === 'reserved';
    });

    selectable.forEach((l) => {
      if (checked) {
        State.selectedLeases.add(l.id);
      } else {
        State.selectedLeases.delete(l.id);
      }
    });

    renderLeases();
  });

  // Botones de la barra de acciones en lote
  $('bulk-convert-btn')?.addEventListener('click', openBulkConvertModal);
  $('bulk-cancel-btn')?.addEventListener('click', () => {
    State.selectedLeases.clear();
    renderLeases();
  });

  // Modal de confirmación en lote
  $('bulk-convert-close')?.addEventListener('click', () => closeModal('bulk-convert-overlay'));
  $('bulk-convert-cancel')?.addEventListener('click', () => closeModal('bulk-convert-overlay'));
  $('bulk-convert-overlay')?.addEventListener('click', (e) => {
    if (e.target === $('bulk-convert-overlay')) closeModal('bulk-convert-overlay');
  });

  // Validación de texto de confirmación "CONVERTIR"
  $('bulk-confirm-input')?.addEventListener('input', (e) => {
    const val = e.target.value.trim();
    const btn = $('bulk-convert-confirm-btn');
    if (btn) btn.disabled = (val !== 'CONVERTIR');
    if (val === 'CONVERTIR') clearError('bulk-confirm-input', 'err-bulk-confirm');
  });

  $('bulk-convert-confirm-btn')?.addEventListener('click', confirmBulkConvert);

  // Delegación de eventos para la tabla de IPs disponibles
  $('available-tbody')?.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-action="reserve"]');
    if (!btn) return;
    const ip = btn.dataset.ip;
    if (ip) quickReserve(ip);
  });

  // Selector segmentado de Action Type (estilo FortiGate)
  $('action-selector')?.addEventListener('click', (e) => {
    const btn = e.target.closest('.segment-btn');
    if (btn && btn.dataset.actionType) setActionType(btn.dataset.actionType);
  });

  // Contador de caracteres de Description en tiempo real (0/255)
  $('form-description')?.addEventListener('input', (e) => {
    setText('desc-chars', e.target.value.length);
  });

  // Add buttons
  $('add-lease-btn')?.addEventListener('click', openAddModal);
  $('dash-add-btn')?.addEventListener('click', () => {
    switchView('leases');
    setTimeout(openAddModal, 150);
  });

  // Modal close
  $('modal-close')?.addEventListener('click', () => closeModal('modal-overlay'));
  $('modal-cancel')?.addEventListener('click', () => closeModal('modal-overlay'));
  $('modal-overlay')?.addEventListener('click', (e) => {
    if (e.target === $('modal-overlay')) closeModal('modal-overlay');
  });

  // Modal save
  $('modal-save')?.addEventListener('click', saveLease);

  // Keyboard: Enter submits form
  $('lease-form')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.tagName === 'INPUT') saveLease();
  });

  // Delete modal
  $('delete-close')?.addEventListener('click', () => closeModal('delete-overlay'));
  $('delete-cancel')?.addEventListener('click', () => closeModal('delete-overlay'));
  $('delete-overlay')?.addEventListener('click', (e) => {
    if (e.target === $('delete-overlay')) closeModal('delete-overlay');
  });
  $('delete-confirm')?.addEventListener('click', confirmDelete);

  // Search
  $('search-input')?.addEventListener('input', (e) => {
    clearTimeout(State.searchDebounce);
    State.searchDebounce = setTimeout(() => handleSearch(e.target.value), 220);
  });

  $('search-clear')?.addEventListener('click', () => {
    $('search-input').value = '';
    handleSearch('');
  });

  // Sort columns
  document.querySelectorAll('.th-sortable').forEach((th) => {
    th.addEventListener('click', () => {
      const col = th.dataset.col;
      if (State.sort.col === col) {
        State.sort.dir = State.sort.dir === 'asc' ? 'desc' : 'asc';
      } else {
        State.sort.col = col;
        State.sort.dir = 'asc';
      }

      document.querySelectorAll('.th-sortable').forEach((t) => {
        t.classList.remove('asc', 'desc');
      });
      th.classList.add(State.sort.dir);

      applySort();
      renderLeases();
    });
  });

  // Export
  $('export-csv-btn')?.addEventListener('click', exportCSV);

  // Suggest IP
  $('suggest-ip-btn')?.addEventListener('click', suggestNextIP);

  // Reload available
  $('reload-available-btn')?.addEventListener('click', loadAvailableIPs);

  // Logout
  $('logout-btn')?.addEventListener('click', logout);

  // MAC auto-formatting & clipboard paste handling (XX:XX:XX:XX:XX:XX, XX-XX-XX-XX-XX-XX, XXXXXXXXXXXX)
  $('form-mac')?.addEventListener('input', formatMacInput);
  $('form-mac')?.addEventListener('paste', handleMacPaste);
  $('form-mac')?.addEventListener('blur', (e) => {
    e.target.value = normalizeMac(e.target.value);
  });

  // Auditoría (Admin)
  $('audit-refresh-btn')?.addEventListener('click', () => {
    loadAuditUsers();
    loadAuditLogs();
  });
  $('audit-filter-event')?.addEventListener('change', loadAuditLogs);
  $('audit-filter-user')?.addEventListener('change', loadAuditLogs);
  $('audit-search-input')?.addEventListener('input', () => {
    clearTimeout(State.auditDebounce);
    State.auditDebounce = setTimeout(loadAuditLogs, 250);
  });

  // Control de Acceso a Impresoras
  $('add-printer-perm-btn')?.addEventListener('click', () => openPrinterModal());
  $('printer-refresh-btn')?.addEventListener('click', loadPrinterPermissions);
  $('printer-search-input')?.addEventListener('input', (e) => {
    clearTimeout(State.printerDebounce);
    State.printerDebounce = setTimeout(() => handlePrinterSearch(e.target.value), 200);
  });

  // Delegación de eventos en la tabla de impresoras
  $('printers-tbody')?.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-printer-action]');
    if (!btn) return;
    const action = btn.dataset.printerAction;
    const mac = btn.dataset.mac;
    if (action === 'edit') openPrinterModal(mac);
    else if (action === 'delete') openPrinterDeleteModal(mac);
  });

  // Modales de Impresoras
  $('printer-modal-close')?.addEventListener('click', () => closeModal('printer-modal-overlay'));
  $('printer-modal-cancel')?.addEventListener('click', () => closeModal('printer-modal-overlay'));
  $('printer-modal-overlay')?.addEventListener('click', (e) => {
    if (e.target === $('printer-modal-overlay')) closeModal('printer-modal-overlay');
  });
  $('printer-modal-save')?.addEventListener('click', savePrinterPermission);

  $('printer-delete-close')?.addEventListener('click', () => closeModal('printer-delete-overlay'));
  $('printer-delete-cancel')?.addEventListener('click', () => closeModal('printer-delete-overlay'));
  $('printer-delete-overlay')?.addEventListener('click', (e) => {
    if (e.target === $('printer-delete-overlay')) closeModal('printer-delete-overlay');
  });
  $('printer-delete-confirm')?.addEventListener('click', confirmPrinterDelete);

  // Auto-formato de MAC en modal de impresoras
  $('printer-form-mac')?.addEventListener('input', formatMacInput);
  $('printer-form-mac')?.addEventListener('paste', handleMacPaste);
  $('printer-form-mac')?.addEventListener('blur', (e) => {
    e.target.value = normalizeMac(e.target.value);
  });

  // Buscador de Candidatos en Modal de Impresoras
  $('printer-candidate-search')?.addEventListener('input', (e) => {
    clearTimeout(State.candidateDebounce);
    const val = e.target.value;
    State.candidateDebounce = setTimeout(() => loadPrinterCandidates(val), 200);
  });

  $('printer-candidate-search')?.addEventListener('focus', () => {
    const val = $('printer-candidate-search').value;
    loadPrinterCandidates(val);
  });

  $('printer-candidate-clear')?.addEventListener('click', () => {
    const searchInput = $('printer-candidate-search');
    if (searchInput) {
      searchInput.value = '';
      loadPrinterCandidates('');
    }
  });

  // Selección de candidato al hacer clic en un item de la lista
  $('printer-candidate-list')?.addEventListener('click', (e) => {
    const item = e.target.closest('.printer-candidate-item');
    if (!item) return;
    const mac = item.dataset.mac;
    const desc = item.dataset.desc;
    if (mac) selectPrinterCandidate(mac, desc);
  });

  // Cerrar dropdown si se hace clic fuera del buscador de candidatos
  document.addEventListener('click', (e) => {
    if (!e.target.closest('#group-printer-candidate-selector')) {
      closePrinterCandidateDropdown();
    }
  });

  // Keyboard: Escape closes modals
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      closeModal('modal-overlay');
      closeModal('delete-overlay');
      closeModal('printer-modal-overlay');
      closeModal('printer-delete-overlay');
    }
  });
}

// ─── Init ──────────────────────────────────────────────────────────────────────
async function init() {
  initEvents();

  // Load user info and parallel data
  await loadUser();
  await Promise.all([loadFortiStatus(), loadLeases(), loadStats(), loadPrinterPermissions()]);

  // Auto-refresh every 60 seconds
  setInterval(() => {
    loadLeases();
    loadStats();
    loadFortiStatus();
    if (State.currentView === 'printers') loadPrinterPermissions();
  }, 60_000);
}

// Exponer funciones necesarias para interacción en ventana global
window.openEditModal = openEditModal;
window.openDeleteModal = openDeleteModal;
window.openAddModal = openAddModal;
window.openPrinterModal = openPrinterModal;
window.openPrinterDeleteModal = openPrinterDeleteModal;
window.quickReserve = quickReserve;
window.refreshAll = refreshAll;
window.exportCSV = exportCSV;

document.addEventListener('DOMContentLoaded', init);