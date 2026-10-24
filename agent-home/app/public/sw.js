/* Agent app service worker: push notifications only (no offline cache, so updates show at once). */
const TOKEN = new URL(self.location.href).searchParams.get('t') || '';   // registered as /sw.js?t=…
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
self.addEventListener('push', e => {
  let d = {};
  try { d = e.data.json(); } catch { d = { body: e.data && e.data.text() }; }
  e.waitUntil(self.registration.showNotification(d.title || 'Agent', {
    body: d.body || '', tag: d.tag || 'munshi', renotify: true, icon: '/icons/icon-192.png', badge: '/icons/icon-192.png',
  }));
});
self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    if (all.length) return all[0].focus();
    return self.clients.openWindow('/?t=' + encodeURIComponent(TOKEN));   // without the token the page is locked
  })());
});
