(function () {
  'use strict';
  const {api, CONFIG} = window.KT;
  let registration;
  async function worker() {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) throw new Error('This browser does not support Web Push. In-app alerts still work.');
    registration ||= await navigator.serviceWorker.register(CONFIG.APP_BASE + 'sw.js', {scope:CONFIG.APP_BASE});
    await navigator.serviceWorker.ready;
    return registration;
  }
  async function enable() {
    const config = await api.pushConfig();
    if (!config.enabled) throw new Error('Push delivery awaits server configuration. Knight-Sense alerts are available in the app.');
    const reg = await worker();
    if (await Notification.requestPermission() !== 'granted') throw new Error('Notification permission was not granted. In-app alerts still work.');
    const key = Uint8Array.from(atob(config.publicKey.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
    const existing = await reg.pushManager.getSubscription();
    const subscription = existing || await reg.pushManager.subscribe({userVisibleOnly:true, applicationServerKey:key});
    try { await api.subscribe(subscription.toJSON()); }
    catch (error) { if (!existing) await subscription.unsubscribe(); throw error; }
    return 'Campus-wide push alerts enabled.';
  }
  async function disable() {
    const reg = await worker(), sub = await reg.pushManager.getSubscription();
    if (sub) { await api.unsubscribe(sub.endpoint); await sub.unsubscribe(); }
    return 'Push alerts disabled on this device.';
  }
  let lastOpen = 0;
  const presenceEnabled = () => localStorage.getItem('kt-sense-presence') === 'on';
  async function presence(user, requestPermission = false) {
    if (!user || document.hidden || !presenceEnabled() || Date.now() - lastOpen < 60000 || !navigator.geolocation) return;
    if (!requestPermission && navigator.permissions) {
      const permission = await navigator.permissions.query({name:'geolocation'}).catch(() => null);
      if (permission?.state !== 'granted') return;
    }
    lastOpen = Date.now();
    return new Promise(resolve => navigator.geolocation.getCurrentPosition(async pos => {
      try { await api.openedNear(pos.coords.latitude, pos.coords.longitude); } catch { /* off campus or offline */ }
      resolve();
    }, () => resolve(), {enableHighAccuracy:false, timeout:8000, maximumAge:60000}));
  }
  window.KT.sense = {enable, disable, presence, presenceEnabled, setPresence:on => localStorage.setItem('kt-sense-presence', on ? 'on' : 'off')};
})();
