const { NodeSSH } = require('node-ssh');
const { promisify } = require('util');
const { exec } = require('child_process');
const execAsync = promisify(exec);
const net = require('net');
const dns = require('dns').promises;

class FortiGateManager {
  constructor() {
    this.ssh = null;
    this.config = null;
    this.connectionState = 'DISCONNECTED'; // Puede ser 'DISCONNECTED', 'CONNECTING', 'CONNECTED'
    this.loadConfig();
  }

  loadConfig() {
    this.config = {
      connection: {
        hostname: process.env.FORTIGATE_HOST,
        username: process.env.FORTIGATE_USERNAME,
        password: process.env.FORTIGATE_PASSWORD,
        port: parseInt(process.env.FORTIGATE_PORT),
        timeout: parseInt(process.env.FORTIGATE_TIMEOUT)
      }
    };
    if (!process.env.FORTIGATE_HOST || !process.env.FORTIGATE_USERNAME || !process.env.FORTIGATE_PASSWORD) {
      console.warn('ADVERTENCIA: Variables de entorno de FortiGate no configuradas completamente');
    }
  }

  isConnected() {
    return this.connectionState === 'CONNECTED' && this.ssh;
  }
  
  getConnectionState() {
      return this.connectionState;
  }

  getConnectionInfo() {
    if (!this.config || !this.config.connection) return null;
    const { hostname, username, port } = this.config.connection;
    return { hostname, username, port };
  }

  async connect() {
    if (this.connectionState === 'CONNECTING') {
      return { success: false, message: 'Ya se está intentando una conexión.' };
    }
    
    this.connectionState = 'CONNECTING';
    console.log('Estado de conexión: CONNECTING');

    try {
      const { hostname, username, password, port, timeout } = this.config.connection;
      console.log(`Intentando conectar a ${hostname}:${port} como usuario ${username}`);

      if (this.ssh) {
        this.disconnect();
      }
      this.ssh = new NodeSSH();
      
      console.log('Estableciendo conexion SSH...');
      await this.ssh.connect({
        host: hostname, port, username, password, readyTimeout: timeout,
        algorithms: {
          kex: ['diffie-hellman-group14-sha256', 'diffie-hellman-group14-sha1', 'diffie-hellman-group1-sha1'],
          cipher: ['aes128-ctr', 'aes192-ctr', 'aes256-ctr', 'aes128-gcm', 'aes256-gcm']
        }
      });
      console.log('Conexión SSH establecida, probando comando...');
      
      const testOutput = await this.executeCommand('get system status', true); // Forzar ejecución
      if (!testOutput || testOutput.trim().length < 5) {
        console.warn('Respuesta del comando vacía o muy corta, pero SSH funciona');
      }
      
      console.log('Conexión exitosa y validada');
      
      console.log('Configurando terminal para output estándar...');
      const disablePagingCommand = 'config system console\nset output standard\nend\n';
      await this.ssh.execCommand(disablePagingCommand);
      
      this.connectionState = 'CONNECTED';
      console.log('Estado de conexión: CONNECTED');
      
      return { success: true, message: `Conectado exitosamente a ${hostname}:${port}` };
    } catch (error) {
      console.error('Error en conexión SSH:', error.message);
      this.disconnect();
      
      let message = 'Error de conexión desconocido';
      if (error.message.includes('ENOTFOUND')) message = 'No se pudo resolver el hostname';
      else if (error.message.includes('ECONNREFUSED')) message = 'Conexión rechazada - Verifica IP y puerto';
      else if (error.message.includes('ETIMEDOUT')) message = 'Timeout de conexión - El dispositivo no responde';
      else if (error.message.includes('Authentication')) message = 'Error de autenticación - Usuario o contraseña incorrectos';
      else message = error.message;

      return { success: false, message };
    }
  }

  async autoConnect() {
    console.log('Intentando auto-conexión con configuración del .env...');
    if (!this.config?.connection) {
      return { success: false, message: 'No hay configuración disponible' };
    }
    return await this.connect();
  }

  disconnect() {
    if (this.ssh) {
      try { this.ssh.dispose(); } catch (error) { console.error('Error al cerrar conexión SSH:', error); }
    }
    this.ssh = null;
    this.connectionState = 'DISCONNECTED';
    console.log('Estado de conexión: DISCONNECTED');
  }
  
  async executeCommand(command, bypassConnectionCheck = false) {
    if (!bypassConnectionCheck && !this.isConnected()) {
      throw new Error('No hay conexión SSH activa');
    }
    if (!this.ssh) {
        throw new Error('Instancia SSH no disponible');
    }
    try {
      const result = await this.ssh.execCommand(command, { options: { pty: false } });
      if (result.stderr && !result.stderr.includes('Unknown action 0')) {
        console.warn('SSH stderr:', result.stderr);
      }
      return result.stdout || '';
    } catch (error) {
      throw new Error(`Error ejecutando comando: ${error.message}`);
    }
  }
  
  async getElsObjectsByType(objectType = null) {
    const command = 'show firewall address';
    const output = await this.executeCommand(command);
    const elsObjects = {};
    const configBlocks = output.split('next');
    for (const block of configBlocks) {
      const editMatch = block.match(/edit "([^"]+)"/);
      if (!editMatch || !editMatch[1].startsWith('ELS-')) continue;
      
      const name = editMatch[1];
      const objInfo = { type: 'unknown', value: '', displayValue: '' };

      if (block.includes('set type mac')) {
        objInfo.type = 'mac';
        // ----- CORRECCIÓN DEFINITIVA -----
        // Se usa la expresión regular original y más precisa para encontrar la MAC.
        const macMatch = block.match(/([0-9a-fA-F]{2}[:-]){5}([0-9a-fA-F]{2})/);
        if (macMatch) {
          // Se usa macMatch[0] para capturar la dirección MAC completa encontrada.
          objInfo.value = macMatch[0];
        }
      } else if (block.includes('set subnet')) {
        objInfo.type = 'subnet';
        const subnetMatch = block.match(/set subnet ([\d.\/]+)/);
        if (subnetMatch) objInfo.value = subnetMatch[1];
      } else if (block.includes('set fqdn')) {
        objInfo.type = 'fqdn';
        const fqdnMatch = block.match(/set fqdn "([^"]+)"/);
        if (fqdnMatch) objInfo.value = fqdnMatch[1];
      } else if (block.includes('set start-ip')) {
        objInfo.type = 'range';
        const startMatch = block.match(/set start-ip ([\d.]+)/);
        const endMatch = block.match(/set end-ip ([\d.]+)/);
        if (startMatch && endMatch) objInfo.value = `${startMatch[1]}-${endMatch[1]}`;
      }
      
      objInfo.displayValue = objInfo.value;
      
      if (objectType === null || objInfo.type === objectType) {
        elsObjects[name] = objInfo;
      }
    }
    return elsObjects;
  }

  async createUpdateAddressObject(name, objType, value) {
    let command = '';
    switch (objType) {
      case 'mac':
        command = `config firewall address\nedit "${name}"\nset type mac\nset macaddr ${value}\nend\n`;
        break;
      case 'subnet':
        command = `config firewall address\nedit "${name}"\nset subnet ${value}\nend\n`;
        break;
      case 'fqdn':
        command = `config firewall address\nedit "${name}"\nset type fqdn\nset fqdn "${value}"\nend\n`;
        break;
      case 'range':
        const [startIp, endIp] = value.split('-');
        command = `config firewall address\nedit "${name}"\nset type iprange\nset start-ip ${startIp.trim()}\nset end-ip ${endIp.trim()}\nend\n`;
        break;
      default:
        throw new Error(`Tipo de objeto no soportado: ${objType}`);
    }
    await this.executeCommand(command);
    await new Promise(resolve => setTimeout(resolve, 1000));
  }

  async deleteAddressObject(name) {
    const command = `config firewall address\ndelete "${name}"\nend\n`;
    await this.executeCommand(command);
    await new Promise(resolve => setTimeout(resolve, 1000));
  }

  async getAddressGroups() {
    const output = await this.executeCommand('show firewall addrgrp ELS-APP');
    const groups = {};
    const groupBlocks = [...output.matchAll(/edit "([^"]+)"\s*(.*?)\s*next/gs)];
    for (const [, name, content] of groupBlocks) {
      const membersMatch = content.match(/set member ([^\n]+)/);
      if (membersMatch) {
        const membersStr = membersMatch[1].trim();
        groups[name] = membersStr.split('" "').map(m => m.replace(/"/g, ''));
      } else {
        groups[name] = [];
      }
    }
    return groups;
  }

  async createUpdateGroup(name, members) {
    const membersStr = members.map(m => `"${m}"`).join(' ');
    const setCommand = members.length > 0 ? `set member ${membersStr}` : 'unset member';
    const command = `config firewall addrgrp\nedit "${name}"\n${setCommand}\nend\n`;
    await this.executeCommand(command);
    await new Promise(resolve => setTimeout(resolve, 1000));
  }

  async diagnoseConnection() {
    const results = [];
    if (!this.config || !this.config.connection) {
      return { success: false, results: ['No hay configuracion disponible'] };
    }
    const { hostname, port } = this.config.connection;
    results.push(`=== DIAGNOSTICO DE CONEXION A ${hostname}:${port} ===`);

    try {
      const { address } = await dns.lookup(hostname);
      results.push(`\n1. DNS: ✓ ${hostname} resuelve a ${address}`);
    } catch (error) {
      results.push(`\n1. DNS: ✗ Error: ${error.message}`);
    }

    try {
      const isWindows = process.platform === 'win32';
      const pingCmd = isWindows ? `ping -n 1 ${hostname}` : `ping -c 1 ${hostname}`;
      await execAsync(pingCmd, { timeout: 5000 });
      results.push(`\n2. Ping: ✓ Exitoso`);
    } catch (error) {
      results.push(`\n2. Ping: ✗ Fallo`);
    }

    try {
      const socket = new net.Socket();
      await new Promise((resolve, reject) => {
        socket.setTimeout(3000);
        socket.on('connect', () => { socket.destroy(); resolve(); });
        socket.on('timeout', () => { socket.destroy(); reject(new Error('Timeout')); });
        socket.on('error', reject);
        socket.connect(port, hostname);
      });
      results.push(`\n3. Puerto SSH (${port}): ✓ Abierto`);
    } catch (error) {
      results.push(`\n3. Puerto SSH (${port}): ✗ Cerrado o filtrado`);
    }

    return { success: true, results };
  }
}

module.exports = FortiGateManager;