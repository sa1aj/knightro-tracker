'use strict';
const appURL = new URL('./', self.location.href);
self.addEventListener('push', event => {
  let data;
  try { data = event.data.json(); } catch { return; }
  if (!data || typeof data.body !== 'string' || data.expiresAt * 1000 <= Date.now()) return;
  event.waitUntil(self.registration.showNotification('Knight-Sense', {
    body:data.body, tag:'knight-sense-' + data.alertId, data:{url:appURL.href},
    icon:new URL('assets/photos/images/knightropinhovered-02.svg', appURL).href,
  }));
});
self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil((async () => {
    const pages = await self.clients.matchAll({type:'window',includeUncontrolled:true});
    const existing = pages.find(page => {
      const url = new URL(page.url);
      return url.origin === appURL.origin && url.pathname.startsWith(appURL.pathname);
    });
    if (existing) return existing.focus();
    return self.clients.openWindow(appURL.href);
  })());
});
