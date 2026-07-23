const webpush = require('web-push');
const crypto = require('crypto');

const PROJECT_ID = process.env.FIREBASE_PROJECT_ID;
const CLIENT_EMAIL = process.env.FIREBASE_CLIENT_EMAIL;
const PRIVATE_KEY = (process.env.FIREBASE_PRIVATE_KEY || '').replace(/\\n/g, '\n');
const VAPID_PUBLIC = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY;

webpush.setVapidDetails('mailto:admin@quanbanhang.app', VAPID_PUBLIC, VAPID_PRIVATE);

function base64url(str) {
    return Buffer.from(str).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}
function sign(data) {
    return crypto.createSign('RSA-SHA256').update(data).sign(PRIVATE_KEY, 'base64')
        .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

let cachedToken = null;
let tokenExpiry = 0;

async function getAccessToken() {
    const now = Math.floor(Date.now() / 1000);
    if (cachedToken && now < tokenExpiry - 60) return cachedToken;
    const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    const payload = base64url(JSON.stringify({
        iss: CLIENT_EMAIL, sub: CLIENT_EMAIL,
        aud: 'https://oauth2.googleapis.com/token',
        iat: now, exp: now + 3600,
        scope: 'https://www.googleapis.com/auth/datastore'
    }));
    const jwt = header + '.' + payload + '.' + sign(header + '.' + payload);
    const res = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=' + jwt
    });
    const data = await res.json();
    cachedToken = data.access_token;
    tokenExpiry = now + 3600;
    return cachedToken;
}

const FIRESTORE = 'https://firestore.googleapis.com/v1/projects/' + PROJECT_ID + '/databases/(default)/documents';

module.exports = async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.status(200).end();

    if (req.method === 'POST' && req.url.includes('subscribe')) {
        const sub = req.body;
        if (!sub || !sub.endpoint) return res.status(400).json({ error: 'Missing subscription' });
        const token = await getAccessToken();
        const docId = Buffer.from(sub.endpoint).toString('base64').replace(/[\/+=]/g, '_').slice(-60);
        await fetch(FIRESTORE + '/pushSubscriptions/' + docId, {
            method: 'PATCH',
            headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
            body: JSON.stringify({ fields: {
                endpoint: { stringValue: sub.endpoint },
                keys: { mapValue: { fields: {
                    p256dh: { stringValue: sub.keys.p256dh },
                    auth: { stringValue: sub.keys.auth }
                }}},
                createdAt: { stringValue: new Date().toISOString() }
            }})
        });
        return res.status(200).json({ ok: true });
    }

    if (req.method === 'POST' && req.url.includes('notify')) {
        const { title, body } = req.body || {};
        const token = await getAccessToken();
        const listRes = await fetch(FIRESTORE + '/pushSubscriptions?pageSize=100', {
            headers: { 'Authorization': 'Bearer ' + token }
        });
        const listData = await listRes.json();
        const docs = listData.documents || [];

        const results = await Promise.allSettled(docs.map(async function(doc) {
            const f = doc.fields;
            const sub = {
                endpoint: f.endpoint.stringValue,
                keys: {
                    p256dh: f.keys.mapValue.fields.p256dh.stringValue,
                    auth: f.keys.mapValue.fields.auth.stringValue
                }
            };
            try {
                await webpush.sendNotification(sub, JSON.stringify({ title: title || 'Đơn hàng mới!', body: body || '' }));
            } catch(err) {
                if (err.statusCode === 410 || err.statusCode === 404) {
                    await fetch(FIRESTORE + '/pushSubscriptions/' + doc.name.split('/').pop(), {
                        method: 'DELETE', headers: { 'Authorization': 'Bearer ' + token }
                    });
                }
            }
        }));

        return res.status(200).json({ ok: true, sent: docs.length });
    }

    return res.status(404).json({ error: 'Not found' });
};
