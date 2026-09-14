const express = require('express');
const { 
    default: makeWASocket, 
    useMultiFileAuthState, 
    Browsers, 
    fetchLatestBaileysVersion,
    DisconnectReason // Added to handle sync drops
} = require('@whiskeysockets/baileys');
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
    
    // We track this so Express doesn't crash trying to send the webpage twice if a reconnect happens
    let responseSent = false; 

    // Wrap the socket creation in a function so it can call itself if the connection drops
    async function startSocket() {
        const { state, saveCreds } = await useMultiFileAuthState(sessionFolder);
        const { version } = await fetchLatestBaileysVersion();
        
        const sock = makeWASocket({
            auth: state,
            version,
            printQRInTerminal: false,
            logger: pino({ level: "silent" }),
            browser: Browsers.macOS("Firefox"),
            markOnlineOnConnect: false // Prevents heavy presence updates during initial sync
        });

        sock.ev.on('creds.update', saveCreds);

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;
            
            if (qr && !responseSent) {
                responseSent = true;
                try {
                    setTimeout(async () => {
                        let code = await sock.requestPairingCode(phone);
                        code = code?.match(/.{1,4}/g)?.join("-") || code;
                        
                        res.send(`
                            <div style="font-family: system-ui, sans-serif; text-align: center; max-width: 500px; margin: 50px auto; padding: 30px; box-shadow: 0 4px 8px rgba(0,0,0,0.1); border-radius: 10px; background-color: #f9f9f9;">
                                <h2>Your Pairing Code</h2>
                                <h1 style="letter-spacing: 5px; color: #25D366; font-size: 40px; margin: 20px 0;">${code}</h1>
                                <p style="font-size: 16px; color: #333;">Check your phone! A push notification has been sent.</p>
                                <p style="font-size: 14px; color: #666; margin-top: 15px;">Tap the notification, enter the code above. The final Base64 Session ID will be sent directly to your WhatsApp messages!</p>
                            </div>
                        `);
                    }, 1500);
                } catch (err) {
                    if (!res.headersSent) res.status(500).send("Error requesting pairing code.");
                }
            }
            
            // This is the crucial fix for the eternal "Logging in..." screen
            if (connection === 'close') {
                const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
                if (shouldReconnect) {
                    console.log("Connection dropped during sync. Reconnecting...");
                    startSocket(); // Instantly re-establishes the connection so the phone can finish logging in
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
                        
                        console.log(`Session successfully generated for ${phone}`);
                        
                        sock.end();
                        fs.rmSync(sessionFolder, { recursive: true, force: true });
                    }, 2000);
                } catch (err) {
                    console.error("Failed to process session:", err);
                }
            }
        });
    }

    startSocket();
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
