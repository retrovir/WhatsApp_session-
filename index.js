const express = require('express');
const { default: makeWASocket, useMultiFileAuthState } = require('@whiskeysockets/baileys');
const pino = require('pino');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

// Serve the web form
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

// Handle the pairing logic
app.get('/pair', async (req, res) => {
    let phone = req.query.phone;
    if (!phone) return res.status(400).send("Phone number is required");
    
    // Remove any +, spaces, or dashes
    phone = phone.replace(/[^0-9]/g, '');

    const sessionFolder = `./session-${phone}`;
    const { state, saveCreds } = await useMultiFileAuthState(sessionFolder);
    
    const sock = makeWASocket({
        auth: state,
        printQRInTerminal: false,
        logger: pino({ level: "silent" }),
        browser: ["Ubuntu", "Chrome", "20.0.04"] // Mandatory for pairing code to work
    });

    sock.ev.on('creds.update', saveCreds);
    
    sock.ev.on('connection.update', async (update) => {
        const { connection } = update;
        
        if (connection === 'open') {
            try {
                // Wait briefly for credentials to fully write to disk
                setTimeout(async () => {
                    const creds = fs.readFileSync(`${sessionFolder}/creds.json`);
                    const sessionString = Buffer.from(creds).toString('base64');
                    
                    const userJid = sock.user.id.split(':')[0] + '@s.whatsapp.net';
                    
                    await sock.sendMessage(userJid, { 
                        text: `*✅ Session Connected!*\n\nCopy your Base64 Session Code below. Keep it safe and do not share it:\n\n\`\`\`${sessionString}\`\`\`` 
                    });
                    
                    console.log(`Session successfully sent to ${phone}`);
                    
                    // Disconnect and clean up storage
                    sock.end();
                    fs.rmSync(sessionFolder, { recursive: true, force: true });
                }, 1500);
            } catch (err) {
                console.error("Error sending session code:", err);
            }
        }
    });

    // Request the pairing code from WhatsApp
    if (!sock.authState.creds.registered) {
        setTimeout(async () => {
            try {
                let code = await sock.requestPairingCode(phone);
                // Format code as XXXX-XXXX for readability
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
                res.status(500).send("Error requesting pairing code. Ensure the number is correct and has a WhatsApp account.");
            }
        }, 2000); // 2-second delay ensures socket is ready before requesting code
    } else {
        res.send("This session is already registered. Try again with a different number or clear the server cache.");
    }
});

app.listen(PORT, () => console.log(`Pairing Server running on port ${PORT}`));
