const CACHE_NAME = 'mqtt-pwa-v4';
const STATIC_CACHE = 'static-v4';
const VERSION_CHECK_INTERVAL = 60 * 60 * 1000; // Проверка обновлений раз в час

const APP_ASSETS = [
    '/',
    '/index.html',
    '/offline.html',
    '/manifest.json',
    '/mqtt-config.json',
    '/sensor_config.json',
    '/favicon.ico',
    '/css/style.css',
    '/js/app.js',
    '/js/paho-mqtt.js',
    '/icons/icon-192.png',
    '/icons/icon-512.png'
];

// Установка Service Worker - кэшируем ВСЁ приложение сразу
self.addEventListener('install', (event) => {
    console.log('🔄 Service Worker installing...');
    
    event.waitUntil(
        caches.open(STATIC_CACHE)
            .then(cache => {
                console.log('📦 Caching entire app...');
                // Кэшируем по одному, чтобы ошибка с одним файлом не ломала всё
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
                return self.skipWaiting(); // Активируем сразу
            })
    );
});

// Активация - удаляем старые кэши и берем управление
self.addEventListener('activate', (event) => {
    console.log('🔄 Service Worker activating...');
    
    event.waitUntil(
        Promise.all([
            // Удаляем все старые версии кэша
            caches.keys().then(keys => {
                return Promise.all(
                    keys.filter(key => key !== STATIC_CACHE)
                        .map(key => {
                            console.log('🗑️ Removing old cache:', key);
                            return caches.delete(key);
                        })
                );
            }),
            // Немедленно начинаем управлять всеми клиентами
            self.clients.claim(),
            // Запускаем периодическую проверку обновлений
            (async () => {
                // Проверяем сразу после активации
                const clients = await self.clients.matchAll();
                if (clients.length > 0) {
                    checkForUpdates(clients[0]);
                }
                
                // И запускаем интервал
                setInterval(async () => {
                    const clients = await self.clients.matchAll();
                    if (clients.length > 0) {
                        checkForUpdates(clients[0]);
                    }
                }, VERSION_CHECK_INTERVAL);
            })()
        ])
    );
});

// Основная стратегия кэширования для GitHub Pages
self.addEventListener('fetch', (event) => {
    const url = new URL(event.request.url);
    
    // Для навигационных запросов - пробуем сеть, потом кэш
    if (event.request.mode === 'navigate') {
        event.respondWith(
            fetch(event.request)
                .then(response => {
                    // Кэшируем новые страницы
                    const responseToCache = response.clone();
                    caches.open(STATIC_CACHE)
                        .then(cache => cache.put(event.request, responseToCache));
                    return response;
                })
                .catch(() => {
                    // Сеть недоступна - показываем офлайн страницу
                    return caches.match('/offline.html');
                })
        );
        return;
    }
    
    // Для статических ресурсов - сначала кэш, потом сеть
    event.respondWith(
        caches.match(event.request)
            .then(response => {
                if (response) {
                    return response;
                }
                
                // Нет в кэше - загружаем из сети
                return fetch(event.request)
                    .then(networkResponse => {
                        if (networkResponse && networkResponse.status === 200) {
                            const responseToCache = networkResponse.clone();
                            caches.open(STATIC_CACHE)
                                .then(cache => cache.put(event.request, responseToCache));
                        }
                        return networkResponse;
                    })
                    .catch(() => {
                        // Для навигации без кэша - офлайн страница
                        if (event.request.mode === 'navigate') {
                            return caches.match('/offline.html');
                        }
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
        // Принудительно обновляем кэш
        updateAppCache().then(success => {
            event.source.postMessage({
                type: 'UPDATE_COMPLETE',
                success: success
            });
        });
    }
    
    if (event.data.type === 'SKIP_WAITING') {
        self.skipWaiting();
    }
});

// Обработка возвращения онлайн
self.addEventListener('online', () => {
    console.log('🟢 Back online, checking for updates...');
    self.clients.matchAll().then(clients => {
        if (clients.length > 0) {
            checkForUpdates(clients[0]);
        }
    });
});

// Обработка sync событий (фоновая синхронизация)
self.addEventListener('sync', (event) => {
    if (event.tag === 'update-check') {
        event.waitUntil(
            self.clients.matchAll().then(clients => {
                if (clients.length > 0) {
                    return checkForUpdates(clients[0]);
                }
            })
        );
    }
});

// Обработка periodicsync (если поддерживается)
self.addEventListener('periodicsync', (event) => {
    if (event.tag === 'update-check') {
        event.waitUntil(
            self.clients.matchAll().then(clients => {
                if (clients.length > 0) {
                    return checkForUpdates(clients[0]);
                }
            })
        );
    }
});

// Проверка обновлений (вызывается из приложения)
async function checkForUpdates(client) {
    try {
        console.log('🔍 Checking for updates...');
        
        // Для читаем версию из manifest.json
        const response = await fetch(`/manifest.json?_=${Date.now()}`, {
            cache: 'no-store',
            headers: {
                'Cache-Control': 'no-cache'
            }
        });
        
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        
        const data = await response.json();
        const serverVersion = data.version || '1.0.0';

        // Получаем текущую версию из кэша
        const cache = await caches.open(STATIC_CACHE);
        const cachedManifest = await cache.match('/manifest.json');

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
                console.log('✅ App is up to date');
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

// Обновление кэша приложения
async function updateAppCache() {
    console.log('📦 Updating app cache...');
    
    try {
        // Создаем новый кэш с временным именем
        const newCacheName = `${STATIC_CACHE}-new-${Date.now()}`;
        const newCache = await caches.open(newCacheName);
        
        // Загружаем все ресурсы заново
        const results = await Promise.allSettled(
            APP_ASSETS.map(async url => {
                try {
                    const response = await fetch(url, {
                        cache: 'no-store',
                        headers: {
                            'Cache-Control': 'no-cache'
                        }
                    });
                    
                    if (response.ok) {
                        await newCache.put(url, response);
                        console.log(`✅ Updated: ${url}`);
                    } else {
                        console.log(`⚠️ Failed to update ${url}: ${response.status}`);
                    }
                } catch (err) {
                    console.log(`⚠️ Failed to fetch ${url}:`, err.message);
                }
            })
        );
        
        // Проверяем, обновилось ли что-то
        const successCount = results.filter(r => r.status === 'fulfilled').length;
        
        if (successCount > 0) {
            // Удаляем старый кэш
            await caches.delete(STATIC_CACHE);
            
            // Переименовываем новый кэш в основной
            await caches.delete(STATIC_CACHE); // На всякий случай удаляем еще раз
            const keys = await caches.keys();
            const actualNewCache = keys.find(key => key.startsWith(`${STATIC_CACHE}-new-`));
            if (actualNewCache) {
                await caches.delete(STATIC_CACHE);
                await caches.rename(actualNewCache, STATIC_CACHE);
            }
            
            console.log(`✅ App cache updated (${successCount}/${APP_ASSETS.length} files)`);
            
            // Уведомляем все клиенты об обновлении
            const clients = await self.clients.matchAll();
            clients.forEach(client => {
                client.postMessage({
                    type: 'CACHE_UPDATED'
                });
            });
            
            return true;
        } else {
            console.log('❌ No files were updated');
            await caches.delete(newCacheName);
            return false;
        }
    } catch (error) {
        console.log('❌ Update failed:', error);
        return false;
    }
}

// Обработка push уведомлений
self.addEventListener('push', (event) => {
    const data = event.data.json();
    
    const options = {
        body: data.body || 'Новое обновление доступно',
        icon: '/static/icons/icon-192.png',
        badge: '/static/icons/icon-192.png',
        vibrate: [200, 100, 200],
        data: {
            url: data.url || '/'
        },
        actions: [
            {
                action: 'update',
                title: 'Обновить сейчас'
            },
            {
                action: 'later',
                title: 'Позже'
            }
        ]
    };
    
    event.waitUntil(
        self.registration.showNotification('MQTT Monitor', options)
    );
});

// Обработка клика по уведомлению
self.addEventListener('notificationclick', (event) => {
    event.notification.close();
    
    if (event.action === 'update') {
        // Запускаем обновление
        event.waitUntil(
            self.clients.matchAll().then(clients => {
                if (clients.length > 0) {
                    clients[0].postMessage({
                        type: 'UPDATE_READY'
                    });
                }
            })
        );
    } else {
        event.waitUntil(
            clients.openWindow(event.notification.data.url)
        );
    }
});

console.log('🚀 Service Worker loaded and ready');
