/**
 * Project: CODEX AI
 * Description: WhatsApp Bot Bootstrapper & Dashboard Server
 */

const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');
const pino = require('pino');
const readline = require('readline');
const fs = require('fs');
const chalk = require('chalk');
const { Boom } = require('@hapi/boom');

// Global State & Configurations
global.crysStats = {
    messages: 0,
    commands: 0,
    startTime: Date.now(),
    uptime: 0
};
global.botInstances = new Map();
global.onlineUsers = new Set();

const app = express();
const port = process.env.PORT || 3000;
const server = http.createServer(app);
const io = socketIo(server);

// Middleware & Static Assets
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'Public')));

// Import Baileys & Local Modules
let makeWASocket, Browsers, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, jidDecode, downloadContentFromMessage, jidNormalizedUser, makeInMemoryStore;

const loadBaileys = async () => {
    const baileys = await import('@whiskeysockets/baileys');
    makeWASocket = baileys.default;
    Browsers = baileys.Browsers;
    useMultiFileAuthState = baileys.useMultiFileAuthState;
    DisconnectReason = baileys.DisconnectReason;
    fetchLatestBaileysVersion = baileys.fetchLatestBaileysVersion;
    jidDecode = baileys.jidDecode;
    downloadContentFromMessage = baileys.downloadContentFromMessage;
    jidNormalizedUser = baileys.jidNormalizedUser;
    makeInMemoryStore = baileys.makeInMemoryStore;
};

const config = () => require('./settings/config');
const { smsg } = require('./library/serialize');
const { loadCommands } = require('./src/Plugin/crysLoadCmd');
const { handleMessage } = require('./src/Plugin/crysMsg');
const { crysStatistic } = require('./src/Plugin/crysStatistic');

// Error Handling: Ignore common non-fatal connection errors
const ignoredErrors = [
    'read ECONNRESET', 'EKEYTYPE', 'item-not-found', 'rate-overlimit', 
    'Socket connection timeout', 'write ECONNRESET', 'ECONNREFUSED', 
    'Bad MAC', 'decrypt error', 'Socket closed'
];

/**
 * UI Utilities
 */
const question = (text) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    return new Promise(resolve => {
        rl.question(chalk.yellow(text), (answer) => {
            resolve(answer);
            rl.close();
        });
    });
};

const showBanner = () => {
    console.log(chalk.cyan(`
╔═══════════════════════════════════════════╗
║   𝗖𝗢𝗗𝗘𝗫 AI  -   𝓹𝓻𝓸𝓯𝓮𝓼𝓼𝓲𝓸𝓷𝓪𝓵        ║
║   CONNECTION : 𝗖𝗢𝗗𝗘𝗫 𝐎𝐅𝐅𝐈𝐂𝐈𝐀𝐋      ║
║   MODEL      : 𝗖𝗢𝗗𝗘𝗫             ║
║ ✪ ALL COMMANDS WORKING + REAL CHANNEL FWD ║
╚═══════════════════════════════════════════╝`));
};

/**
 * Core Bot Logic
 */
const clientstart = async () => {
    await loadBaileys();
    showBanner();

    const { state, saveCreds } = await useMultiFileAuthState('./' + config().session);
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
        logger: pino({ level: 'silent' }),
        printQRInTerminal: !config().status.enabled,
        auth: state,
        version,
        browser: Browsers.ubuntu('Chrome'),
        getMessage: async (key) => {
            // Retrieve message from internal store
            return null; 
        }
    });

    // Pairing Code logic if session doesn't exist
    if (config().settings.enabled && !sock.authState.creds.registered) {
        const phoneNumber = await question('Enter your WhatsApp number (without +): ');
        const code = await sock.requestPairingCode(phoneNumber);
        console.log(chalk.green(`Your pair code: `) + chalk.bold.green(code));
    }

    // Event: Connection Update
    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;
        
        if (connection === 'connecting') console.log(chalk.yellow('🔄 Connecting...'));
        
        if (connection === 'open') {
            console.log(chalk.green('✅ Connected!'));
            const botId = sock.user.id.split(':')[0];
            
            // Send Startup Message
            const startMsg = `┏━━━━〔 ✦ 𝗖𝗢𝗗𝗘𝗫 𝐀𝐈 〕━━━━━\n` +
                             `✓ ✪ Version: 2.0.0\n` +
                             `✓ ☬ Mode: ${config().settings.public ? 'Public' : 'Private'}\n` +
                             `✓ 𓉤 Owner: 𝗖𝗢𝗗𝗘𝗫\n`;
                             
            await sock.sendMessage(botId + '@s.whatsapp.net', { 
                text: startMsg,
                contextInfo: {
                    externalAdReply: {
                        title: '𝗖𝗢𝗗𝗘𝗫✦𝐀𝐈',
                        body: '𝐬𝐞𝐜𝐮𝐫𝐞𝐝 𝓬𝓸𝓭𝓮𝔁 𝓸𝓯𝓯𝓲𝓬𝓲𝓪𝓵',
                        thumbnailUrl: 'https://i.imgur.com/BoN9kdC.png',
                        sourceUrl: 'https://whatsapp.com/channel/0029Vb6sMEy96H4VI2w3I50F'
                    }
                }
            });
        }

        if (connection === 'close') {
            const reason = lastDisconnect?.error?.output?.statusCode;
            if (reason === DisconnectReason.loggedOut) {
                console.log(chalk.red('🚫 Logged out. Delete session and restart.'));
                process.exit(1);
            } else {
                console.log(chalk.yellow('🔄 Reconnecting in 3 seconds...'));
                setTimeout(clientstart, 3000);
            }
        }
    });

    // Event: Messages Upsert (New Message)
    sock.ev.on('messages.upsert', async (chatUpdate) => {
        try {
            const mek = chatUpdate.messages[0];
            if (!mek.message) return;
            const m = await smsg(sock, mek);
            
            global.crysStats.messages++;
            
            // Handle AFK, Anti-link, and Command processing here
            await handleMessage(sock, m); 
            
        } catch (err) {
            console.error('[MSG ERROR]', err);
        }
    });

    sock.ev.on('creds.update', saveCreds);
    return sock;
};

// Initialize Server and Bot
(async () => {
    try {
        if (!fs.existsSync('./database')) fs.mkdirSync('./database', { recursive: true });
        loadCommands();
        server.listen(port, () => {
            console.log(chalk.green(`✅ Dashboard: http://localhost:${port}`));
        });
        crysStatistic(app, io);
        await clientstart();
    } catch (err) {
        console.error('Startup error:', err);
    }
})();
                    
