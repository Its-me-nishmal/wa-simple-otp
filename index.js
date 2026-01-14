const express = require('express');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, generateWAMessageFromContent, proto } = require('@whiskeysockets/baileys');
const pino = require('pino');
const QRCode = require('qrcode-terminal');
const QrImage = require('qrcode');

const app = express();
const port = 3000;

let sock;
let currentQR;
let isConnected = false;

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
            currentQR = qr;
            console.log('Scan the QR code below:');
            QRCode.generate(qr, { small: true });
        }
        if (connection === 'close') {
            isConnected = false;
            currentQR = null; // Clear QR on close/disconnect, logic will generate new one if needed
            const shouldReconnect = (lastDisconnect.error)?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log('Connection closed due to ', lastDisconnect.error, ', reconnecting ', shouldReconnect);
            if (shouldReconnect) {
                // Retry connection
                setTimeout(connectToWhatsApp, 1000);
            }
        } else if (connection === 'open') {
            console.log('Opened connection to WhatsApp!');
            isConnected = true;
            currentQR = null;
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

app.get('/send-image', async (req, res) => {
    const { imageUrl, mobile, caption } = req.query;

    if (!sock) {
        return res.status(503).json({ error: 'WhatsApp client not ready' });
    }

    if (!imageUrl || !mobile) {
        return res.status(400).json({ error: 'Missing imageUrl or mobile parameter' });
    }

    // Basic cleanup of phone number
    const jid = mobile.replace(/\D/g, '') + '@s.whatsapp.net';

    try {
        // Fetch the image from the URL
        const response = await fetch(imageUrl);

        if (!response.ok) {
            throw new Error(`Failed to fetch image: ${response.statusText}`);
        }

        // Get the image buffer
        const imageBuffer = Buffer.from(await response.arrayBuffer());

        // Prepare message object
        const messageOptions = {
            image: imageBuffer
        };

        // Add caption if provided
        if (caption) {
            messageOptions.caption = caption;
        }

        // Send the image
        await sock.sendMessage(jid, messageOptions);

        res.json({
            success: true,
            message: 'Image sent successfully',
            hasCaption: !!caption
        });
    } catch (err) {
        console.error('Error sending image:', err);
        res.status(500).json({
            error: 'Failed to send image',
            details: err.toString()
        });
    }
});

app.get('/health', (req, res) => {
    res.status(200).send('OK');
});

app.get('/qr', async (req, res) => {
    if (isConnected) {
        return res.send('<html><body><h1>Connected</h1></body></html>');
    }
    if (currentQR) {
        try {
            const url = await QrImage.toDataURL(currentQR);
            return res.send(`<html><body><h1>Scan QR Code</h1><img src="${url}"/></body></html>`);
        } catch (err) {
            return res.status(500).send('Error generating QR');
        }
    }
    return res.send('<html><body><h1>Initializing... or No QR available yet</h1></body></html>');
});

// Keep-alive mechanism for Render
const RENDER_EXTERNAL_URL = 'https://wa-simple-otp.onrender.com';
if (RENDER_EXTERNAL_URL) {
    setInterval(() => {
        // Use global fetch (available in Node.js 18+)
        fetch(`${RENDER_EXTERNAL_URL}/health`)
            .then(res => console.log(`Keep-alive ping status: ${res.status}`))
            .catch(err => console.error(`Keep-alive ping failed: ${err.message}`));
    }, 1 * 60 * 1000); // Ping every 1 minutes
}

app.listen(port, () => {
    console.log(`Server listening at http://localhost:${port}`);
});
