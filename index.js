const express = require('express');
const { default: makeWASocket, useMultiFileAuthState, Browsers } = require('@whiskeysockets/baileys');
const pino = require('pino');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

app.get('/', (req, res) => {
    res.send(`
        <div style="font-family: system-ui, sans-serif; text-align: center; max-width: 500px; margin: 50px auto; padding: 20px; box-shadow: 0 4px 8px rgba(0,0,0,0.1); border-radius: 10px;">
            <h2 style="color: #25D366;">WhatsApp Session Generator</h2>
            <p style="color: #555;">Enter your phone number with country code (e.g., 919876543210)</p>
            <form action="/pair" method="GET" style="margin-top: 20px;">
                <input type="text" name="phone" placeholder="919876543210" style="padding: 12px; width: 80%; border: 1px solid #ccc; border-radius: 5px; font-size: 16px; margin-bottom: 15px;" required />
                <br>
                <button type="submit" style="background-color: #25D366; color: white; border: none; padding: 12px 24px; border-radius: 5px; font-size: 16px; cursor: pointer; font-weight: bold;">Get Pairing Code</button>
            </form>
        </div>
    `);
});

app.get('/pair', async (req, res) => {
    let phone = req.query.phone;
    if (!phone) return res.status(400).send("Phone number is required");
    
    phone = phone.replace(/[^0-9]/g, '');
    const sessionFolder = `./session-${phone}`;
    const { state, saveCreds } = await useMultiFileAuthState(sessionFolder);
    
    const sock = makeWASocket({
        auth: state,
        printQRInTerminal: false,
        logger: pino({ level: "silent" }),
        // FIX 1: Change identity to bypass WhatsApp's anti-bot block
        browser: Browsers.macOS('Desktop') 
    });

    sock.ev.on('creds.update', saveCreds);
    
    let responseSent = false; // Prevents Express from crashing if multiple events fire

    sock.ev.on('connection.update', async (update) => {
        const { connection, qr } = update;
        
        // FIX 2: Only request the pairing code when the socket confirms it is fully ready
        if (qr && !responseSent && !sock.authState.creds.registered) {
            responseSent = true;
            try {
                let code = await sock.requestPairingCode(phone);
                code = code?.match(/.{1,4}/g)?.join("-") || code;
                
                res.send(`
                    <div style="font-family: system-ui, sans-serif; text-align: center; max-width: 500px; margin: 50px auto; padding: 30px; box-shadow: 0 4px 8px rgba(0,0,0,0.1); border-radius: 10px; background-color: #f9f9f9;">
                        <h2>Your Pairing Code</h2>
                        <h1 style="letter-spacing: 5px; color: #25D366; font-size: 40px; margin: 20px 0;">${code}</h1>
                        <p style="font-size: 16px; color: #333;">Check your phone! A push notification has been sent to your WhatsApp.</p>
                        <p style="font-size: 14px; color: #666; margin-top: 15px;">Tap the notification, enter the code above, and your Session ID will be sent to your WhatsApp messages automatically.</p>
                    </div>
                `);
            } catch (err) {
                if (!res.headersSent) res.status(500).send("Error requesting pairing code.");
            }
        }
        
        if (connection === 'open') {
            try {
                setTimeout(async () => {
                    const creds = fs.readFileSync(`${sessionFolder}/creds.json`);
                    const sessionString = Buffer.from(creds).toString('base64');
                    
                    const userJid = sock.user.id.split(':')[0] + '@s.whatsapp.net';
                    
                    await sock.sendMessage(userJid, { 
                        text: `*✅ Session Connected!*\n\nCopy your Base64 Session Code below. Keep it safe and do not share it:\n\n\`\`\`${sessionString}\`\`\`` 
                    });
                    
                    sock.end();
                    fs.rmSync(sessionFolder, { recursive: true, force: true });
                }, 1500);
            } catch (err) {
                console.error("Failed to send session:", err);
            }
        }
    });
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
