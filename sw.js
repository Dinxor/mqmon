// sw.js
const STATIC_CACHE = 'static-v5';

// Все пути абсолютные, от корня сайта
const APP_ASSETS = [
    '/mqmon/',
    '/mqmon/index.html',
    '/mqmon/offline.html',
    '/mqmon/manifest.json',
    '/mqmon/mqtt-config.json',
    '/mqmon/sensor_config.json',
    '/mqmon/favicon.ico',
    '/mqmon/css/style.css',
    '/mqmon/js/app.js',
    '/mqmon/js/paho-mqtt.js',
    '/mqmon/icons/icon-192.png',
    '/mqmon/icons/icon-512.png'
];

// Установка Service Worker
self.addEventListener('install', (event) => {
    console.log('🔄 Service Worker installing...');
    
    event.waitUntil(
        caches.open(STATIC_CACHE)
            .then(cache => {
                console.log('📦 Caching entire app...');
                return Promise.allSettled(
                    APP_ASSETS.map(url => 
                        cache.add(url).catch(err => 
                            console.log(`⚠️ Failed to cache ${url}:`, err.message)
                        )
                    )
                );
            })
            .then(() => {
                console.log('✅ App cached, activating...');
                return self.skipWaiting();
            })
    );
});

// Активация - удаляем старые кэши
self.addEventListener('activate', (event) => {
    console.log('🔄 Service Worker activating...');
    
    event.waitUntil(
        Promise.all([
            caches.keys().then(keys => {
                return Promise.all(
                    keys.filter(key => key !== STATIC_CACHE)
                        .map(key => {
                            console.log('🗑️ Removing old cache:', key);
                            return caches.delete(key);
                        })
                );
            }),
            self.clients.claim()
        ])
    );
});

// Стратегия кэширования - Cache First для HTML
self.addEventListener('fetch', (event) => {
    const url = new URL(event.request.url);
    
    // Для навигационных запросов - сначала кэш, потом сеть
    if (event.request.mode === 'navigate') {
        event.respondWith(
            caches.match(event.request).then(cached => {
                if (cached) {
                    console.log('📱 Serving from cache:', event.request.url);
                    
                    // Фоновое обновление
                    fetch(event.request)
                        .then(response => {
                            if (response && response.ok) {
                                caches.open(STATIC_CACHE).then(cache => {
                                    cache.put(event.request, response);
                                });
                            }
                        })
                        .catch(() => {});
                    
                    return cached;
                }
                
                return fetch(event.request)
                    .then(response => {
                        if (response && response.ok) {
                            const responseToCache = response.clone();
                            caches.open(STATIC_CACHE).then(cache => {
                                cache.put(event.request, responseToCache);
                            });
                        }
                        return response;
                    })
                    .catch(() => {
                        return caches.match('/mqmon/offline.html');
                    });
            })
        );
        return;
    }
    
    // Для статических ресурсов - сначала кэш
    event.respondWith(
        caches.match(event.request).then(cached => {
            return cached || fetch(event.request).then(response => {
                if (response && response.status === 200) {
                    const responseToCache = response.clone();
                    caches.open(STATIC_CACHE).then(cache => {
                        cache.put(event.request, responseToCache);
                    });
                }
                return response;
            });
        })
    );
});

// Обработка сообщений от клиента
self.addEventListener('message', (event) => {
    if (event.data.type === 'CHECK_UPDATES') {
        checkForUpdates(event.source);
    }
    
    if (event.data.type === 'UPDATE_READY') {
        updateAppCache().then(success => {
            event.source.postMessage({
                type: 'UPDATE_COMPLETE',
                success: success
            });
        });
    }
});

// Проверка обновлений
async function checkForUpdates(client) {
    try {
        console.log('🔍 Checking for updates...');
        
        const response = await fetch('/mqmon/manifest.json?_=' + Date.now(), {
            cache: 'no-store',
            headers: { 'Cache-Control': 'no-cache' }
        });
        
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        
        const data = await response.json();
        const serverVersion = data.version || '1.0.0';

        const cache = await caches.open(STATIC_CACHE);
        const cachedManifest = await cache.match('/mqmon/manifest.json');

        if (cachedManifest) {
            const cachedData = await cachedManifest.json();
            const currentVersion = cachedData.version || '1.0.0';

            console.log('Current version:', currentVersion);
            console.log('Server version:', serverVersion);

            if (serverVersion !== currentVersion) {
                console.log('🆕 New version available!');
                client.postMessage({
                    type: 'UPDATE_AVAILABLE',
                    version: serverVersion
                });
                return true;
            } else {
                client.postMessage({
                    type: 'UPDATE_CHECKED',
                    message: 'App is up to date'
                });
                return false;
            }
        }
    } catch (error) {
        console.log('❌ Update check failed:', error.message);
        client.postMessage({
            type: 'UPDATE_ERROR',
            message: 'Cannot check for updates'
        });
        return false;
    }
}

// Обновление кэша
async function updateAppCache() {
    console.log('📦 Updating app cache...');
    
    try {
        const newCacheName = `${STATIC_CACHE}-new-${Date.now()}`;
        const newCache = await caches.open(newCacheName);
        
        await Promise.allSettled(
            APP_ASSETS.map(url => 
                fetch(url, { cache: 'no-store' })
                    .then(response => {
                        if (response.ok) {
                            return newCache.put(url, response);
                        }
                    })
                    .catch(err => console.log(`⚠️ Failed to fetch ${url}:`, err.message))
            )
        );
        
        await caches.delete(STATIC_CACHE);
        const keys = await caches.keys();
        const actualNewCache = keys.find(key => key.startsWith(`${STATIC_CACHE}-new-`));
        if (actualNewCache) {
            await caches.rename(actualNewCache, STATIC_CACHE);
        }
        
        console.log('✅ App cache updated');
        return true;
    } catch (error) {
        console.log('❌ Update failed:', error);
        return false;
    }
}

console.log('🚀 Service Worker loaded');