require('dotenv').config();
const express = require('express');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, generateWAMessageFromContent, proto } = require('@whiskeysockets/baileys');
const pino = require('pino');
const QRCode = require('qrcode-terminal');
const QrImage = require('qrcode');
const puppeteer = require('puppeteer-core');
const chromium = require('@sparticuz/chromium');
const { createCanvas, loadImage } = require('canvas');
const path = require('path');
const crypto = require('crypto');

const app = express();
const port = 3000;

// Middleware to parse JSON (for webhooks)
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

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

    let browser = null;

    try {
        console.log(`Fetching image from: ${imageUrl}`);

        // First, check what content type the URL returns
        const headResponse = await fetch(imageUrl, {
            method: 'HEAD',
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                'Accept': 'image/*, text/html, */*'
            }
        });

        const contentType = headResponse.headers.get('content-type');
        console.log(`URL content-type: ${contentType}`);

        let imageBuffer;
        let method = 'unknown';

        // If content-type is HTML, use puppeteer to render and capture
        if (contentType && (contentType.includes('text/html') || contentType.includes('application/xhtml'))) {
            console.log('Detected HTML page - using puppeteer to capture rendered image');
            method = 'puppeteer';

            // Launch headless browser
            browser = await puppeteer.launch({
                args: chromium.args,
                defaultViewport: chromium.defaultViewport,
                executablePath: await chromium.executablePath(),
                headless: chromium.headless
            });

            const page = await browser.newPage();

            // Set viewport
            await page.setViewport({ width: 1920, height: 1080 });

            // Navigate to the URL and wait for network to be idle
            await page.goto(imageUrl, {
                waitUntil: 'networkidle0',
                timeout: 30000
            });

            // Wait a bit for any animations/rendering
            await new Promise(resolve => setTimeout(resolve, 2000));

            // Take screenshot
            imageBuffer = await page.screenshot({
                type: 'png',
                fullPage: true
            });

            await browser.close();
            browser = null;

        } else if (contentType && contentType.startsWith('image/')) {
            // Direct image - fetch normally
            console.log('Detected direct image - fetching normally');
            method = 'direct';

            const response = await fetch(imageUrl, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                    'Accept': 'image/*, */*'
                }
            });

            if (!response.ok) {
                throw new Error(`Failed to fetch image: ${response.status} ${response.statusText}`);
            }

            imageBuffer = Buffer.from(await response.arrayBuffer());

        } else {
            // Unknown content type - try puppeteer as fallback
            console.log(`Unknown content-type: ${contentType} - trying puppeteer as fallback`);
            method = 'puppeteer-fallback';

            browser = await puppeteer.launch({
                args: chromium.args,
                defaultViewport: chromium.defaultViewport,
                executablePath: await chromium.executablePath(),
                headless: chromium.headless
            });

            const page = await browser.newPage();
            await page.setViewport({ width: 1200, height: 1550 });
            await page.goto(imageUrl, { waitUntil: 'networkidle0', timeout: 30000 });
            await new Promise(resolve => setTimeout(resolve, 2000));
            imageBuffer = await page.screenshot({ type: 'png', fullPage: true });

            await browser.close();
            browser = null;
        }

        // Validate buffer size
        if (imageBuffer.length === 0) {
            throw new Error('Received empty image data');
        }

        console.log(`Image size: ${imageBuffer.length} bytes (method: ${method})`);

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

        console.log(`Image sent successfully to ${jid}`);

        res.json({
            success: true,
            message: 'Image sent successfully',
            hasCaption: !!caption,
            imageSize: imageBuffer.length,
            contentType: contentType,
            method: method
        });
    } catch (err) {
        console.error('Error sending image:', err);

        // Clean up browser if it's still open
        if (browser) {
            try {
                await browser.close();
            } catch (closeErr) {
                console.error('Error closing browser:', closeErr);
            }
        }

        res.status(500).json({
            error: 'Failed to send image',
            details: err.toString()
        });
    }
});

// Convenience endpoint for MYL poster generation using Canvas (FAST!)
app.get('/send-myl', async (req, res) => {
    const { name, quantity, amount, mobile, caption } = req.query;

    if (!sock) {
        return res.status(503).json({ error: 'WhatsApp client not ready' });
    }

    if (!name || !mobile) {
        return res.status(400).json({ error: 'Missing required parameters: name and mobile' });
    }

    const qty = Number(quantity || 1);
    const amt = Number(amount || (qty * 350));

    try {
        const canvas = createCanvas(1200, 1550);
        const ctx = canvas.getContext('2d');

        // Background image
        const img = await loadImage(path.join(__dirname, 'recipt.jpeg'));
        ctx.drawImage(img, 0, 0, 1200, 1550);

        ctx.textBaseline = 'middle';
        ctx.textAlign = 'left';

        /* ---------- NAME (33px) ---------- */
        ctx.fillStyle = '#751d08';
        ctx.font = 'bold 33px sans-serif';
        const nameX = 201;
        const nameY = 528 + ((583 - 528) / 2);
        ctx.fillText(name.toUpperCase(), nameX, nameY);

        /* ---------- QUANTITY (30px) ---------- */
        ctx.fillStyle = '#000000';
        ctx.font = 'bold 30px sans-serif';
        const qtyX = 774;
        const qtyY = 765 + ((802 - 765) / 2) + 10;
        ctx.fillText(String(qty), qtyX, qtyY);

        /* ---------- AMOUNT (30px) ---------- */
        const amtX = 754;
        const amtY = 821 + ((855 - 821) / 2) + 10;
        ctx.fillText(`₹${amt}`, amtX, amtY);

        /* ---------- WATERMARK ---------- */
        ctx.font = 'italic 18px sans-serif';
        ctx.fillStyle = 'rgba(0, 0, 0, 0.55)';
        ctx.textAlign = 'center';

        const watermarkText = `Generated on ${new Date().toLocaleDateString()} ${new Date().toLocaleTimeString()}`;
        ctx.fillText(watermarkText, canvas.width / 2, canvas.height - 30);

        /* ---------- IMAGE BUFFER ---------- */
        const imageBuffer = canvas.toBuffer('image/jpeg', { quality: 0.9 });

        /* ---------- SEND WHATSAPP ---------- */
        const jid = mobile.replace(/\D/g, '') + '@s.whatsapp.net';
        const message = { image: imageBuffer };
        if (caption) message.caption = caption;

        await sock.sendMessage(jid, message);

        res.json({
            success: true,
            name,
            quantity: qty,
            amount: amt,
            imageSize: imageBuffer.length,
            watermark: true
        });

    } catch (err) {
        res.status(500).json({
            error: 'Failed to send MYL poster',
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
