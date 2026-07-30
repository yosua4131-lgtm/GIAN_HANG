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
    const data = await res.json();
    cachedToken = data.access_token;
    tokenExpiry = now + 3600;
    return cachedToken;
}

const FIRESTORE = 'https://firestore.googleapis.com/v1/projects/' + PROJECT_ID + '/databases/(default)/documents';

async function fsQuery(collection, filters) {
    const token = await getAccessToken();
    const body = { structuredQuery: { from: [{ collectionId: collection }] } };
    if (filters && filters.length) {
        body.structuredQuery.where = { compositeFilter: { op: 'AND', filters: filters.map(function(f) {
            return { fieldFilter: { field: { fieldPath: f.field }, op: f.op, value: { stringValue: f.value } } };
        }) } };
    }
    const res = await fetch(FIRESTORE + ':runQuery', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
    });
    const data = await res.json();
    return (data || []).filter(function(d) { return d.document; }).map(function(d) {
        return { id: d.document.name.split('/').pop() };
    });
}

async function fsUpdate(collection, docId, data) {
    const token = await getAccessToken();
    const fields = {};
    for (var k in data) {
        if (typeof data[k] === 'string') fields[k] = { stringValue: data[k] };
        else if (typeof data[k] === 'number') fields[k] = { integerValue: String(data[k]) };
        else if (typeof data[k] === 'boolean') fields[k] = { booleanValue: data[k] };
    }
    var mask = Object.keys(data).map(function(k) { return 'updateMask.fieldPaths=' + k; }).join('&');
    await fetch(FIRESTORE + '/' + collection + '/' + docId + '?' + mask, {
        method: 'PATCH',
        headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
        body: JSON.stringify({ fields: fields })
    });
}

module.exports = async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(200).send('OK');

    var body = req.body;
    if (!body) return res.status(200).send('OK');

    // Log webhook data for debugging
    await fsUpdate('settings', 'apipay_debug', {
        lastWebhook: JSON.stringify(body).slice(0, 500),
        receivedAt: new Date().toISOString()
    });

    var content = body.content || body.description || body.transactionContent || '';
    if (body.data) {
        content = content || body.data.content || body.data.description || body.data.transactionContent || '';
    }
    var amount = body.amount || body.transferAmount || (body.data && body.data.amount) || 0;

    if (!content) return res.status(200).json({ success: false, message: 'no content' });

    var match = content.match(/(DH[A-Z0-9]+)/i);
    if (!match) return res.status(200).json({ success: false, message: 'no order code' });

    var orderCode = match[1].toUpperCase();

    var orders = await fsQuery('orders', [
        { field: 'paymentCode', op: 'EQUAL', value: orderCode }
    ]);

    if (!orders.length) return res.status(200).json({ success: false, message: 'order not found' });

    var orderId = orders[0].id;

    await fsUpdate('orders', orderId, {
        status: 'confirmed',
        paymentVerified: true,
        paidAt: new Date().toISOString()
    });

    return res.status(200).json({ success: true, orderId: orderId });
};
