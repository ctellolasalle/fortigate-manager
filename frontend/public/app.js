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
  stats: null,
  fortiStatus: null,
  currentView: 'dashboard',
  sort: { col: 'ip', dir: 'asc' },
  searchDebounce: null,
  pendingDelete: null,
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
  };
  setText('breadcrumb', titles[name] || name);

  // Load data for view
  if (name === 'available') loadAvailableIPs();
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
    State.filteredLeases = [...State.leases];

    // Badge en sidebar
    setText('leases-count', State.leases.length);

    applySort();
    renderLeases();
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
    tbody.innerHTML = `<tr><td colspan="6" class="empty-row">No hay arrendamientos que coincidan con la búsqueda</td></tr>`;
    return;
  }

  tbody.innerHTML = leases.map((l) => {
    const action = l.action || (l.ip && l.ip !== '0.0.0.0' ? 'assign-ip' : 'block');
    let actionBadge = `<span class="badge-action badge-action-assign">Assign IP</span>`;
    if (action === 'block') {
      actionBadge = `<span class="badge-action badge-action-block">Block</span>`;
    } else if (action === 'reserved') {
      actionBadge = `<span class="badge-action badge-action-reserved">Reserve IP</span>`;
    }

    const ipDisplay = action === 'block'
      ? `<span style="color:var(--text-secondary);font-style:italic">Blocked</span>`
      : (l.ip || '<span style="color:var(--text-secondary);font-style:italic">—</span>');

    return `
      <tr>
        <td class="td-id">${l.id}</td>
        <td class="td-desc">${escapeHtml(l.description) || '<span style="color:var(--text-secondary);font-style:italic">Sin descripción</span>'}</td>
        <td class="td-mac">${l.mac}</td>
        <td>${actionBadge}</td>
        <td class="td-ip">${ipDisplay}</td>
        <td class="td-actions">
          <button class="btn btn-ghost btn-icon btn-sm" data-action="edit" data-id="${l.id}" title="Editar">✏️</button>
          <button class="btn btn-ghost btn-icon btn-sm" data-action="delete" data-id="${l.id}" title="Eliminar" style="color:var(--error-color, #ef4444)">🗑️</button>
        </td>
      </tr>
    `;
  }).join('');
}

function renderRecentLeases(tbody) {
  if (!tbody) return;
  const recent = [...State.leases].slice(0, 8);

  if (!recent.length) {
    tbody.innerHTML = `<tr><td colspan="3" class="empty-row">No hay arrendamientos</td></tr>`;
    return;
  }

  tbody.innerHTML = recent.map((l) => `
    <tr>
      <td class="td-desc">${escapeHtml(l.description) || '—'}</td>
      <td class="td-mac">${l.mac}</td>
      <td class="td-ip">${l.ip}</td>
    </tr>
  `).join('');
}

// ─── Search ────────────────────────────────────────────────────────────────────
function handleSearch(query) {
  const q = query.trim().toLowerCase();
  if (!q) {
    State.filteredLeases = [...State.leases];
  } else {
    // Normalizar término de búsqueda para comparar en varios formatos
    const qClean = q.replace(/[^0-9a-f]/g, '');
    const qColon = q.replace(/-/g, ':');
    const qHyphen = q.replace(/:/g, '-');

    State.filteredLeases = State.leases.filter((l) => {
      const mac = (l.mac || '').toLowerCase();
      const macPlain = mac.replace(/[^0-9a-f]/g, '');
      const macHyphen = mac.replace(/:/g, '-');
      const ip = (l.ip || '').toLowerCase();
      const desc = (l.description || '').toLowerCase();

      // Búsqueda inteligente de MAC (admite '00:15:...', '00-15-...', '00155daea3a0' o fragmentos)
      const matchMac =
        mac.includes(q) ||
        mac.includes(qColon) ||
        macHyphen.includes(q) ||
        macHyphen.includes(qHyphen) ||
        (qClean.length >= 2 && macPlain.includes(qClean));

      const matchIp = ip.includes(q);
      const matchDesc = desc.includes(q);

      return matchMac || matchIp || matchDesc;
    });
  }
  applySort();
  renderLeases();
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
    <tr>
      <td class="td-id">${i + 1}</td>
      <td><span class="ip-badge">${ip}</span></td>
      <td>
        <button class="btn btn-ghost btn-sm" data-action="reserve" data-ip="${ip}">+ Reservar esta IP</button>
      </td>
    </tr>
  `).join('');
}

function quickReserve(ip) {
  openAddModal();
  const ipInput = $('form-ip');
  if (ipInput) {
    ipInput.value = ip;
    $('form-description').focus();
  }
}

// ─── Modal Helpers: Action Segmented Control ──────────────────────────────
function setActionType(actionVal) {
  const a = actionVal || 'assign-ip';
  $('form-action').value = a;
  document.querySelectorAll('#action-selector .segment-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.actionType === a);
  });

  const ipGroup = $('ip-field-group');
  const blockNotice = $('block-notice-box');
  const suggestBtn = $('suggest-ip-btn');

  if (a === 'block') {
    if (ipGroup) ipGroup.classList.add('hidden');
    if (blockNotice) blockNotice.classList.remove('hidden');
    clearError('form-ip', 'err-ip');
  } else {
    if (ipGroup) ipGroup.classList.remove('hidden');
    if (blockNotice) blockNotice.classList.add('hidden');
    if (suggestBtn) suggestBtn.style.display = 'inline-flex';
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
  setActionType('assign-ip');
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
  $('form-ip').value = (lease.ip && lease.ip !== '0.0.0.0') ? lease.ip : '';
  if ($('form-type')) $('form-type').value = 'mac';

  // Deshabilitar MAC en edición (no se cambia la MAC de una regla existente)
  $('form-mac').disabled = true;
  $('form-mac').style.opacity = '.6';

  const action = lease.action || (lease.ip && lease.ip !== '0.0.0.0' ? 'assign-ip' : 'block');
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
  setText('delete-target-ip', lease.action === 'block' ? 'Bloqueado (sin IP)' : (lease.ip || '—'));
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
  const action = $('form-action').value || 'assign-ip';

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

  // La IP NO es obligatoria para ninguna acción. Si se ingresa una IP, se valida el rango.
  const ip = $('form-ip').value.trim();
  if (action !== 'block' && ip) {
    const ipRe = /^192\.168\.171\.(([1-9])|([1-9]\d)|(1\d{2})|(2[0-4]\d)|(25[0-4]))$/;
    if (!ipRe.test(ip)) {
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

  const action = $('form-action').value || 'assign-ip';
  const type = 'mac';
  const description = $('form-description').value.trim();
  const rawIp = $('form-ip').value.trim();
  const ip = action === 'block' ? '0.0.0.0' : (rawIp || '0.0.0.0');

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

// ─── Logout ────────────────────────────────────────────────────────────────────
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
    if (!btn) return;
    const action = btn.dataset.action;
    const id = parseInt(btn.dataset.id, 10);
    if (action === 'edit') openEditModal(id);
    else if (action === 'delete') openDeleteModal(id);
  });

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

  // Keyboard: Escape closes modals
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      closeModal('modal-overlay');
      closeModal('delete-overlay');
    }
  });
}

// ─── Init ──────────────────────────────────────────────────────────────────────
async function init() {
  initEvents();

  // Load user info and parallel data
  await loadUser();
  await Promise.all([loadFortiStatus(), loadLeases(), loadStats()]);

  // Auto-refresh every 60 seconds
  setInterval(() => {
    loadLeases();
    loadStats();
    loadFortiStatus();
  }, 60_000);
}

// Exponer funciones necesarias para interacción en ventana global
window.openEditModal = openEditModal;
window.openDeleteModal = openDeleteModal;
window.openAddModal = openAddModal;
window.quickReserve = quickReserve;
window.refreshAll = refreshAll;
window.exportCSV = exportCSV;

document.addEventListener('DOMContentLoaded', init);