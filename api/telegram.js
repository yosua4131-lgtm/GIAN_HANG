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

function fmtItems(orderItems) {
    var mainItems = (orderItems || []).filter(function(i) { return !i.addon; });
    var addonItems = (orderItems || []).filter(function(i) { return i.addon; });
    var grouped = {};
    mainItems.forEach(function(i) { var cat = i.category || 'Khác'; if (!grouped[cat]) grouped[cat] = []; grouped[cat].push(i); });
    var text = '';
    Object.keys(grouped).forEach(function(cat) {
        text += '📂 ' + cat + '\n';
        grouped[cat].forEach(function(i) { text += '  • ' + i.name + ' x' + i.qty + ' — ' + fmtPrice(i.price * i.qty) + 'đ\n'; });
    });
    if (addonItems.length) {
        text += '🥢 Món thêm\n';
        addonItems.forEach(function(i) { text += '  • ' + i.name + ' x' + i.qty + (i.price > 0 ? ' — ' + fmtPrice(i.price * i.qty) + 'đ' : '') + '\n'; });
    }
    return text.trim();
}

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
    var items = fmtItems(order.items);
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

async function fsQuery(collection, filters) {
    const token = await getAccessToken();
    const body = { structuredQuery: { from: [{ collectionId: collection }] } };
    if (filters && filters.length) {
        body.structuredQuery.where = { compositeFilter: { op: 'AND', filters: filters.map(f => ({
            fieldFilter: { field: { fieldPath: f.field }, op: f.op, value: { stringValue: f.value } }
        })) } };
    }
    const res = await fetch(FIRESTORE + ':runQuery', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
    });
    const data = await res.json();
    return (data || []).filter(d => d.document).map(d => ({
        id: d.document.name.split('/').pop(),
        ...parseDoc(d.document.fields)
    }));
}

async function fsListAll(collection) {
    const token = await getAccessToken();
    const res = await fetch(FIRESTORE + '/' + collection + '?pageSize=100', {
        headers: { 'Authorization': 'Bearer ' + token }
    });
    const data = await res.json();
    return (data.documents || []).map(d => ({
        id: d.name.split('/').pop(),
        ...parseDoc(d.fields)
    }));
}

const STATUS_ICON = { pending: '🕐', confirmed: '✅', preparing: '👨‍🍳', delivering: '🚚', done: '🎉', cancelled: '❌' };

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

    if (update.message && update.message.text) {
        const chatId = update.message.chat.id;
        const text = update.message.text.trim();

        if (text === '/gom') {
            const settings = await fsGet('settings', 'telegram');
            if (!settings || !settings.token) return res.status(200).send('OK');
            const token = settings.token;

            const [orders, addresses] = await Promise.all([
                fsListAll('orders'),
                fsListAll('addresses')
            ]);

            if (!orders.length) {
                await telegramApi(token, 'sendMessage', { chat_id: chatId, text: '📦 Không có đơn hàng nào.' });
                return res.status(200).send('OK');
            }

            addresses.sort(function(a, b) { return (a.order || 0) - (b.order || 0); });
            var addrMap = {};
            addresses.forEach(function(a) { addrMap[a.name] = a; });

            var grouped = {};
            var noAddr = [];
            orders.forEach(function(o) {
                if (o.address && addrMap[o.address]) {
                    if (!grouped[o.address]) grouped[o.address] = [];
                    grouped[o.address].push(o);
                } else {
                    noAddr.push(o);
                }
            });

            var num = 1;
            var promises = [];

            addresses.forEach(function(addr) {
                var list = grouped[addr.name];
                if (!list || !list.length) return;

                list.forEach(function(o) {
                    var icon = STATUS_ICON[o.status] || '📋';
                    var items = fmtItems(o.items);
                    var pay = o.payMethod === 'transfer' ? 'Chuyển khoản' : 'Tiền mặt';
                    var orderText = '📍 ' + num + '. ' + addr.name + '\n━━━━━━━━━━━━\n\n'
                        + icon + ' ' + o.customer + '\n'
                        + (o.phone ? '📞 ' + o.phone + '\n' : '')
                        + '\n' + items + '\n\n'
                        + '💰 Tổng: ' + fmtPrice(o.total) + 'đ\n'
                        + '💳 ' + pay
                        + (o.note ? '\n📝 ' + o.note : '')
                        + '\n\n📋 Trạng thái: ' + STATUS[o.status];

                    promises.push(telegramApi(token, 'sendMessage', {
                        chat_id: chatId,
                        text: orderText,
                        reply_markup: buildKeyboard(o.id, o.status)
                    }).then(function(result) {
                        if (result.ok && result.result) {
                            return fsUpdate('orders', o.id, {
                                telegramMsgId: String(result.result.message_id),
                                telegramChatId: String(chatId)
                            });
                        }
                    }));
                });
                num++;
            });

            noAddr.forEach(function(o) {
                var icon = STATUS_ICON[o.status] || '📋';
                var items = (o.items || []).map(function(i) { return '• ' + i.name + ' x' + i.qty + ' — ' + fmtPrice(i.price * i.qty) + 'đ'; }).join('\n');
                var pay = o.payMethod === 'transfer' ? 'Chuyển khoản' : 'Tiền mặt';
                var orderText = '📍 Chưa có địa chỉ\n━━━━━━━━━━━━\n\n'
                    + icon + ' ' + o.customer + '\n'
                    + (o.phone ? '📞 ' + o.phone + '\n' : '')
                    + '\n' + items + '\n\n'
                    + '💰 Tổng: ' + fmtPrice(o.total) + 'đ\n'
                    + '💳 ' + pay
                    + (o.note ? '\n📝 ' + o.note : '')
                    + '\n\n📋 Trạng thái: ' + STATUS[o.status];

                promises.push(telegramApi(token, 'sendMessage', {
                    chat_id: chatId,
                    text: orderText,
                    reply_markup: buildKeyboard(o.id, o.status)
                }).then(function(result) {
                    if (result.ok && result.result) {
                        return fsUpdate('orders', o.id, {
                            telegramMsgId: String(result.result.message_id),
                            telegramChatId: String(chatId)
                        });
                    }
                }));
            });

            res.status(200).send('OK');
            await Promise.all(promises);
            return;
        }

        return res.status(200).send('OK');
    }

    if (!update.callback_query) return res.status(200).send('OK');

    const cb = update.callback_query;
    const [orderId, newStatus] = cb.data.split(':');
    const chatId = cb.message.chat.id;
    const msgId = cb.message.message_id;
    const oldText = cb.message.text || '';

    const [settings] = await Promise.all([
        fsGet('settings', 'telegram'),
        // respond to Telegram immediately while fetching settings
    ]);
    if (!settings || !settings.token) return res.status(200).send('OK');
    const token = settings.token;

    if (!orderId) {
        await telegramApi(token, 'answerCallbackQuery', { callback_query_id: cb.id, text: 'Lỗi dữ liệu' });
        return res.status(200).send('OK');
    }

    if (newStatus === 'delete') {
        res.status(200).send('OK');
        await Promise.all([
            fsDelete('orders', orderId),
            telegramApi(token, 'deleteMessage', { chat_id: chatId, message_id: msgId }),
            telegramApi(token, 'answerCallbackQuery', { callback_query_id: cb.id, text: '🗑 Đã xóa đơn hàng' })
        ]);
        return;
    }

    if (!STATUS[newStatus]) {
        await telegramApi(token, 'answerCallbackQuery', { callback_query_id: cb.id, text: 'Lỗi dữ liệu' });
        return res.status(200).send('OK');
    }

    var newText = oldText.replace(/📋 Trạng thái: .+/, '📋 Trạng thái: ' + STATUS[newStatus]);

    res.status(200).send('OK');
    await Promise.all([
        fsUpdate('orders', orderId, { status: newStatus }),
        telegramApi(token, 'editMessageText', {
            chat_id: chatId,
            message_id: msgId,
            text: newText,
            reply_markup: buildKeyboard(orderId, newStatus)
        }),
        telegramApi(token, 'answerCallbackQuery', {
            callback_query_id: cb.id,
            text: '✅ ' + STATUS[newStatus]
        })
    ]);
};
