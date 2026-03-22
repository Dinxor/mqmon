class MQTTPWAApp {
    constructor() {
        this.mqttClient = null;
        this.client = null;  // Paho client
        this.sensorData = this.loadFromCache() || {};
        this.version = document.getElementById('app-version')?.textContent || '1.0.0';
        this.updateTimeElement = document.getElementById('update-time');
        this.sensorsGrid = document.getElementById('sensors-data');
        this.isOnline = navigator.onLine;
        this.serviceWorkerSupported = 'serviceWorker' in navigator;
        this.serviceWorkerReady = false;
        this.sensorConfig = null;
        this.sectionStates = {};
        
        // Paho specific properties
        this.mqttHost = null;
        this.mqttPort = null;
        this.mqttTopics = [];
        this.mqttUsername = null;
        this.mqttPassword = null;
        
        this.init();
    }
    
    async init() {
        await this.loadSensorConfig();
        await this.loadMqttConfig();
        this.setupEventListeners();
        
        if (this.serviceWorkerSupported) await this.waitForServiceWorker();
        if (!this.isOnline) this.showOfflineNotification();
        
        this.renderSensors();
        this.updateLastUpdateTime();
        
        // Check if Paho library is loaded (both ways)
        if (typeof Paho === 'undefined') {
            console.error('❌ Paho library not loaded!');
            this.showErrorNotification('Paho library not loaded');
            return;
        }
        
        // Initialize MQTT connection
        this.initMqttConnection();
    }
    
    showErrorNotification(message) {
        const n = document.createElement('div');
        n.style.cssText = 'position:fixed;top:10px;left:50%;transform:translateX(-50%);background:#f44336;color:white;padding:10px 20px;border-radius:20px;z-index:1000;';
        n.innerHTML = `❌ ${message}`;
        document.body.appendChild(n);
        setTimeout(() => n.remove(), 5000);
    }
    
    async loadSensorConfig() {
        try {
            const r = await fetch('/mqmon/sensor_config.json');
            this.sensorConfig = await r.json();
            
            // ⚠️ Инициализируем состояния после загрузки конфига
            const saved = this.loadSectionStates();
            if (saved && Object.keys(saved).length > 0) {
                this.sectionStates = saved;
            } else {
                // Все секции свернуты по умолчанию
                const sections = this.sensorConfig?.sections || {};
                for (const secId in sections) {
                    this.sectionStates[secId] = true;
                }
            }
        } catch (e) {
            this.sensorConfig = { sections: {}, sensors: {} };
            this.sectionStates = {};
        }
    }
    
    async loadMqttConfig() {
        try {
            const response = await fetch('/mqmon/mqtt-config.json');
            const config = await response.json();
            
            // Parse MQTT connection details
            this.mqttHost = config.broker_url;
            this.mqttPort = config.broker_port;
            this.mqttTopics = config.topics || [];
            this.mqttUsername = config.username || '';
            this.mqttPassword = config.password || '';
        } catch (error) {
            console.error('Failed to load MQTT config:', error);
        }
    }
    
initMqttConnection() {
    if (!this.mqttHost || !this.mqttPort) {
        console.error('❌ MQTT configuration not available');
        return;
    }
    
    if (typeof Paho === 'undefined') {
        console.error('❌ Paho library not available');
        return;
    }
    
    const clientId = `mqtt_pwa_${Math.random().toString(16).substr(2, 8)}`;
    
    try {
        // Paho.Client(host, port, path, clientId)
        this.client = new Paho.Client(
            this.mqttHost,
            Number(this.mqttPort),
            '/mqtt',  // EMQX требует путь /mqtt
            clientId
        );
        
        this.client.onConnectionLost = this.onConnectionLost.bind(this);
        this.client.onMessageArrived = this.onMessageArrived.bind(this);
        
        const connectOptions = {
            timeout: 30,
            keepAliveInterval: 60,
            reconnect: true,
            onSuccess: this.onConnect.bind(this),
            onFailure: this.onConnectFailure.bind(this)
        };
        
        if (this.mqttUsername) {
            connectOptions.userName = this.mqttUsername;
            if (this.mqttPassword) {
                connectOptions.password = this.mqttPassword;
            }
        }
        
        // 🔑 КЛЮЧЕВОЙ МОМЕНТ: useSSL определяет ws:// vs wss://
        const isHttps = window.location.protocol === 'https:';
        connectOptions.useSSL = isHttps;
        
        console.log(`📡 MQTT connection: ${isHttps ? 'WSS (secure)' : 'WS (plain)'} to ${this.mqttHost}:${this.mqttPort}`);
        
        this.client.connect(connectOptions);
        
    } catch (error) {
        console.error('❌ Failed to create Paho client:', error);
        this.updateMQTTStatus(false);
    }
}    
    onConnect() {
        console.log('✅ MQTT Connected');
        this.updateMQTTStatus(true);
        
        // Subscribe to topics
        this.subscribeToTopics();
        
        // Send online status
        this.publishStatus('online');
    }
    
    onConnectFailure(response) {
        console.error('❌ MQTT Connection failed:', response.errorMessage);
        this.updateMQTTStatus(false);
    }
    
    onConnectionLost(response) {
        console.log('🔌 MQTT Connection lost:', response.errorMessage);
        this.updateMQTTStatus(false);
    }
    
    onMessageArrived(message) {
        this.updateSensorData(message.destinationName, message.payloadString);
    }
    
    subscribeToTopics() {
        if (!this.client || !this.client.isConnected()) {
            console.log('Cannot subscribe - client not connected');
            return;
        }
        
        this.mqttTopics.forEach(topic => {
            console.log(`Subscribing`);
            this.client.subscribe(topic);
        });
    }
    
    publishStatus(status) {
        if (!this.client || !this.client.isConnected()) return;
        
        const message = new Paho.Message(JSON.stringify({
            status: status,
            version: this.version,
            client: this.client.clientId,
            timestamp: new Date().toISOString()
        }));
        message.destinationName = 'app/status';
        message.qos = 1;
        message.retained = false;
        
        this.client.send(message);
    }
    
    loadSectionStates() {
        try {
            return JSON.parse(localStorage.getItem('sectionStates'));
        } catch {
            return null;
        }
    }
    
    saveSectionStates() {
        localStorage.setItem('sectionStates', JSON.stringify(this.sectionStates));
    }
    
    async waitForServiceWorker() {
        if (!this.serviceWorkerSupported) return;
        if (navigator.serviceWorker.controller) {
            this.serviceWorkerReady = true;
            return;
        }
        return new Promise((resolve) => {
            const t = setTimeout(() => {
                this.serviceWorkerReady = false;
                resolve();
            }, 3000);
            navigator.serviceWorker.addEventListener('controllerchange', () => {
                clearTimeout(t);
                this.serviceWorkerReady = true;
                resolve();
            }, { once: true });
        });
    }
    
    showOfflineNotification() {
        const n = document.createElement('div');
        n.style.cssText = 'position:fixed;top:10px;left:50%;transform:translateX(-50%);background:#ff9800;color:white;padding:10px 20px;border-radius:20px;z-index:1000;';
        n.innerHTML = '📴 Офлайн режим';
        document.body.appendChild(n);
        setTimeout(() => n.remove(), 3000);
    }
    
    setupEventListeners() {
        document.getElementById('check-updates')?.addEventListener('click', () => this.checkForUpdates(true));
        document.getElementById('hard-reset')?.addEventListener('click', () => this.hardReset());
    }
    
    async checkForUpdates(manual) {
        try {
            // Для GitHub Pages - читаем версию из manifest.json
            const r = await fetch('/mqmon/manifest.json');
            const d = await r.json();
            const newVersion = d.version || '1.0.0';

            if (newVersion !== this.version && manual) {
                if (confirm(`Доступна версия ${newVersion}. Обновить?`)) {
//                    this.version = newVersion;
                    const versionSpan = document.getElementById('app-version');
                    if (versionSpan) {
                        versionSpan.textContent = newVersion;
                    }                    window.location.reload(true);
                }
            } else if (manual) {
                alert('✅ Приложение актуально');
            }
        } catch (e) {
            console.error('Version check failed:', e);
            if (manual) alert('❌ Не удалось проверить обновления');
        }
    }
    
    async hardReset() {
        if (confirm('Сбросить?')) {
            localStorage.clear();
            this.sensorData = {};
            window.location.reload(true);
        }
    }
    
    updateSensorData(topic, message) {
        try {
            const data = JSON.parse(message);
            if (typeof data === 'object') {
                for (const [id, val] of Object.entries(data)) {
                    this.sensorData[id] = {
                        value: String(val),
                        timestamp: new Date().toISOString()
                    };
                }
            } else {
                this.sensorData[topic] = {
                    value: message,
                    timestamp: new Date().toISOString()
                };
            }
        } catch (e) {
            this.sensorData[topic] = {
                value: message,
                timestamp: new Date().toISOString()
            };
        }
        this.saveToCache();
        this.renderSensors();
        this.updateLastUpdateTime();
    }
    
    toggleSection(id) {
        this.sectionStates[id] = !this.sectionStates[id];
        this.saveSectionStates();
        this.renderSensors();
    }
    
    formatValue(value, sectionId) {
        if (sectionId === '3') {
            const match = String(value).match(/^([\d.]+)N([\d.]+)$/);
            if (match) {
                return { value: match[1], unit: + match[2] };
            }
        }
        
        // Форматирование для секций 4-9 (время работы)
        const numId = Number(sectionId);
        if (numId >= 4 && numId <= 9) {
            const val = String(value);
            if (val.length > 1) {
                const S = val[0];
                const remainder = val.slice(1);
                const colonPos = remainder.indexOf(':');
                if (colonPos > 0) {
                    const timePart = remainder.substring(0, colonPos + 3);
                    const minutes = remainder.substring(colonPos + 3);
                    if (S === 'w') {
                        return { value: timePart + '  Работает ', unit: minutes + ' мин' };
                    }
                    return { value: timePart + '  Стоит ', unit: minutes + ' мин' };
                }
            }
        }
        
        return { value: value, unit: '' };
    }
    
    renderSensors() {
        if (!this.sensorsGrid) return;
        
        const sensors = this.sensorConfig?.sensors || {};
        const sections = this.sensorConfig?.sections || {};
        const grouped = {};
        
        for (const [id, d] of Object.entries(this.sensorData)) {
            const info = sensors[id] || {};
            const sec = info.section || 'other';
            if (!grouped[sec]) {
                grouped[sec] = {
                    title: sections[sec]?.title || '📦 Другие',
                    sensors: []
                };
            }
            const formatted = this.formatValue(d.value, sec);
            grouped[sec].sensors.push({
                id,
                name: info.name || 'Датчик ' + id,
                value: formatted.value,
                unit: info.unit || formatted.unit
            });
        }
        
        const sorted = Object.entries(grouped).sort((a, b) =>
            (sections[a[0]]?.order || 999) - (sections[b[0]]?.order || 999)
        );
        
        if (sorted.length === 0) {
            this.sensorsGrid.innerHTML = '<p class="no-data">Нет данных</p>';
            return;
        }
        
        let html = '';
        for (const [secId, secData] of sorted) {
            const collapsed = this.sectionStates[secId] === true;
            html += `
                <div class="data-section">
                    <div class="section-header" onclick="window.app.toggleSection('${secId}')">
                        <span class="section-title">${secData.title}</span>
                        <span class="section-toggle">${collapsed ? '▶' : '▼'}</span>
                    </div>
                    <div class="section-content ${collapsed ? 'collapsed' : ''}">
                        <table class="data-table">
                            <tbody>
            `;
            for (const s of secData.sensors) {
                html += `
                    <tr>
                        <td class="sensor-value">${s.name}: ${s.value} ${s.unit}</td>
                    </tr>
                `;
            }
            html += `
                            </tbody>
                        </table>
                    </div>
                </div>
            `;
        }
        
        this.sensorsGrid.innerHTML = html;
    }
    
    updateLastUpdateTime() {
        if (this.updateTimeElement) {
            this.updateTimeElement.textContent = new Date().toLocaleString();
        }
    }
    
    saveToCache() {
        localStorage.setItem('sensorData', JSON.stringify(this.sensorData));
    }
    
    loadFromCache() {
        try {
            return JSON.parse(localStorage.getItem('sensorData'));
        } catch {
            return null;
        }
    }
    
    updateConnectionStatus(on) {
        const el = document.getElementById('connection-status');
        if (el) {
            el.textContent = on ? '🟢 Online' : '🔴 Offline';
            el.className = 'status ' + (on ? 'online' : 'offline');
        }
    }
    
    updateMQTTStatus(c) {
        const el = document.getElementById('mqtt-status');
        if (el) {
            el.textContent = c ? '🟢 MQTT Connected' : '⚫ MQTT Disconnected';
            el.className = 'status ' + (c ? 'connected' : 'disconnected');
        }
    }
    
    // Clean up on page unload
    disconnect() {
        if (this.client && this.client.isConnected()) {
            this.publishStatus('offline');
            this.client.disconnect();
        }
    }
}

// Инициализация приложения
document.addEventListener('DOMContentLoaded', () => {
    window.app = new MQTTPWAApp();
    
    // Clean up on page unload
    window.addEventListener('beforeunload', () => {
        if (window.app) {
            window.app.disconnect();
        }
    });
});

// Отслеживание онлайн/офлайн статуса
window.addEventListener('online', () => window.app?.updateConnectionStatus(true));
window.addEventListener('offline', () => window.app?.updateConnectionStatus(false));