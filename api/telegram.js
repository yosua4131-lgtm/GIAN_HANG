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

async function fsGet(collection, docId) {
    const token = await getAccessToken();
    const res = await fetch(FIRESTORE + '/' + collection + '/' + docId, {
        headers: { 'Authorization': 'Bearer ' + token }
    });
    if (!res.ok) return null;
    const doc = await res.json();
    return parseDoc(doc.fields);
}

function parseDoc(fields) {
    if (!fields) return null;
    const obj = {};
    for (const k in fields) {
        const v = fields[k];
        if ('stringValue' in v) obj[k] = v.stringValue;
        else if ('integerValue' in v) obj[k] = Number(v.integerValue);
        else if ('doubleValue' in v) obj[k] = v.doubleValue;
        else if ('booleanValue' in v) obj[k] = v.booleanValue;
        else if ('arrayValue' in v) obj[k] = (v.arrayValue.values || []).map(i => parseDoc(i.mapValue ? i.mapValue.fields : {}));
        else if ('mapValue' in v) obj[k] = parseDoc(v.mapValue.fields);
    }
    return obj;
}

async function fsUpdate(collection, docId, data) {
    const token = await getAccessToken();
    const fields = {};
    for (const k in data) {
        if (typeof data[k] === 'string') fields[k] = { stringValue: data[k] };
        else if (typeof data[k] === 'number') fields[k] = { integerValue: String(data[k]) };
    }
    const mask = Object.keys(data).map(k => 'updateMask.fieldPaths=' + k).join('&');
    await fetch(FIRESTORE + '/' + collection + '/' + docId + '?' + mask, {
        method: 'PATCH',
        headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
        body: JSON.stringify({ fields })
    });
}

async function fsDelete(collection, docId) {
    const token = await getAccessToken();
    await fetch(FIRESTORE + '/' + collection + '/' + docId, {
        method: 'DELETE', headers: { 'Authorization': 'Bearer ' + token }
    });
}

const STATUS = {
    pending: 'Chờ xác nhận',
    confirmed: 'Đã xác nhận',
    preparing: 'Đang chuẩn bị',
    delivering: 'Đang giao',
    done: 'Hoàn thành',
    cancelled: 'Đã hủy'
};

function fmtPrice(n) { return Number(n).toLocaleString('vi-VN'); }

function buildKeyboard(orderId, currentStatus) {
    const rows = [];
    const statuses = Object.keys(STATUS);
    for (let i = 0; i < statuses.length; i += 3) {
        const row = statuses.slice(i, i + 3).map(s => ({
            text: (s === currentStatus ? '✅ ' : '') + STATUS[s],
            callback_data: orderId + ':' + s
        }));
        rows.push(row);
    }
    rows.push([{ text: '🗑 Xóa đơn', callback_data: orderId + ':delete' }]);
    return { inline_keyboard: rows };
}

function buildOrderText(order, status) {
    var items = (order.items || []).map(function(i) { return '• ' + i.name + ' x' + i.qty + ' — ' + fmtPrice(i.price * i.qty) + 'đ'; }).join('\n');
    var pay = order.payMethod === 'transfer' ? 'Chuyển khoản' : 'Tiền mặt';
    return '🛒 ĐƠN HÀNG MỚI!\n\n'
        + '👤 ' + order.customer + '\n'
        + (order.phone ? '📞 ' + order.phone + '\n' : '')
        + (order.address ? '📍 ' + order.address + '\n' : '')
        + '\n' + items + '\n\n'
        + '💰 Tổng: ' + fmtPrice(order.total) + 'đ\n'
        + '💳 ' + pay
        + (order.note ? '\n📝 ' + order.note : '')
        + '\n\n📋 Trạng thái: ' + STATUS[status];
}

async function telegramApi(token, method, body) {
    const res = await fetch('https://api.telegram.org/bot' + token + '/' + method, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
    });
    return res.json();
}

module.exports = async function handler(req, res) {
    if (req.method !== 'POST') return res.status(200).send('OK');

    const update = req.body;
    if (!update) return res.status(200).send('OK');

    const settings = await fsGet('settings', 'telegram');
    if (!settings || !settings.token) return res.status(200).send('OK');
    const token = settings.token;

    if (update.callback_query) {
        const cb = update.callback_query;
        const [orderId, newStatus] = cb.data.split(':');

        if (!orderId) {
            await telegramApi(token, 'answerCallbackQuery', { callback_query_id: cb.id, text: 'Lỗi dữ liệu' });
            return res.status(200).send('OK');
        }

        if (newStatus === 'delete') {
            await Promise.all([
                fsDelete('orders', orderId),
                telegramApi(token, 'deleteMessage', { chat_id: cb.message.chat.id, message_id: cb.message.message_id }),
                telegramApi(token, 'answerCallbackQuery', { callback_query_id: cb.id, text: '🗑 Đã xóa đơn hàng' })
            ]);
            return res.status(200).send('OK');
        }

        if (!STATUS[newStatus]) {
            await telegramApi(token, 'answerCallbackQuery', { callback_query_id: cb.id, text: 'Lỗi dữ liệu' });
            return res.status(200).send('OK');
        }

        await fsUpdate('orders', orderId, { status: newStatus });

        const order = await fsGet('orders', orderId);

        await Promise.all([
            telegramApi(token, 'editMessageText', {
                chat_id: cb.message.chat.id,
                message_id: cb.message.message_id,
                text: buildOrderText(order, newStatus),
                reply_markup: buildKeyboard(orderId, newStatus)
            }),
            telegramApi(token, 'answerCallbackQuery', {
                callback_query_id: cb.id,
                text: '✅ Đã đổi: ' + STATUS[newStatus]
            })
        ]);
    }

    res.status(200).send('OK');
};
