class MQTTPWAApp {
    constructor() {
        this.mqttClient = null;
        this.client = null;
        this.sensorData = this.loadFromCache() || {};
        this.version = document.getElementById('app-version')?.textContent || '1.1.2';
        this.updateTimeElement = document.getElementById('update-time');
        this.sensorsGrid = document.getElementById('sensors-data');
        this.isOnline = navigator.onLine;
        this.serviceWorkerSupported = 'serviceWorker' in navigator;
        this.serviceWorkerReady = false;
        this.sensorConfig = null;
        this.sectionStates = {};
        
        this.mqttHost = null;
        this.mqttPort = null;
        this.mqttTopics = [];
        this.mqttUsername = null;
        this.mqttPassword = null;
        
        this.appId = this.loadOrGenerateAppId();
        this.privateTopicBase = null;
        this.accessKey = null;
        
        this.init();
    }
    
    loadOrGenerateAppId() {
        const stored = localStorage.getItem('appInstanceId');
        if (stored) return stored;
        
        const newId = Math.floor(Math.random() * 90000000 + 10000000).toString();
        localStorage.setItem('appInstanceId', newId);
        return newId;
    }
    
    loadAccessKey() {
        return localStorage.getItem('accessKey') || null;
    }
    
    saveAccessKey(key) {
        if (key) {
            localStorage.setItem('accessKey', key);
            this.accessKey = key;
        } else {
            localStorage.removeItem('accessKey');
            this.accessKey = null;
        }
    }
    
    validateAccessKey(key) {
        return key && key.length > 0;
    }
    
    async loadPrivateTopicConfig() {
        try {
            const response = await fetch('/mqmon/mqtt-config.json');
            const config = await response.json();
            this.privateTopicBase = config.private_topic || null;
        } catch (error) {
            console.error('Failed to load topic config:', error);
            this.privateTopicBase = null;
        }
    }
    
    // Обработка сообщения - проверка наличия секции settings
    processMessage(payload) {
        try {
            const data = JSON.parse(payload);
            
            if (data && data.settings && typeof data.settings === 'object') {
                const keyForThisApp = data.settings[this.appId];
                
                if (keyForThisApp !== undefined) {
                    if (keyForThisApp === null || keyForThisApp === "") {
                        if (this.validateAccessKey(this.accessKey)) {
                            this.revokeAccess();
                        }
                    } else if (keyForThisApp !== this.accessKey) {
                        this.setAccessKey(keyForThisApp);
                    }
                }
            }
            
            return data;
        } catch (e) {
            return null;
        }
    }
    
    setAccessKey(key) {
        if (!key) return false;
        
        const hadValidKey = this.validateAccessKey(this.accessKey);
        this.saveAccessKey(key);
        
        if (this.client && this.client.isConnected() && this.privateTopicBase) {
            if (hadValidKey && this.privateTopicBase) {
                this.client.unsubscribe(this.privateTopicBase);
            }
            this.subscribeToPrivateTopic();
            this.publishStatus('online');
        }
        
        this.renderSettingsPanel();
        return true;
    }
    
    revokeAccess() {
        const hadValidKey = this.validateAccessKey(this.accessKey);
        this.saveAccessKey(null);
        
        if (hadValidKey && this.client && this.client.isConnected() && this.privateTopicBase) {
            this.client.unsubscribe(this.privateTopicBase);
            this.publishStatus('online');
        }
        
        this.renderSettingsPanel();
    }
    
    subscribeToPrivateTopic() {
        if (!this.client || !this.client.isConnected()) return false;
        if (!this.privateTopicBase) return false;
        if (!this.validateAccessKey(this.accessKey)) return false;
        
        this.client.subscribe(this.privateTopicBase);
        return true;
    }
    
    async init() {
        await this.loadSensorConfig();
        await this.loadMqttConfig();
        await this.loadPrivateTopicConfig();
        
        const savedKey = this.loadAccessKey();
        if (savedKey && this.validateAccessKey(savedKey)) {
            this.accessKey = savedKey;
        }
        
        this.setupEventListeners();
        
        if (this.serviceWorkerSupported) await this.waitForServiceWorker();
        if (!this.isOnline) this.showOfflineNotification();
        
        this.renderSensors();
        this.renderSettingsPanel();
        
        if (typeof Paho === 'undefined') {
            console.error('❌ Paho library not loaded!');
            this.showErrorNotification('Paho library not loaded');
            return;
        }
        
        this.initMqttConnection();
    }
    
    showErrorNotification(message) {
        const n = document.createElement('div');
        n.style.cssText = 'position:fixed;top:10px;left:50%;transform:translateX(-50%);background:#f44336;color:white;padding:10px 20px;border-radius:20px;z-index:1000;';
        n.innerHTML = `❌ ${message}`;
        document.body.appendChild(n);
        setTimeout(() => n.remove(), 5000);
    }
    
    showNotification(message) {
        const n = document.createElement('div');
        n.style.cssText = 'position:fixed;top:10px;left:50%;transform:translateX(-50%);background:#667eea;color:white;padding:10px 20px;border-radius:20px;z-index:1000;';
        n.innerHTML = message;
        document.body.appendChild(n);
        setTimeout(() => n.remove(), 3000);
    }
    
    async loadSensorConfig() {
        try {
            const r = await fetch('/mqmon/sensor_config.json');
            this.sensorConfig = await r.json();
        } catch (e) {
            this.sensorConfig = { sections: {}, sensors: {} };
        }
    }
    
    async loadMqttConfig() {
        try {
            const response = await fetch('/mqmon/mqtt-config.json');
            const config = await response.json();
            
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
        
        const clientId = `mqtt_pwa_${this.appId}`;
        
        try {
            this.client = new Paho.Client(
                this.mqttHost,
                Number(this.mqttPort),
                '/mqtt',
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
        this.subscribeToTopics();
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
        const topic = message.destinationName;
        const payload = message.payloadString;
        
        // Сначала обрабатываем сообщение (проверяем секцию settings)
        const processedData = this.processMessage(payload);
        
        // Затем обновляем данные датчиков
        this.updateSensorData(topic, payload, processedData);
    }
    
    subscribeToTopics() {
        if (!this.client || !this.client.isConnected()) {
            console.log('Cannot subscribe - client not connected');
            return;
        }
        
        this.mqttTopics.forEach(topic => {
            this.client.subscribe(topic);
        });
        
        this.subscribeToPrivateTopic();
    }
    
    publishStatus(status) {
        if (!this.client || !this.client.isConnected()) return;
        
        const message = new Paho.Message(JSON.stringify({
            status: status,
            version: this.version,
            client: this.client.clientId,
            hasAccess: !!this.validateAccessKey(this.accessKey),
            timestamp: new Date().toISOString()
        }));
        message.destinationName = `homeassistant/sensor/73AF8758D1C738B3/1/${this.appId}`;
        message.qos = 1;
        message.retained = true;
        
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
        // Event listeners будут добавлены динамически через renderSettingsPanel
    }
    
    async checkForUpdates(manual) {
        try {
            const r = await fetch('/mqmon/manifest.json');
            const d = await r.json();
            const newVersion = d.version || '1.0.8';

            if (newVersion !== this.version && manual) {
                if (confirm(`Доступна версия ${newVersion}. Обновить?`)) {
                    const versionSpan = document.getElementById('app-version');
                    if (versionSpan) {
                        versionSpan.textContent = newVersion;
                    }
                    window.location.reload(true);
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
        if (confirm('Сбросить данные?')) {
            this.sensorData = {};
            localStorage.removeItem('sensorData');
            localStorage.removeItem('sectionStates');
            this.sectionStates = {};
            this.renderSensors();
        }
    }
    
    updateSensorData(topic, message, processedData) {
        let hasNewData = false;
        
        const dataToProcess = (processedData && processedData.settings) ? null : (processedData || message);
        
        if (typeof dataToProcess === 'object' && dataToProcess !== null && !Array.isArray(dataToProcess)) {
            for (const [id, val] of Object.entries(dataToProcess)) {
                if (id === 'settings') continue;
                
                const newValue = String(val);
                const oldValue = this.sensorData[id]?.value;
                if (oldValue !== newValue) {
                    hasNewData = true;
                }
                this.sensorData[id] = {
                    value: newValue,
                    timestamp: new Date().toISOString()
                };
            }
        } else if (typeof dataToProcess === 'string') {
            const newValue = dataToProcess;
            const oldValue = this.sensorData[topic]?.value;
            if (oldValue !== newValue) {
                hasNewData = true;
            }
            this.sensorData[topic] = {
                value: newValue,
                timestamp: new Date().toISOString()
            };
        }
        
        if (hasNewData) {
            this.saveToCache();
            this.renderSensors();
            this.updateLastUpdateTime();
        }
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
    
    renderSettingsPanel() {
        const footer = document.querySelector('footer');
        if (!footer) return;
        
        const currentKey = this.loadAccessKey();
        const isExpanded = localStorage.getItem('settingsExpanded') === 'true';
        const hasValidKey = this.validateAccessKey(currentKey);
        
        const settingsHtml = `
            <div class="settings-panel">
                <div class="settings-header" onclick="window.app.toggleSettings()">
                    <span>⚙️ Настройки</span>
                    <span class="settings-toggle">${isExpanded ? '▼' : '▶'}</span>
                </div>
                <div class="settings-content ${isExpanded ? '' : 'collapsed'}">
                    <div class="setting-item setting-item-compact">
                        <div class="compact-row">
                            <span class="compact-label">📱 ID:</span>
                            <span class="compact-value">${this.appId}</span>
                            <span class="compact-divider">|</span>
                            <span class="compact-label">🔑 Статус:</span>
                            <span class="compact-value ${hasValidKey ? 'valid' : 'invalid'}">${hasValidKey ? '✅' : '❌'}</span>
                        </div>
                    </div>
                    <div class="setting-item">
                        <button id="check-updates" class="btn-small">🔍 Проверить обновления</button>
                        <button id="hard-reset" class="btn-small btn-danger">🗑️ Очистить данные</button>
                    </div>
                </div>
            </div>
        `;
        
        footer.innerHTML = settingsHtml + '<p>Версия: <span id="app-version">' + this.version + '</span></p>';
        
        document.getElementById('check-updates')?.addEventListener('click', () => this.checkForUpdates(true));
        document.getElementById('hard-reset')?.addEventListener('click', () => this.hardReset());
    }
    
    toggleSettings() {
        const isExpanded = localStorage.getItem('settingsExpanded') === 'true';
        localStorage.setItem('settingsExpanded', String(!isExpanded));
        this.renderSettingsPanel();
    }
    
    escapeHtml(str) {
        const div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
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
            const expanded = this.sectionStates[secId] === true;
            html += `
                <div class="data-section">
                    <div class="section-header" onclick="window.app.toggleSection('${secId}')">
                        <span class="section-title">${secData.title}</span>
                        <span class="section-toggle">${expanded ? '▼' : '▶'}</span>
                    </div>
                    <div class="section-content ${expanded ? '' : 'collapsed'}">
                        <table class="data-table">
                            <tbody>`;
                                for (const s of secData.sensors) {
                                    html += `<tr><td class="sensor-value">${s.name}: ${s.value} ${s.unit}</td></tr>`;
                                }
            html += `   </tbody>
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
    
    updateMQTTStatus(c) {
        const el = document.getElementById('mqtt-status');
        if (el) {
            el.textContent = c ? '🟢 Соединение установлено' : '⚫ Ожидание подключения';
            el.className = 'status ' + (c ? 'connected' : 'disconnected');
        }
    }
    
    disconnect() {
        if (this.client && this.client.isConnected()) {
            this.publishStatus('offline');
            this.client.disconnect();
        }
    }
}

document.addEventListener('DOMContentLoaded', () => {
    window.app = new MQTTPWAApp();
    
    window.addEventListener('beforeunload', () => {
        if (window.app) {
            window.app.disconnect();
        }
    });
});