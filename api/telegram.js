const admin = require('firebase-admin');

try {
    admin.app();
} catch (e) {
    admin.initializeApp({
        credential: admin.credential.cert({
            projectId: process.env.FIREBASE_PROJECT_ID,
            clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
            privateKey: (process.env.FIREBASE_PRIVATE_KEY || '').replace(/\\n/g, '\n')
        })
    });
}
const db = admin.firestore();

const STATUS = {
    pending: 'Chờ xác nhận',
    confirmed: 'Đã xác nhận',
    preparing: 'Đang chuẩn bị',
    delivering: 'Đang giao',
    done: 'Hoàn thành',
    cancelled: 'Đã hủy'
};

function fmtPrice(n) { return n.toLocaleString('vi-VN'); }

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
    return { inline_keyboard: rows };
}

function buildOrderText(order, status) {
    const items = order.items.map(i => '• ' + i.name + ' x' + i.qty + ' — ' + fmtPrice(i.price * i.qty) + 'đ').join('\n');
    const pay = order.payMethod === 'transfer' ? 'Chuyển khoản' : 'Tiền mặt';
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

    const settingsDoc = await db.collection('settings').doc('telegram').get();
    if (!settingsDoc.exists) return res.status(200).send('OK');
    const { token } = settingsDoc.data();
    if (!token) return res.status(200).send('OK');

    if (update.callback_query) {
        const cb = update.callback_query;
        const [orderId, newStatus] = cb.data.split(':');

        if (!orderId || !STATUS[newStatus]) {
            await telegramApi(token, 'answerCallbackQuery', { callback_query_id: cb.id, text: 'Lỗi dữ liệu' });
            return res.status(200).send('OK');
        }

        await db.collection('orders').doc(orderId).update({ status: newStatus });

        const orderDoc = await db.collection('orders').doc(orderId).get();
        const order = orderDoc.data();

        await telegramApi(token, 'editMessageText', {
            chat_id: cb.message.chat.id,
            message_id: cb.message.message_id,
            text: buildOrderText(order, newStatus),
            reply_markup: buildKeyboard(orderId, newStatus)
        });

        await telegramApi(token, 'answerCallbackQuery', {
            callback_query_id: cb.id,
            text: '✅ Đã đổi: ' + STATUS[newStatus]
        });
    }

    res.status(200).send('OK');
};
