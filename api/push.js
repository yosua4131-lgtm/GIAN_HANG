const webpush = require('web-push');

const VAPID_PUBLIC = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY;

webpush.setVapidDetails('mailto:admin@quanbanhang.app', VAPID_PUBLIC, VAPID_PRIVATE);

module.exports = async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(200).send('OK');

    const { title, body, subs } = req.body || {};
    if (!subs || !subs.length) return res.status(200).json({ ok: true, sent: 0 });

    await Promise.allSettled(subs.map(function(sub) {
        return webpush.sendNotification(sub, JSON.stringify({
            title: title || 'Đơn hàng mới!',
            body: body || ''
        })).catch(function() {});
    }));

    return res.status(200).json({ ok: true, sent: subs.length });
};
