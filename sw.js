// sw.js
const BASE_PATH = '/mqmon';
const STATIC_CACHE = 'static-v7';

// Управляем "текущим" кэшем через мета-ключ, чтобы обновлять без caches.rename()
const STATIC_META_CACHE = 'static-meta-v1';
const STATIC_CURRENT_KEY = 'static:current';

// Конфиги должны обновляться периодически, а не на каждый запуск
const CONFIG_CACHE = 'config-v1';
const CONFIG_URLS = [
    `${BASE_PATH}/mqtt-config.json`,
    `${BASE_PATH}/sensor_config.json`
];
const CONFIG_UPDATE_INTERVAL = 6 * 60 * 60 * 1000; // раз в 6 часов

// Все пути абсолютные, от корня сайта
const APP_ASSETS = [
    `${BASE_PATH}/`,
    `${BASE_PATH}/index.html`,
    `${BASE_PATH}/offline.html`,
    `${BASE_PATH}/manifest.json`,
    // ⚠️ конфиги не кладём в STATIC_CACHE при установке — будем обновлять по интервалу
    `${BASE_PATH}/favicon.ico`,
    `${BASE_PATH}/css/style.css`,
    `${BASE_PATH}/js/app.js`,
    `${BASE_PATH}/js/paho-mqtt.js`,
    `${BASE_PATH}/icons/icon-192.png`,
    `${BASE_PATH}/icons/icon-512.png`
];

// Установка Service Worker
self.addEventListener('install', (event) => {
    console.log('🔄 Service Worker installing...');

    event.waitUntil((async () => {
        const current = await getCurrentStaticCacheName();
        const cache = await caches.open(current);

        console.log('📦 Caching entire app...');
        await Promise.allSettled(
            APP_ASSETS.map(url =>
                cache.add(url).catch(err =>
                    console.log(`⚠️ Failed to cache ${url}:`, err.message)
                )
            )
        );

        console.log('✅ App cached, activating...');
        await self.skipWaiting();
    })());
});

// Активация - удаляем старые кэши
self.addEventListener('activate', (event) => {
    console.log('🔄 Service Worker activating...');

    event.waitUntil((async () => {
        const current = await getCurrentStaticCacheName();

        // Удаляем только устаревшие кэши, оставляя:
        // - текущий статик-кэш
        // - мета-хранилище статик-кэша
        // - кэш конфигов
        const keys = await caches.keys();
        await Promise.all(
            keys
                .filter(key => key !== current && key !== STATIC_META_CACHE && key !== CONFIG_CACHE)
                .map(key => {
                    console.log('🗑️ Removing old cache:', key);
                    return caches.delete(key);
                })
        );

        await self.clients.claim();
    })());
});

// Стратегия кэширования - Cache First для HTML
self.addEventListener('fetch', (event) => {
    const url = new URL(event.request.url);

    // Конфиги: Stale-While-Revalidate с ограничением по интервалу
    if (url.pathname === `${BASE_PATH}/mqtt-config.json` || url.pathname === `${BASE_PATH}/sensor_config.json`) {
        event.respondWith(handleConfigRequest(event.request));
        return;
    }

    // Для навигационных запросов - сначала кэш, потом сеть
    if (event.request.mode === 'navigate') {
        event.respondWith(
            (async () => {
                const current = await getCurrentStaticCacheName();
                const cache = await caches.open(current);
                const cached = await cache.match(event.request);
                if (cached) {
                    console.log('📱 Serving from cache:', event.request.url);

                    // Фоновое обновление
                    fetch(event.request)
                        .then(response => {
                            if (response && response.ok) {
                                caches.open(current).then(c => {
                                    c.put(event.request, response.clone());
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
                            caches.open(current).then(c => {
                                c.put(event.request, responseToCache);
                            });
                        }
                        return response;
                    })
                    .catch(() => {
                        return cache.match(`${BASE_PATH}/offline.html`);
                    });
            })()
        );
        return;
    }

    // Для статических ресурсов - сначала кэш
    event.respondWith(
        (async () => {
            const current = await getCurrentStaticCacheName();
            const cache = await caches.open(current);
            const cached = await cache.match(event.request);
            if (cached) return cached;

            const response = await fetch(event.request);
            if (response && response.status === 200) {
                await cache.put(event.request, response.clone());
            }
            return response;
        })()
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

        const current = await getCurrentStaticCacheName();
        const cache = await caches.open(current);
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
        const current = await getCurrentStaticCacheName();
        const next = `${STATIC_CACHE}-${Date.now()}`;
        const nextCache = await caches.open(next);

        await Promise.allSettled(
            APP_ASSETS.map(url =>
                fetch(url, { cache: 'no-store' })
                    .then(response => {
                        if (response && response.ok) {
                            return nextCache.put(url, response.clone());
                        }
                    })
                    .catch(err => console.log(`⚠️ Failed to fetch ${url}:`, err.message))
            )
        );

        // Переключаем "текущий" кэш атомарно через мета-ключ
        await setStaticMeta(STATIC_CURRENT_KEY, next);

        // Старый кэш удаляем после переключения
        if (current && current !== next) {
            await caches.delete(current);
        }

        console.log('✅ App cache updated');
        return true;
    } catch (error) {
        console.log('❌ Update failed:', error);
        return false;
    }
}

async function handleConfigRequest(request) {
    const cache = await caches.open(CONFIG_CACHE);
    const cached = await cache.match(request);

    // Быстрая отдача из кэша (если есть)
    if (cached) {
        // Решаем, нужно ли обновлять в фоне (не на каждый запрос)
        const now = Date.now();
        const key = `cfg:lastUpdate:${new URL(request.url).pathname}`;
        const last = Number(await getMeta(key)) || 0;
        const due = (now - last) > CONFIG_UPDATE_INTERVAL;

        if (due) {
            // Обновляем в фоне без блокировки ответа
            eventlessBackgroundUpdateConfig(request, cache, key).catch(() => {});
        }

        return cached;
    }

    // Первый запрос / нет кэша — идём в сеть и кэшируем
    try {
        const resp = await fetch(request, {
            cache: 'no-store',
            headers: { 'Cache-Control': 'no-cache' }
        });
        if (resp && resp.ok) {
            await cache.put(request, resp.clone());
            await setMeta(`cfg:lastUpdate:${new URL(request.url).pathname}`, String(Date.now()));
        }
        return resp;
    } catch (e) {
        // офлайн и нет кэша
        return new Response(JSON.stringify({ error: 'offline' }), {
            status: 503,
            headers: { 'Content-Type': 'application/json' }
        });
    }
}

async function eventlessBackgroundUpdateConfig(request, cache, metaKey) {
    // Обновление без блокировки ответа
    try {
        const resp = await fetch(request, {
            cache: 'no-store',
            headers: { 'Cache-Control': 'no-cache' }
        });
        if (resp && resp.ok) {
            await cache.put(request, resp.clone());
        }
    } finally {
        await setMeta(metaKey, String(Date.now()));
    }
}

// Храним метаданные в Cache Storage (спец. запросы), чтобы не зависеть от clients/localStorage
async function getMeta(key) {
    const metaCache = await caches.open(CONFIG_CACHE);
    const r = await metaCache.match(`meta:${key}`);
    return r ? r.text() : null;
}

async function setMeta(key, value) {
    const metaCache = await caches.open(CONFIG_CACHE);
    await metaCache.put(`meta:${key}`, new Response(value));
}

// Метаданные для управления текущим static cache
async function getStaticMeta(key) {
    const metaCache = await caches.open(STATIC_META_CACHE);
    const r = await metaCache.match(`meta:${key}`);
    return r ? r.text() : null;
}

async function setStaticMeta(key, value) {
    const metaCache = await caches.open(STATIC_META_CACHE);
    await metaCache.put(`meta:${key}`, new Response(value));
}

async function getCurrentStaticCacheName() {
    const v = (await getStaticMeta(STATIC_CURRENT_KEY)) || '';
    const name = String(v).trim();
    // значение по умолчанию и фоллбек для первого запуска
    return name || STATIC_CACHE;
}

console.log('🚀 Service Worker loaded');
