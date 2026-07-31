// Firebase Cloud Messaging service worker (default path the FCM SDK looks for).
// Its ONLY job here is to exist as valid JS so getToken()'s registration succeeds
// instead of 404-ing to index.html (which caused the "unsupported MIME type" error).
// The full app cache/offline SW is /service-worker.js.

importScripts('https://www.gstatic.com/firebasejs/10.12.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.12.0/firebase-messaging-compat.js');

firebase.initializeApp({
  apiKey: 'AIzaSyCo35i4mXPRmGy0IM5L-8s6YH3Zr5O_vMY',
  authDomain: 'flasharena-f35b1.firebaseapp.com',
  databaseURL: 'https://flasharena-f35b1-default-rtdb.europe-west1.firebasedatabase.app',
  projectId: 'flasharena-f35b1',
  storageBucket: 'flasharena-f35b1.firebasestorage.app',
  messagingSenderId: '208737763122',
  appId: '1:208737763122:web:752bd9566561a85211612b'
});

const messaging = firebase.messaging();

// Show background notifications (only fires if a push is actually sent).
messaging.onBackgroundMessage(function(payload) {
  try {
    const n = payload.notification || {};
    self.registration.showNotification(n.title || 'Side Quest', {
      body: n.body || '',
      icon: n.icon || '/icon-192.png',
      data: payload.data || {}
    });
  } catch (e) {}
});

self.addEventListener('notificationclick', function(event) {
  event.notification.close();
  event.waitUntil(clients.matchAll({ type: 'window' }).then(function(list) {
    for (const c of list) { if ('focus' in c) return c.focus(); }
    if (clients.openWindow) return clients.openWindow('/');
  }));
});
