'use strict';
self.addEventListener('push', event => {
  let data;
  try { data = event.data.json(); } catch { return; }
  if (!data || typeof data.body !== 'string' || data.expiresAt * 1000 <= Date.now()) return;
  event.waitUntil(self.registration.showNotification('Knight-Sense', {
    body:data.body, tag:'knight-sense-' + data.alertId, data:{url:'/frontend/'},
    icon:'/frontend/assets/photos/images/knightropinhovered-02.svg',
  }));
});
self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil((async () => {
    const pages = await self.clients.matchAll({type:'window',includeUncontrolled:true});
    const existing = pages.find(page => new URL(page.url).pathname.startsWith('/frontend/'));
    if (existing) return existing.focus();
    return self.clients.openWindow('/frontend/');
  })());
});
