// Configuracion global
const API_BASE = '';
let socket;
let currentDevices = {};
let selectedDevice = null;
let availableMembers = [];
let currentMembers = [];

// Variables de autenticación
let currentUser = null;
let authCheckInterval = null;

// Inicializacion de la aplicacion
document.addEventListener('DOMContentLoaded', function() {
    console.log('DOM cargado, iniciando aplicacion con autenticacion...');
    
    // Verificar si estamos en la pagina de login
    if (window.location.pathname === '/login') {
        console.log('En pagina de login, saltando inicializacion de app');
        return;
    }
    
    // Inicializar la aplicacion (que ahora incluye verificacion de auth)
    initializeApp();
    setupEventListeners();
    checkConnectionStatus();
    
    // Agregar listener para errores globales no manejados
    window.addEventListener('error', function(e) {
        console.error('Error global:', e.error);
        handleConnectionError(e.error, 'aplicacion');
    });
    
    // Manejar promesas rechazadas globalmente
    window.addEventListener('unhandledrejection', function(e) {
        console.error('Promesa rechazada:', e.reason);
        handleConnectionError(e.reason, 'promesa');
        e.preventDefault();
    });
});

function initializeApp() {
    console.log('Inicializando FortiGate Manager...');
    
    // PRIMERO verificar autenticacion antes de continuar
    checkAuthStatus().then(() => {
        // Solo continuar si esta autenticado
        setupTabs();
        setupMacInputs();
        
        // Cargar datos iniciales con delay
        setTimeout(() => {
            loadDevices();
            loadGroups();
        }, 1000);
        
        // Configurar verificacion periodica de autenticacion
        authCheckInterval = setInterval(checkAuthStatus, 5 * 60 * 1000); // cada 5 minutos
        
        // Conectar WebSocket después de autenticación
        connectWebSocket();
        
    }).catch(error => {
        console.error('Error de autenticacion inicial:', error);
        redirectToLogin();
    });
}

async function checkAuthStatus() {
    try {
        const response = await fetch('/auth/status');
        
        if (!response.ok) {
            throw new Error('Error verificando autenticacion');
        }
        
        const data = await response.json();
        
        if (data.authenticated) {
            currentUser = data.user;
            updateUserInterface(data.user);
            
            // Ocultar loading y mostrar la app
            document.getElementById('loading-overlay').style.display = 'none';
            document.querySelector('.app-container').style.display = 'block';
            
            return Promise.resolve();
        } else {
            // No autenticado, redirigir
            redirectToLogin();
            return Promise.reject('No autenticado');
        }
    } catch (error) {
        console.error('Error verificando autenticacion:', error);
        redirectToLogin();
        return Promise.reject(error);
    }
}

function updateUserInterface(user) {
    const headerTitle = document.querySelector('.header-title');
    if (headerTitle) {
        headerTitle.innerHTML = `
            <div style="display: flex; align-items: center; justify-content: space-between; width: 100%;">
                <div>
                    <h1></h1>
                    <p></p>
                </div>
                <div style="display: flex; align-items: center; gap: 1rem; color: white;">
                    <div style="display: flex; align-items: center; gap: 0.5rem;">
                        <img src="${user.photo}" alt="Avatar" style="width: 32px; height: 32px; border-radius: 50%; border: 2px solid rgba(255,255,255,0.3);">
                        <div style="display: flex; flex-direction: column; align-items: flex-start;">
                            <span style="font-size: 0.9rem; font-weight: 500;">${user.name}</span>
                            <span style="font-size: 0.75rem; opacity: 0.8;">${user.email}</span>
                        </div>
                    </div>
                    ${user.isAdmin ? '<span style="background: rgba(255,193,7,0.2); color: #ffc107; padding: 0.25rem 0.5rem; border-radius: 4px; font-size: 0.7rem; font-weight: 500; border: 1px solid rgba(255,193,7,0.3);">ADMIN</span>' : ''}
                    <button id="logoutBtn" style="padding: 0.5rem 1rem; background: rgba(255,255,255,0.2); border: 1px solid rgba(255,255,255,0.3); border-radius: 6px; color: white; cursor: pointer; font-size: 0.8rem; transition: all 0.2s ease;" onmouseover="this.style.background='rgba(255,255,255,0.3)'" onmouseout="this.style.background='rgba(255,255,255,0.2)'">
                        🚪 Cerrar Sesion
                    </button>
                </div>
            </div>
        `;
        
        // Agregar event listener al botón
        const logoutBtn = document.getElementById('logoutBtn');
        if (logoutBtn) {
            logoutBtn.addEventListener('click', logout);
        }
    }
    
    // Mostrar notificacion de bienvenida (solo la primera vez)
    if (!sessionStorage.getItem('welcomeShown')) {
        showNotification('success', 'Bienvenido', `Hola ${user.name}, sesion iniciada correctamente`);
        sessionStorage.setItem('welcomeShown', 'true');
    }
}

function redirectToLogin() {
    // Limpiar interval de verificacion
    if (authCheckInterval) {
        clearInterval(authCheckInterval);
    }
    
    // Ocultar loading y mostrar la app
    document.getElementById('loading-overlay').style.display = 'none';
    
    // Limpiar storage local
    sessionStorage.clear();
    
    // Mostrar mensaje y redirigir
    showNotification('warning', 'Sesion requerida', 'Redirigiendo al login...');
    
    setTimeout(() => {
        window.location.href = '/login';
    }, 1500);
}

async function logout() {
    try {
        // Mostrar confirmacion
        if (!confirm('¿Estas seguro de que deseas cerrar sesion?')) {
            return;
        }
        
        // Deshabilitar interfaz temporalmente
        document.body.style.pointerEvents = 'none';
        
        const response = await fetch('/auth/logout', { 
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            }
        });
        
        const data = await response.json();
        
        if (data.success) {
            showNotification('success', 'Sesion cerrada', 'Has cerrado sesion exitosamente');
            
            // Limpiar datos locales
            currentUser = null;
            sessionStorage.clear();
            
            // Limpiar interval
            if (authCheckInterval) {
                clearInterval(authCheckInterval);
            }
            
            // Redirigir al login
            setTimeout(() => {
                window.location.href = '/login';
            }, 1000);
        } else {
            document.body.style.pointerEvents = 'auto';
            showNotification('error', 'Error', data.message || 'Error al cerrar sesion');
        }
    } catch (error) {
        console.error('Error en logout:', error);
        document.body.style.pointerEvents = 'auto';
        showNotification('error', 'Error', 'Error de comunicacion al cerrar sesion');
    }
}

function setupEventListeners() {
    // Botones de estado
    document.getElementById('reconnectBtn').addEventListener('click', reconnect);
    document.getElementById('diagnoseBtn').addEventListener('click', showDiagnostic);
    
    // Botones de dispositivos
    document.getElementById('refreshDevicesBtn').addEventListener('click', loadDevices);
    document.getElementById('typeFilter').addEventListener('change', loadDevices);
    document.getElementById('deviceForm').addEventListener('submit', saveDevice);
    document.getElementById('deleteDeviceBtn').addEventListener('click', deleteDevice);
    document.getElementById('clearFormBtn').addEventListener('click', clearDeviceForm);
    
    // Botones de grupos
    document.getElementById('refreshGroupBtn').addEventListener('click', loadGroups);
    document.getElementById('addMemberBtn').addEventListener('click', addMembers);
    document.getElementById('removeMemberBtn').addEventListener('click', removeMembers);
    document.getElementById('saveGroupBtn').addEventListener('click', saveGroup);
    
    // Modal de diagnostico
    document.getElementById('closeDiagnosticModal').addEventListener('click', closeDiagnosticModal);
    
    // Cerrar modal al hacer clic fuera
    document.getElementById('diagnosticModal').addEventListener('click', function(e) {
        if (e.target === this) {
            closeDiagnosticModal();
        }
    });
    
    // Event listeners para teclado (mejoras de UX)
    document.addEventListener('keydown', function(e) {
        // Esc para cerrar modales
        if (e.key === 'Escape') {
            closeDiagnosticModal();
        }
        
        // Ctrl+L para logout (atajo rapido)
        if (e.ctrlKey && e.key === 'l') {
            e.preventDefault();
            logout();
        }
    });
    
    // Detectar visibilidad de la pestaña para pausar/reanudar verificaciones
    document.addEventListener('visibilitychange', function() {
        if (document.hidden) {
            // Pausar verificaciones cuando la pestaña esta oculta
            if (authCheckInterval) {
                clearInterval(authCheckInterval);
            }
        } else {
            // Reanudar verificaciones cuando la pestaña vuelve a estar visible
            checkAuthStatus().catch(() => {
                // Error manejado por la funcion
            });
            authCheckInterval = setInterval(checkAuthStatus, 5 * 60 * 1000);
        }
    });
}

function setupTabs() {
    const tabButtons = document.querySelectorAll('.tab-button');
    const tabContents = document.querySelectorAll('.tab-content');
    
    tabButtons.forEach(button => {
        button.addEventListener('click', function() {
            const targetTab = this.getAttribute('data-tab');
            
            // Remover clases activas
            tabButtons.forEach(btn => btn.classList.remove('active'));
            tabContents.forEach(content => content.classList.remove('active'));
            
            // Agregar clase activa
            this.classList.add('active');
            document.getElementById(targetTab + 'Tab').classList.add('active');
            
            // Cargar datos si es necesario
            if (targetTab === 'devices') {
                loadDevices();
            } else if (targetTab === 'groups') {
                loadGroups();
            }
        });
    });
}

function setupMacInputs() {
    const macInputs = document.querySelectorAll('.mac-input');
    
    macInputs.forEach((input, index) => {
        input.addEventListener('input', function(e) {
            let value = e.target.value.toUpperCase();
            
            // Solo permitir caracteres hexadecimales
            value = value.replace(/[^0-9A-F]/g, '');
            
            // Limitar a 2 caracteres
            if (value.length > 2) {
                value = value.slice(0, 2);
            }
            
            e.target.value = value;
            
            // Auto-avanzar al siguiente campo
            if (value.length === 2 && index < macInputs.length - 1) {
                macInputs[index + 1].focus();
            }
        });
        
        input.addEventListener('keydown', function(e) {
            // Permitir backspace para retroceder
            if (e.key === 'Backspace' && this.value === '' && index > 0) {
                macInputs[index - 1].focus();
            }
        });
        
        input.addEventListener('focus', function() {
            this.select();
        });
    });
}

function connectWebSocket() {
    // Solo conectar WebSocket si esta autenticado
    if (!currentUser) {
        console.log('WebSocket: Esperando autenticacion...');
        return;
    }
    
    const socketUrl = window.location.hostname === 'localhost' 
    ? 'http://localhost:3000' 
    : window.location.origin;

    socket = io(socketUrl, {
    transports: ['websocket', 'polling'],
    upgrade: true,
    rememberUpgrade: true
    });
    
    socket.on('connect', function() {
        console.log('WebSocket conectado para usuario:', currentUser.email);
        showNotification('info', 'Conexion establecida', 'WebSocket conectado exitosamente');
    });
    
    socket.on('connection_status', function(data) {
        updateConnectionStatus(data.connected, data.message);
    });
    
    socket.on('object_updated', function(data) {
        const message = data.user ? 
            `El objeto ${data.name} ha sido actualizado por ${data.user}` : 
            `El objeto ${data.name} ha sido actualizado`;
        showNotification('success', 'Objeto actualizado', message);
        loadDevices();
    });
    
    socket.on('object_deleted', function(data) {
        const message = data.user ? 
            `El objeto ${data.name} ha sido eliminado por ${data.user}` : 
            `El objeto ${data.name} ha sido eliminado`;
        showNotification('info', 'Objeto eliminado', message);
        loadDevices();
        clearDeviceForm();
    });
    
    socket.on('group_updated', function(data) {
        const message = data.user ? 
            `El grupo ${data.name} ha sido actualizado por ${data.user}` : 
            `El grupo ${data.name} ha sido actualizado`;
        showNotification('success', 'Grupo actualizado', message);
        loadGroups();
    });
    
    socket.on('disconnect', function() {
        console.log('WebSocket desconectado');
        updateConnectionStatus(false, 'Conexion WebSocket perdida');
    });
    
    socket.on('auth_error', function(data) {
        console.error('Error de autenticacion en WebSocket:', data);
        showNotification('error', 'Error de autenticacion', 'Sesion invalida en WebSocket');
        redirectToLogin();
    });
}

async function checkConnectionStatus() {
    try {
        const response = await fetch(`${API_BASE}/api/status`);
        const data = await response.json();
        
        updateConnectionStatus(data.connected, data.message);
        
        if (data.config) {
            console.log('Configuracion:', data.config);
        }
        
        if (data.user) {
            console.log('Usuario autenticado:', data.user.email);
        }
    } catch (error) {
        console.error('Error al verificar estado:', error);
        updateConnectionStatus(false, 'Error de comunicacion con el servidor');
    }
}

function updateConnectionStatus(connected, message) {
    const indicator = document.getElementById('statusIndicator');
    const statusMessage = document.getElementById('statusMessage');
    
    indicator.className = 'status-indicator ' + (connected ? 'connected' : 'disconnected');
    statusMessage.textContent = message;
    
    // Habilitar/deshabilitar botones segun el estado
    const reconnectBtn = document.getElementById('reconnectBtn');
    reconnectBtn.disabled = false;
    reconnectBtn.textContent = connected ? 'Reconectar' : 'Conectar';
}

async function reconnect() {
    const indicator = document.getElementById('statusIndicator');
    const statusMessage = document.getElementById('statusMessage');
    
    indicator.className = 'status-indicator connecting';
    statusMessage.textContent = 'Conectando...';
    
    try {
        const response = await fetch(`${API_BASE}/api/reconnect`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            }
        });
        
        const data = await response.json();
        
        if (data.success) {
            showNotification('success', 'Reconexion exitosa', data.message);
            loadDevices();
            loadGroups();
        } else {
            showNotification('error', 'Error de conexion', data.message);
        }
        
        updateConnectionStatus(data.success, data.message);
    } catch (error) {
        console.error('Error en reconexion:', error);
        updateConnectionStatus(false, 'Error de comunicacion');
        showNotification('error', 'Error', 'No se pudo conectar al servidor');
    }
}

async function loadDevices() {
    const devicesList = document.getElementById('devicesList');
    const typeFilter = document.getElementById('typeFilter').value;
    
    // Mostrar loading
    devicesList.innerHTML = `
        <div class="loading">
            <div class="loading-spinner"></div>
            <span>Cargando objetos...</span>
        </div>
    `;
    
    try {
        const filterParam = typeFilter !== 'all' ? `?type=${typeFilter}` : '';
        const response = await fetch(`${API_BASE}/api/els-objects${filterParam}`);
        const data = await response.json();
        
        if (data.success) {
            currentDevices = data.data;
            renderDevicesTable(data.data);
        } else {
            devicesList.innerHTML = `
                <div class="empty-state">
                    <p>Error al cargar objetos: ${data.message}</p>
                </div>
            `;
        }
    } catch (error) {
        console.error('Error al cargar dispositivos:', error);
        devicesList.innerHTML = `
            <div class="empty-state">
                <p>Error de comunicacion con el servidor</p>
            </div>
        `;
    }
}

function renderDevicesTable(devices) {
    const devicesList = document.getElementById('devicesList');
    
    if (Object.keys(devices).length === 0) {
        devicesList.innerHTML = `
            <div class="empty-state">
                <p>No se encontraron objetos ELS</p>
            </div>
        `;
        return;
    }
    
    let html = `
        <div class="device-table-header">
            <div>Nombre</div>
            <div>Tipo</div>
            <div>Valor</div>
            <div>Acciones</div>
        </div>
    `;
    
    Object.entries(devices).forEach(([name, info]) => {
        html += `
            <div class="device-table-row" data-name="${name}">
                <div>${name}</div>
                <div>${info.type.toUpperCase()}</div>
                <div>${info.displayValue}</div>
                <div>
                    <button class="btn btn-outline btn-sm edit-btn" data-name="${name}">Editar</button>
                </div>
            </div>
        `;
    });
    
    devicesList.innerHTML = html;

    // Se añaden los event listeners a los botones de forma segura
    document.querySelectorAll('.edit-btn').forEach(button => {
        button.addEventListener('click', (event) => {
            const deviceName = event.currentTarget.getAttribute('data-name');
            selectDevice(deviceName);
        });
    });
}

function selectDevice(name) {
    const device = currentDevices[name];
    if (!device) return;
    
    // Remover seleccion anterior
    document.querySelectorAll('.device-table-row').forEach(row => {
        row.classList.remove('selected');
    });
    
    // Seleccionar nueva fila
    document.querySelector(`[data-name="${name}"]`).classList.add('selected');
    
    // Llenar formulario
    const deviceNameInput = document.getElementById('deviceName');
    const deleteBtn = document.getElementById('deleteDeviceBtn');
    
    // Remover prefijo ELS- para mostrar solo la parte variable
    const displayName = name.startsWith('ELS-') ? name.substring(4) : name;
    deviceNameInput.value = displayName;
    
    // Llenar campos MAC
    if (device.type === 'mac' && device.value) {
        setMacAddress(device.value);
    }
    
    selectedDevice = name;
    deleteBtn.style.display = 'inline-flex';
    
    // Scroll al formulario
    document.querySelector('.device-form-container').scrollIntoView({ 
        behavior: 'smooth',
        block: 'start'
    });
}

function setMacAddress(macAddress) {
    const macInputs = document.querySelectorAll('.mac-input');
    const cleanMac = macAddress.replace(/[:-]/g, '');
    
    if (cleanMac.length === 12) {
        macInputs.forEach((input, index) => {
            input.value = cleanMac.substring(index * 2, (index * 2) + 2);
        });
    }
}

function getMacAddress() {
    const macInputs = document.querySelectorAll('.mac-input');
    const macParts = Array.from(macInputs).map(input => input.value.padStart(2, '0'));
    
    // Validar que todos los campos esten llenos
    if (macParts.some(part => part === '00' && part !== macInputs[macParts.indexOf(part)].value)) {
        return null;
    }
    
    return macParts.join(':');
}

async function saveDevice(event) {
    event.preventDefault();
    
    const deviceName = document.getElementById('deviceName').value.trim();
    const macAddress = getMacAddress();
    
    if (!deviceName) {
        showNotification('error', 'Error', 'El nombre del dispositivo es requerido');
        return;
    }
    
    if (!macAddress) {
        showNotification('error', 'Error', 'Ingresa una direccion MAC valida');
        return;
    }
    
    const fullName = `ELS-${deviceName}`;
    
    try {
        const response = await fetch(`${API_BASE}/api/els-objects`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                name: fullName,
                type: 'mac',
                value: macAddress
            })
        });
        
        const data = await response.json();
        
        if (data.success) {
            showNotification('success', 'Exito', data.message);
            clearDeviceForm();
            loadDevices();
        } else {
            showNotification('error', 'Error', data.message);
        }
    } catch (error) {
        console.error('Error al guardar dispositivo:', error);
        showNotification('error', 'Error', 'Error de comunicacion con el servidor');
    }
}

async function deleteDevice() {
    if (!selectedDevice) {
        showNotification('warning', 'Advertencia', 'No hay dispositivo seleccionado');
        return;
    }
    
    if (!confirm(`¿Estas seguro de eliminar el objeto '${selectedDevice}'?`)) {
        return;
    }
    
    try {
        const response = await fetch(`${API_BASE}/api/els-objects/${selectedDevice}`, {
            method: 'DELETE'
        });
        
        const data = await response.json();
        
        if (data.success) {
            showNotification('success', 'Exito', data.message);
            clearDeviceForm();
            loadDevices();
        } else {
            showNotification('error', 'Error', data.message);
        }
    } catch (error) {
        console.error('Error al eliminar dispositivo:', error);
        showNotification('error', 'Error', 'Error de comunicacion con el servidor');
    }
}

function clearDeviceForm() {
    document.getElementById('deviceName').value = '';
    document.querySelectorAll('.mac-input').forEach(input => input.value = '');
    document.getElementById('deleteDeviceBtn').style.display = 'none';
    
    // Remover seleccion
    document.querySelectorAll('.device-table-row').forEach(row => {
        row.classList.remove('selected');
    });
    
    selectedDevice = null;
}

async function loadGroups() {
    const availableMembersList = document.getElementById('availableMembers');
    const currentMembersList = document.getElementById('currentMembers');
    
    // Mostrar loading
    availableMembersList.innerHTML = '<div class="loading"><div class="loading-spinner"></div><span>Cargando...</span></div>';
    currentMembersList.innerHTML = '<div class="loading"><div class="loading-spinner"></div><span>Cargando...</span></div>';
    
    try {
        // Cargar objetos disponibles y grupo actual en paralelo
        const [objectsResponse, groupsResponse] = await Promise.all([
            fetch(`${API_BASE}/api/els-objects`),
            fetch(`${API_BASE}/api/address-groups`)
        ]);
        
        const objectsData = await objectsResponse.json();
        const groupsData = await groupsResponse.json();
        
        if (objectsData.success && groupsData.success) {
            const allObjects = Object.keys(objectsData.data);
            currentMembers = groupsData.data['ELS-APP'] || [];
            availableMembers = allObjects.filter(obj => !currentMembers.includes(obj));
            
            renderMemberLists();
        } else {
            availableMembersList.innerHTML = '<div class="empty-state"><p>Error al cargar datos</p></div>';
            currentMembersList.innerHTML = '<div class="empty-state"><p>Error al cargar datos</p></div>';
        }
    } catch (error) {
        console.error('Error al cargar grupos:', error);
        availableMembersList.innerHTML = '<div class="empty-state"><p>Error de comunicacion</p></div>';
        currentMembersList.innerHTML = '<div class="empty-state"><p>Error de comunicacion</p></div>';
    }
}

function renderMemberLists() {
    const availableMembersList = document.getElementById('availableMembers');
    const currentMembersList = document.getElementById('currentMembers');
    
    // Renderizar miembros disponibles
    if (availableMembers.length === 0) {
        availableMembersList.innerHTML = '<div class="empty-state"><p>No hay objetos disponibles</p></div>';
    } else {
        let html = '';
        availableMembers.forEach(member => {
            html += `<div class="member-item" data-member="${member}">${member}</div>`;
        });
        availableMembersList.innerHTML = html;
    }
    
    // Renderizar miembros actuales
    if (currentMembers.length === 0) {
        currentMembersList.innerHTML = '<div class="empty-state"><p>El grupo esta vacio</p></div>';
    } else {
        let html = '';
        currentMembers.forEach(member => {
            html += `<div class="member-item" data-member="${member}">${member}</div>`;
        });
        currentMembersList.innerHTML = html;
    }
    
    // Agregar event listeners para seleccion
    setupMemberSelection();
}

function setupMemberSelection() {
    document.querySelectorAll('.member-item').forEach(item => {
        item.addEventListener('click', function() {
            this.classList.toggle('selected');
        });
    });
}

function addMembers() {
    const selectedAvailable = document.querySelectorAll('#availableMembers .member-item.selected');
    
    selectedAvailable.forEach(item => {
        const member = item.getAttribute('data-member');
        
        // Mover de disponibles a actuales
        const index = availableMembers.indexOf(member);
        if (index > -1) {
            availableMembers.splice(index, 1);
            currentMembers.push(member);
        }
    });
    
    // Actualizar listas
    currentMembers.sort();
    availableMembers.sort();
    renderMemberLists();
}

function removeMembers() {
    const selectedCurrent = document.querySelectorAll('#currentMembers .member-item.selected');
    
    selectedCurrent.forEach(item => {
        const member = item.getAttribute('data-member');
        
        // Mover de actuales a disponibles
        const index = currentMembers.indexOf(member);
        if (index > -1) {
            currentMembers.splice(index, 1);
            availableMembers.push(member);
        }
    });
    
    // Actualizar listas
    currentMembers.sort();
    availableMembers.sort();
    renderMemberLists();
}

async function saveGroup() {
    if (currentMembers.length === 0) {
        if (!confirm('El grupo quedara vacio. ¿Quieres guardarlo asi?')) {
            return;
        }
    }
    
    try {
        const response = await fetch(`${API_BASE}/api/address-groups/ELS-APP`, {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                members: currentMembers
            })
        });
        
        const data = await response.json();
        
        if (data.success) {
            showNotification('success', 'Exito', data.message);
        } else {
            showNotification('error', 'Error', data.message);
        }
    } catch (error) {
        console.error('Error al guardar grupo:', error);
        showNotification('error', 'Error', 'Error de comunicacion con el servidor');
    }
}

async function showDiagnostic() {
    const modal = document.getElementById('diagnosticModal');
    const results = document.getElementById('diagnosticResults');
    
    modal.classList.add('show');
    results.innerHTML = '<div class="loading"><div class="loading-spinner"></div><span>Ejecutando diagnostico...</span></div>';
    
    try {
        const response = await fetch(`${API_BASE}/api/diagnose`);
        const data = await response.json();
        
        if (data.success) {
            results.innerHTML = data.data.results.join('\n');
        } else {
            results.innerHTML = 'Error al ejecutar diagnostico: ' + data.message;
        }
    } catch (error) {
        console.error('Error en diagnostico:', error);
        results.innerHTML = 'Error de comunicacion con el servidor';
    }
}

function closeDiagnosticModal() {
    document.getElementById('diagnosticModal').classList.remove('show');
}

function showNotification(type, title, message) {
    const container = document.getElementById('notifications');
    
    const notification = document.createElement('div');
    notification.className = `notification ${type}`;
    
    // Agregar icono segun el tipo
    let icon = '';
    switch(type) {
        case 'success': icon = '✅'; break;
        case 'error': icon = '❌'; break;
        case 'warning': icon = '⚠️'; break;
        case 'info': icon = 'ℹ️'; break;
        default: icon = '📌'; break;
    }
    
    notification.innerHTML = `
        <div class="notification-content">
            <div class="notification-title">${icon} ${title}</div>
            <div class="notification-message">${message}</div>
            ${currentUser ? `<div class="notification-user">Usuario: ${currentUser.name}</div>` : ''}
        </div>
        <button class="notification-close" onclick="this.parentElement.remove()">×</button>
    `;
    
    container.appendChild(notification);
    
    // Auto-remover despues de 5 segundos
    setTimeout(() => {
        if (notification.parentNode) {
            notification.parentNode.removeChild(notification);
        }
    }, 5000);
    
    // Permitir cerrar al hacer clic en la notificacion
    notification.addEventListener('click', (e) => {
        if (e.target.classList.contains('notification-close')) return;
        if (notification.parentNode) {
            notification.parentNode.removeChild(notification);
        }
    });
}

// FUNCIONES DE UTILIDAD PARA AUTENTICACION

// Verificar si el usuario actual es administrador
function isCurrentUserAdmin() {
    return currentUser && currentUser.isAdmin === true;
}

// Mostrar/ocultar elementos segun permisos de usuario
function updateUIBasedOnPermissions() {
    const adminElements = document.querySelectorAll('.admin-only');
    const userInfo = document.querySelectorAll('.user-info');
    
    if (isCurrentUserAdmin()) {
        adminElements.forEach(el => el.style.display = 'block');
    } else {
        adminElements.forEach(el => el.style.display = 'none');
    }
    
    // Mostrar informacion del usuario en elementos relevantes
    userInfo.forEach(el => {
        if (currentUser) {
            el.textContent = `${currentUser.name} (${currentUser.email})`;
        }
    });
}

// Manejar errores de conexion especificos
function handleConnectionError(error, context = '') {
    console.error(`Error de conexion ${context}:`, error);
    
    if (error.message && error.message.includes('Failed to fetch')) {
        showNotification('error', 'Error de conexion', 'No se puede conectar al servidor. Verifica tu conexion a internet.');
    } else if (error.message && error.message.includes('NetworkError')) {
        showNotification('error', 'Error de red', 'Error de red. El servidor podria estar fuera de linea.');
    } else {
        showNotification('error', 'Error', `Error en ${context}: ${error.message}`);
    }
}

// Mostrar informacion del usuario en tiempo real
function showUserInfo() {
    if (!currentUser) return;
    
    const modal = document.createElement('div');
    modal.className = 'modal show';
    modal.innerHTML = `
        <div class="modal-content">
            <div class="modal-header">
                <h3>Informacion del Usuario</h3>
                <button class="modal-close" onclick="this.closest('.modal').remove()">&times;</button>
            </div>
            <div class="modal-body">
                <div style="display: flex; align-items: center; gap: 1rem; margin-bottom: 1rem;">
                    <img src="${currentUser.photo}" alt="Avatar" style="width: 64px; height: 64px; border-radius: 50%;">
                    <div>
                        <h4 style="margin: 0;">${currentUser.name}</h4>
                        <p style="margin: 0; color: #666;">${currentUser.email}</p>
                        <p style="margin: 0; color: #666;">${currentUser.domain || 'Sin dominio'}</p>
                    </div>
                </div>
                <div style="background: #f5f5f5; padding: 1rem; border-radius: 6px;">
                    <strong>Permisos:</strong> ${currentUser.isAdmin ? 'Administrador' : 'Usuario'}<br>
                    <strong>Sesion iniciada:</strong> ${new Date().toLocaleString()}<br>
                    <strong>Estado:</strong> <span style="color: green;">Activo</span>
                </div>
            </div>
        </div>
    `;
    
    document.body.appendChild(modal);
    
    // Auto-cerrar al hacer clic fuera
    modal.addEventListener('click', function(e) {
        if (e.target === this) {
            this.remove();
        }
    });
}

// Funciones para desarrollo y debugging
function getAuthDebugInfo() {
    return {
        currentUser: currentUser,
        isAuthenticated: !!currentUser,
        isAdmin: isCurrentUserAdmin(),
        sessionStorage: Object.keys(sessionStorage),
        authCheckInterval: !!authCheckInterval
    };
}

// Funciones utilitarias
function debounce(func, wait) {
    let timeout;
    return function executedFunction(...args) {
        const later = () => {
            clearTimeout(timeout);
            func(...args);
        };
        clearTimeout(timeout);
        timeout = setTimeout(later, wait);
    };
}

// INTERCEPTOR PARA MANEJAR ERRORES DE AUTENTICACION
const originalFetch = window.fetch;
window.fetch = async function(...args) {
    try {
        const response = await originalFetch.apply(this, args);
        
        // Interceptar errores de autenticacion
        if (response.status === 401) {
            try {
                const data = await response.clone().json();
                if (data.requiresAuth) {
                    console.warn('Sesion expirada detectada');
                    showNotification('warning', 'Sesion expirada', 'Tu sesion ha expirado. Redirigiendo al login...');
                    
                    setTimeout(() => {
                        redirectToLogin();
                    }, 2000);
                }
            } catch (e) {
                // Si no se puede parsear JSON, asumir que necesita auth
                redirectToLogin();
            }
        }
        
        // Interceptar errores de permisos
        if (response.status === 403) {
            try {
                const data = await response.clone().json();
                showNotification('error', 'Permisos insuficientes', data.message || 'No tienes permisos para esta accion');
            } catch (e) {
                showNotification('error', 'Error', 'No tienes permisos para realizar esta accion');
            }
        }
        
        return response;
    } catch (error) {
        console.error('Error en fetch:', error);
        throw error;
    }
};

// Manejo de errores global (mantener funcionalidad original)
window.addEventListener('error', function(e) {
    console.error('Error global:', e.error);
    showNotification('error', 'Error', 'Ha ocurrido un error inesperado');
});

// Manejo de promesas rechazadas (mantener funcionalidad original)
window.addEventListener('unhandledrejection', function(e) {
    console.error('Promesa rechazada:', e.reason);
    showNotification('error', 'Error', 'Error de comunicacion con el servidor');
    e.preventDefault();
});

// Exponer funciones de desarrollo en modo desarrollo
if (window.location.hostname === 'localhost') {
    window.debugAuth = getAuthDebugInfo;
    window.forceLogout = logout;
    window.showUserInfo = showUserInfo;
    console.log('🔧 Funciones de debug disponibles: debugAuth(), forceLogout(), showUserInfo()');
}