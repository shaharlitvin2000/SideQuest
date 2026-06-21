// Firebase Cloud Messaging + Offline Cache Service Worker

importScripts('https://www.gstatic.com/firebasejs/10.12.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.12.0/firebase-messaging-compat.js');

const CACHE_NAME = 'flash-arena-v4';
// App shell precached so the app still opens offline. HTML uses a
// network-first strategy below, so online users always get the latest version.
const urlsToCache = [
  '/',
  '/index.html',
  '/icon-192.png'
];

const firebaseConfig = {
  apiKey: 'AIzaSyCo35i4mXPRmGy0IM5L-8s6YH3Zr5O_vMY',
  authDomain: 'flasharena-f35b1.firebaseapp.com',
  databaseURL: 'https://flasharena-f35b1-default-rtdb.europe-west1.firebasedatabase.app',
  projectId: 'flasharena-f35b1',
  storageBucket: 'flasharena-f35b1.firebasestorage.app',
  messagingSenderId: '208737763122',
  appId: '1:208737763122:web:752bd9566561a85211612b'
};

firebase.initializeApp(firebaseConfig);
const messaging = firebase.messaging();

// ══════════ SERVICE WORKER LIFECYCLE ══════════

// Install event - precache the app shell, then activate immediately
self.addEventListener('install', event => {
  console.log('[SW] Installing...');
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(urlsToCache).catch(() => {}))
      .then(() => self.skipWaiting())
  );
});

// Activate event - clean old caches and take control of open pages
self.addEventListener('activate', event => {
  console.log('[SW] Activating...');
  event.waitUntil(
    caches.keys().then(cacheNames => {
      return Promise.all(
        cacheNames.map(cacheName => {
          if (cacheName !== CACHE_NAME) {
            console.log('[SW] Deleting old cache:', cacheName);
            return caches.delete(cacheName);
          }
        })
      );
    }).then(() => self.clients.claim())
  );
});

// Fetch event - cache-first strategy for offline support
self.addEventListener('fetch', event => {
  const { request } = event;
  const url = new URL(request.url);

  // Only cache GET requests
  if (request.method !== 'GET') {
    return;
  }

  // App shell (HTML navigations): network-first, fall back to cache when offline
  if (request.mode === 'navigate' || (request.destination === 'document')) {
    event.respondWith(
      fetch(request).then(response => {
        if (response && response.status === 200) {
          const copy = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put('/index.html', copy));
        }
        return response;
      }).catch(() => caches.match('/index.html').then(r => r || caches.match('/')))
    );
    return;
  }

  // Cache video files aggressively
  if (request.url.includes('firebasestorage.googleapis.com')) {
    event.respondWith(
      caches.open(CACHE_NAME).then(cache => {
        return cache.match(request).then(response => {
          // Return cached version if available
          if (response) {
            console.log('[SW] Serving from cache:', url.pathname);
            return response;
          }

          // Fetch from network and cache
          return fetch(request).then(response => {
            // Only cache successful responses
            if (response && response.status === 200) {
              cache.put(request, response.clone());
            }
            return response;
          }).catch(() => {
            // Offline - return cached or offline placeholder
            return cache.match(request);
          });
        });
      })
    );
  }
});

// ══════════ FIREBASE MESSAGING ══════════

// Handle background messages
messaging.onBackgroundMessage(function(payload) {
  console.log('[FCM BG] Received background message:', payload);

  const notificationTitle = payload.notification.title;
  const notificationOptions = {
    body: payload.notification.body,
    icon: payload.notification.icon,
    tag: payload.data.type,
    data: payload.data
  };

  self.registration.showNotification(notificationTitle, notificationOptions);
});

// Handle notification click
self.addEventListener('notificationclick', function(event) {
  console.log('[FCM] Notification clicked:', event.notification);

  event.notification.close();

  // Focus on app window
  event.waitUntil(
    clients.matchAll({ type: 'window' }).then(function(clientList) {
      // Focus existing window if available
      for (let i = 0; i < clientList.length; i++) {
        const client = clientList[i];
        if (client.url === '/' && 'focus' in client) {
          return client.focus();
        }
      }
      // Otherwise open new window
      if (clients.openWindow) {
        return clients.openWindow('/');
      }
    })
  );
});
