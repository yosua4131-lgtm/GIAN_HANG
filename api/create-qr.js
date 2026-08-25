const PROJECT_ID = process.env.FIREBASE_PROJECT_ID;
const CLIENT_EMAIL = process.env.FIREBASE_CLIENT_EMAIL;
const PRIVATE_KEY = (process.env.FIREBASE_PRIVATE_KEY || '').replace(/\\n/g, '\n');
const crypto = require('crypto');

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
    const text = await res.text();
    var data;
    try { data = JSON.parse(text); } catch(e) {
        throw new Error('OAuth response not JSON (status ' + res.status + '): ' + text.slice(0, 200));
    }
    if (!data.access_token) {
        throw new Error('OAuth failed: ' + JSON.stringify(data).slice(0, 300));
    }
    cachedToken = data.access_token;
    tokenExpiry = now + 3600;
    return cachedToken;
}

const FIRESTORE = 'https://firestore.googleapis.com/v1/projects/' + PROJECT_ID + '/databases/(default)/documents';

async function fsGet(collection, docId) {
    const token = await getAccessToken();
    const res = await fetch(FIRESTORE + '/' + collection + '/' + docId, {
        headers: { 'Authorization': 'Bearer ' + token }
    });
    if (!res.ok) return null;
    const doc = await res.json();
    if (!doc.fields) return null;
    const obj = {};
    for (var k in doc.fields) {
        var v = doc.fields[k];
        if ('stringValue' in v) obj[k] = v.stringValue;
        else if ('integerValue' in v) obj[k] = Number(v.integerValue);
    }
    return obj;
}

module.exports = async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(200).send('OK');

    try {
        var body = req.body || {};
        var { bankPublicId, amount, content, title } = body;
        if (!amount || !content) return res.status(400).json({ error: 'missing amount or content' });

        if (!PRIVATE_KEY || !PROJECT_ID || !CLIENT_EMAIL) {
            return res.status(500).json({ error: 'Firebase env vars missing', has: { key: !!PRIVATE_KEY, project: !!PROJECT_ID, email: !!CLIENT_EMAIL } });
        }

        var settings = await fsGet('settings', 'apipay');
        if (!settings || !settings.accessKey || !settings.secretKey) {
            return res.status(400).json({ error: 'ApiPay not configured', settings: settings ? Object.keys(settings) : null });
        }

        var bearerToken = Buffer.from(settings.accessKey + ':' + settings.secretKey).toString('base64');
        var bankId = bankPublicId || settings.bankPublicId;
        if (!bankId) {
            return res.status(400).json({ error: 'No bankPublicId found', settingsKeys: Object.keys(settings) });
        }

        var apiRes = await fetch('https://app.apipay.vn/v1/client/payment-requests', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': 'Bearer ' + bearerToken
            },
            body: JSON.stringify({
                bankPublicId: bankId,
                amount: amount,
                content: content,
                title: title || 'Thanh toan'
            })
        });
        var apiText = await apiRes.text();
        var data;
        try { data = JSON.parse(apiText); } catch(e) {
            throw new Error('ApiPay response not JSON (status ' + apiRes.status + '): ' + apiText.slice(0, 200));
        }
        try {
            var token2 = await getAccessToken();
            var logFields = { lastQrResponse: { stringValue: JSON.stringify(data).slice(0, 800) }, loggedAt: { stringValue: new Date().toISOString() } };
            await fetch(FIRESTORE + '/settings/apipay_qr_debug?updateMask.fieldPaths=lastQrResponse&updateMask.fieldPaths=loggedAt', {
                method: 'PATCH',
                headers: { 'Authorization': 'Bearer ' + token2, 'Content-Type': 'application/json' },
                body: JSON.stringify({ fields: logFields })
            });
        } catch(logErr) {}
        return res.status(200).json(data);
    } catch (err) {
        return res.status(500).json({ error: err.message || 'Unknown error' });
    }
};
