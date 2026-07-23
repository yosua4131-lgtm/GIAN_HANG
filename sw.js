self.addEventListener('push', function(event) {
    var data = { title: 'Đơn hàng mới!', body: 'Có đơn hàng mới cần xử lý' };
    try { data = event.data.json(); } catch(e) {}
    event.waitUntil(
        self.registration.showNotification(data.title, {
            body: data.body,
            icon: '/icon-192.png',
            badge: '/icon-192.png',
            vibrate: [200, 100, 200],
            tag: 'new-order',
            renotify: true,
            data: { url: '/admin' }
        })
    );
});

self.addEventListener('notificationclick', function(event) {
    event.notification.close();
    var url = (event.notification.data && event.notification.data.url) || '/admin';
    event.waitUntil(
        clients.matchAll({ type: 'window' }).then(function(list) {
            for (var i = 0; i < list.length; i++) {
                if (list[i].url.indexOf(url) !== -1 && 'focus' in list[i]) return list[i].focus();
            }
            return clients.openWindow(url);
        })
    );
});
