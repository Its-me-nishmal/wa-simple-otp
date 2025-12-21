const express = require('express');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, generateWAMessageFromContent, proto } = require('@whiskeysockets/baileys');
const pino = require('pino');
const QRCode = require('qrcode-terminal');

const app = express();
const port = 3000;

let sock;

async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');

    const newSock = makeWASocket({
        logger: pino({ level: 'silent' }),
        // printQRInTerminal: true, // Deprecated
        auth: state,
    });

    newSock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;
        if (qr) {
            console.log('Scan the QR code below:');
            QRCode.generate(qr, { small: true });
        }
        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect.error)?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log('Connection closed due to ', lastDisconnect.error, ', reconnecting ', shouldReconnect);
            if (shouldReconnect) {
                // Retry connection
                setTimeout(connectToWhatsApp, 1000);
            }
        } else if (connection === 'open') {
            console.log('Opened connection to WhatsApp!');
            sock = newSock;
        }
    });

    newSock.ev.on('creds.update', saveCreds);

    sock = newSock;
}

connectToWhatsApp();

app.get('/send-otp', async (req, res) => {
    const { phonenumber, message } = req.query;

    if (!sock) {
        return res.status(503).json({ error: 'WhatsApp client not ready' });
    }

    if (!phonenumber || !message) {
        return res.status(400).json({ error: 'Missing phonenumber or message' });
    }

    // Basic cleanup of phone number (remove +, spaces, etc if needed, but assuming user sends cleaner format or just string)
    // Baileys expects JID format: 1234567890@s.whatsapp.net
    const jid = phonenumber.replace(/\D/g, '') + '@s.whatsapp.net';

    try {
        await sock.sendMessage(jid, { text: message });
        res.json({ success: true, message: 'Message sent' });
    } catch (err) {
        console.error('Error sending message:', err);
        res.status(500).json({ error: 'Failed to send message', details: err.toString() });
    }
});

app.listen(port, () => {
    console.log(`Server listening at http://localhost:${port}`);
});
