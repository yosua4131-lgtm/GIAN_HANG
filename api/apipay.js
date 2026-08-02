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

async function fsGet(collection, docId) {
    const token = await getAccessToken();
    const r = await fetch(FIRESTORE + '/' + collection + '/' + docId, {
        headers: { 'Authorization': 'Bearer ' + token }
    });
    if (!r.ok) return null;
    const doc = await r.json();
    if (!doc.fields) return null;
    const obj = {};
    for (var k in doc.fields) {
        var v = doc.fields[k];
        if ('stringValue' in v) obj[k] = v.stringValue;
        else if ('integerValue' in v) obj[k] = Number(v.integerValue);
        else if ('booleanValue' in v) obj[k] = v.booleanValue;
        else if ('arrayValue' in v) {
            obj[k] = (v.arrayValue.values || []).map(function(item) {
                if (item.mapValue && item.mapValue.fields) {
                    var m = {};
                    for (var mk in item.mapValue.fields) {
                        var mv = item.mapValue.fields[mk];
                        if ('stringValue' in mv) m[mk] = mv.stringValue;
                        else if ('integerValue' in mv) m[mk] = Number(mv.integerValue);
                    }
                    return m;
                }
                return item.stringValue || '';
            });
        }
    }
    return obj;
}

async function fsCreate(collection, data) {
    const token = await getAccessToken();
    const fields = {};
    for (var k in data) {
        if (typeof data[k] === 'string') fields[k] = { stringValue: data[k] };
        else if (typeof data[k] === 'number') fields[k] = { integerValue: String(data[k]) };
        else if (typeof data[k] === 'boolean') fields[k] = { booleanValue: data[k] };
        else if (Array.isArray(data[k])) {
            fields[k] = { arrayValue: { values: data[k].map(function(v) { return { stringValue: String(v) }; }) } };
        }
    }
    await fetch(FIRESTORE + '/' + collection, {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
        body: JSON.stringify({ fields: fields })
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

    // Tao tem neu la don mua tem
    try {
        var orderData = await fsGet('orders', orderId);
        if (orderData && orderData.isStampPurchase && orderData.stampPhone && orderData.stampQuantity) {
            var stampPhone = orderData.stampPhone;
            var stampCatId = orderData.stampCategoryId || '';
            var stampCatName = orderData.stampCategoryName || '';
            var stampQty = Number(orderData.stampQuantity);
            var stampCode = orderData.stampCode || '';
            var stampProductIds = orderData.stampProductIds || [];
            var stampTargetPrice = orderData.stampTargetPrice || '';

            var existingStamps = stampCatId ? await fsQuery('customerStamps', [
                { field: 'phone', op: 'EQUAL', value: stampPhone },
                { field: 'categoryId', op: 'EQUAL', value: stampCatId }
            ]) : [];

            if (existingStamps.length > 0) {
                var existDoc = await fsGet('customerStamps', existingStamps[0].id);
                if (existDoc) {
                    await fsUpdate('customerStamps', existingStamps[0].id, {
                        remaining: (Number(existDoc.remaining) || 0) + stampQty,
                        total: (Number(existDoc.total) || 0) + stampQty
                    });
                }
            } else {
                var stampData = {
                    phone: stampPhone, name: '', categoryId: stampCatId, categoryName: stampCatName,
                    remaining: stampQty, total: stampQty, code: stampCode, type: 'purchase',
                    createdAt: new Date().toISOString()
                };
                if (stampProductIds.length > 0) {
                    stampData.productIds = stampProductIds;
                }
                if (stampTargetPrice !== '') {
                    stampData.targetPrice = stampTargetPrice;
                }
                await fsCreate('customerStamps', stampData);
            }
        }
    } catch(e) {}

    // Gui thong bao Telegram
    try {
        var teleSettings = await fsGet('settings', 'telegram');
        var order = await fsGet('orders', orderId);
        if (teleSettings && teleSettings.token && order) {
            var token = teleSettings.token;
            var chatId = order.telegramChatId || teleSettings.chatId;
            var items = (order.items || []);
            var mainItems = items.filter(function(i) { return !i.addon; });
            var addonItems = items.filter(function(i) { return i.addon; });
            var grouped = {};
            mainItems.forEach(function(i) {
                var cat = i.category || 'Khác';
                if (!grouped[cat]) grouped[cat] = [];
                grouped[cat].push(i);
            });
            var itemsText = '';
            Object.keys(grouped).forEach(function(cat) {
                itemsText += '📂 ' + cat + '\n';
                grouped[cat].forEach(function(i) {
                    itemsText += '  • ' + (i.name || '') + ' x' + (i.qty || 1) + ' — ' + Number((i.price || 0) * (i.qty || 1)).toLocaleString('vi-VN') + 'đ\n';
                });
            });
            if (addonItems.length) {
                itemsText += '🥢 Món thêm\n';
                addonItems.forEach(function(i) {
                    itemsText += '  • ' + (i.name || '') + ' x' + (i.qty || 1) + (i.price > 0 ? ' — ' + Number(i.price * (i.qty || 1)).toLocaleString('vi-VN') + 'đ' : '') + '\n';
                });
            }
            var text = '✅ ĐƠN HÀNG ĐÃ THANH TOÁN!\n\n'
                + '👤 ' + (order.customer || '') + '\n'
                + (order.phone ? '📞 ' + order.phone + '\n' : '')
                + (order.address ? '📍 ' + order.address + '\n' : '')
                + '\n' + itemsText + '\n'
                + '💰 Tổng: ' + Number(order.total || amount).toLocaleString('vi-VN') + 'đ\n'
                + '🔖 Mã CK: ' + orderCode + '\n'
                + (order.note ? '📝 ' + order.note + '\n' : '')
                + '\n💳 Chuyển khoản đã được xác nhận tự động';

            // Gui tin moi + luu msgId de xoa sau
            var sendRes = await fetch('https://api.telegram.org/bot' + token + '/sendMessage', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ chat_id: chatId, text: text })
            });
            var sendData = await sendRes.json();
            if (sendData.ok && sendData.result) {
                await fsUpdate('orders', orderId, { telegramPayMsgId: sendData.result.message_id });
            }

            // Cap nhat tin cu neu co
            if (order.telegramMsgId && chatId) {
                var items = (order.items || []);
                var itemsText = '';
                items.forEach(function(i) {
                    itemsText += '  • ' + (i.name || '') + ' x' + (i.qty || 1) + '\n';
                });
                var updatedText = '🛒 ĐƠN HÀNG MỚI!\n\n'
                    + '👤 ' + (order.customer || '') + '\n'
                    + (order.phone ? '📞 ' + order.phone + '\n' : '')
                    + (order.address ? '📍 ' + order.address + '\n' : '')
                    + '\n' + itemsText + '\n'
                    + '💰 Tổng: ' + Number(order.total || amount).toLocaleString('vi-VN') + 'đ\n'
                    + '💳 Chuyển khoản\n'
                    + '🔖 Mã CK: ' + orderCode
                    + '\n\n✅ Đã thanh toán';
                var keyboard = { inline_keyboard: [
                    [{ text: '✅ Đã thanh toán', callback_data: orderId + ':confirmed' }, { text: 'Đang chuẩn bị', callback_data: orderId + ':preparing' }],
                    [{ text: 'Đang giao', callback_data: orderId + ':delivering' }, { text: 'Hoàn thành', callback_data: orderId + ':done' }]
                ]};
                await fetch('https://api.telegram.org/bot' + token + '/editMessageText', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ chat_id: chatId, message_id: order.telegramMsgId, text: updatedText, reply_markup: keyboard })
                });
            }
        }
    } catch(e) {}

    return res.status(200).json({ success: true, orderId: orderId });
};
