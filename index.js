const { Telegraf, Markup } = require('telegraf');
const { makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestWaWebVersion } = require('@whiskeysockets/baileys');
const fs = require('fs-extra');
const path = require('path');
const pino = require('pino');

// Config
const config = require('./config.js');

// ====================
// CHANNEL CONFIGURATION
// ====================
const CHANNEL_ID = -1003267327509;
const CHANNEL_LINK = 'https://t.me/wanzxcvi';
const CHANNEL_TITLE = '—͟͞͞𝐖𝐀𝐍𝐙 𝐎𝐅𝐅𝐈𝐂𝐈𝐀𝐋 || 𝐈𝐍𝐅𝐎𝐑𝐌𝐀𝐓𝐈𝐎𝐍';

// ====================
// SESSION MANAGEMENT
// ====================
const SESSION_DIR = config.SESSION_DIR;

// Buat folder sessions per user
if (!fs.existsSync(SESSION_DIR)) {
  fs.mkdirSync(SESSION_DIR, { recursive: true });
}

// ====================
// DATA STORAGE
// ====================
// Storage per user
const userData = new Map(); // userId -> { connections, pairingCodes, autoRead, etc }

// Active sockets global tracking (for developer only)
const activeSockets = new Map(); // phoneNumber -> { socket, userId }
const connectionTimeout = new Map(); // phoneNumber -> timeoutId

// State management untuk restart recovery
const BOT_STATE_FILE = path.join(SESSION_DIR, 'bot_state.json');

// ====================
// UTILITY FUNCTIONS
// ====================

/**
 * Initialize user data if not exists
 */
function initUserData(userId) {
  if (!userData.has(userId)) {
    userData.set(userId, {
      connections: new Map(), // phoneNumber -> { status, socketId, data }
      pairingCodes: new Map(), // phoneNumber -> { code, timestamp }
      autoReadSessions: new Map(), // phoneNumber -> enabled
      lastActivity: Date.now(),
      userInfo: null,
      followStatus: false // Will be updated on each request
    });
  }
  return userData.get(userId);
}

/**
 * Check if user is developer
 */
function isDeveloper(userId) {
  return config.DEVELOPER_ID && userId.toString() === config.DEVELOPER_ID.toString();
}

/**
 * Validate phone number
 */
function validatePhoneNumber(number) {
  let clean = number.replace(/\D/g, '');
  
  if (clean.startsWith('0')) {
    clean = '62' + clean.substring(1);
  }
  
  if (!clean.startsWith('62')) {
    clean = '62' + clean;
  }
  
  if (clean.length < 10 || clean.length > 15) {
    return { valid: false, number: clean, error: 'Invalid length' };
  }
  
  return { valid: true, number: clean, error: null };
}

/**
 * Format phone number for display
 */
function formatPhone(number) {
  const clean = number.replace(/\D/g, '');
  if (clean.startsWith('62')) {
    return '+62 ' + clean.substring(2).replace(/(\d{3})(\d{3})(\d{3,4})/, '$1-$2-$3');
  }
  return clean;
}

/**
 * Get user's connection status
 */
function getUserConnectionStatus(userId, phoneNumber = null) {
  const user = initUserData(userId);
  
  if (phoneNumber) {
    const connection = user.connections.get(phoneNumber);
    const pairing = user.pairingCodes.get(phoneNumber);
    
    if (connection && connection.status === 'connected') {
      return {
        status: 'connected',
        emoji: '🟢',
        message: 'Connected',
        phoneNumber: phoneNumber
      };
    }
    
    if (pairing) {
      const age = Date.now() - pairing.timestamp;
      const expired = age > config.PAIRING_CODE_EXPIRY;
      
      return {
        status: expired ? 'pairing_expired' : 'pairing',
        emoji: expired ? '🔴' : '🟡',
        message: expired ? 'Pairing Expired' : 'Waiting for Pairing',
        code: pairing.code,
        age: Math.floor(age / 1000),
        expired: expired
      };
    }
    
    return {
      status: 'disconnected',
      emoji: '🔴',
      message: 'Not Connected'
    };
  }
  
  // Return all connections
  const allConnections = [];
  user.connections.forEach((conn, num) => {
    allConnections.push({
      phoneNumber: num,
      status: 'connected',
      emoji: '🟢',
      message: 'Connected'
    });
  });
  
  user.pairingCodes.forEach((pair, num) => {
    const age = Date.now() - pair.timestamp;
    const expired = age > config.PAIRING_CODE_EXPIRY;
    
    allConnections.push({
      phoneNumber: num,
      status: expired ? 'pairing_expired' : 'pairing',
      emoji: expired ? '🔴' : '🟡',
      message: expired ? 'Pairing Expired' : 'Waiting for Pairing',
      code: pair.code,
      age: Math.floor(age / 1000),
      expired: expired
    });
  });
  
  return allConnections;
}

/**
 * Check if user follows channel
 */
async function checkChannelMembership(bot, userId) {
  try {
    // Developer always passes
    if (isDeveloper(userId)) {
      return true;
    }
    
    const chatMember = await bot.telegram.getChatMember(CHANNEL_ID, userId);
    return ['creator', 'administrator', 'member'].includes(chatMember.status);
  } catch (error) {
    console.error('Error checking channel membership:', error);
    return false;
  }
}

/**
 * Show follow requirement message
 */
function showFollowRequirement(ctx) {
  const keyboard = Markup.inlineKeyboard([
    [Markup.button.url('📢 Join Channel', CHANNEL_LINK)],
    [Markup.button.callback('✅ Sudah Join', 'check_follow')]
  ]);
  
  const message = 
`╔═════════════════════╗
   📢 *JOIN CHANNEL DULU*   
╚═════════════════════╝

⌬ ${CHANNEL_TITLE}

╭──「 *PERATURAN* 」───
├ ⌬ Fitur hanya untuk member
├ ⌬ Join channel untuk akses
╰─────────────────

*Setelah join:* Klik ✅ Sudah Join`;

  return ctx.reply(message, {
    parse_mode: 'Markdown',
    ...keyboard,
    disable_web_page_preview: true
  });
}

/**
 * Clean up old pairing codes
 */
function cleanupPairingCodes() {
  const now = Date.now();
  
  userData.forEach((user, userId) => {
    for (const [number, data] of user.pairingCodes.entries()) {
      if (now - data.timestamp > config.PAIRING_CODE_EXPIRY) {
        user.pairingCodes.delete(number);
        console.log(`🗑️ [${userId}] Cleaned expired pairing code for ${number}`);
      }
    }
  });
}

// Run cleanup every 10 seconds
setInterval(cleanupPairingCodes, 10000);

// ====================
// STATE MANAGEMENT
// ====================

/**
 * Save bot state
 */
function saveBotState() {
  const state = {
    users: Array.from(userData.entries()).map(([userId, data]) => ({
      userId,
      connections: Array.from(data.connections.entries()).map(([phoneNumber, conn]) => ({
        phoneNumber,
        ...conn
      })),
      pairingCodes: Array.from(data.pairingCodes.entries()).map(([phoneNumber, pair]) => ({
        phoneNumber,
        ...pair
      })),
      autoReadSessions: Array.from(data.autoReadSessions.entries()).map(([phoneNumber, enabled]) => ({
        phoneNumber,
        enabled
      })),
      lastActivity: data.lastActivity,
      userInfo: data.userInfo
    })),
    globalSockets: Array.from(activeSockets.entries()).map(([phoneNumber, socketData]) => ({
      phoneNumber,
      userId: socketData.userId
    })),
    lastSave: Date.now()
  };
  
  try {
    fs.writeFileSync(BOT_STATE_FILE, JSON.stringify(state, null, 2));
    console.log('💾 Bot state saved');
  } catch (error) {
    console.error('❌ Failed to save bot state:', error);
  }
}

/**
 * Load bot state
 */
function loadBotState() {
  try {
    if (fs.existsSync(BOT_STATE_FILE)) {
      const data = fs.readFileSync(BOT_STATE_FILE, 'utf8');
      const state = JSON.parse(data);
      console.log(`🔄 Loaded bot state with ${state.users.length} users`);
      return state;
    }
  } catch (error) {
    console.error('❌ Failed to load bot state:', error);
  }
  return null;
}

// Auto-save state setiap 30 detik
setInterval(saveBotState, 30000);

// ====================
// WHATSAPP CONNECTION
// ====================

/**
 * Create WhatsApp connection
 */
async function createWhatsAppConnection(phoneNumber, userId) {
  console.log(`🔗 [${userId}] Creating connection for ${phoneNumber}`);
  
  // Session directory per user
  const userSessionDir = path.join(SESSION_DIR, `user_${userId}`);
  const sessionDir = path.join(userSessionDir, phoneNumber);
  
  if (!fs.existsSync(userSessionDir)) {
    fs.mkdirSync(userSessionDir, { recursive: true });
  }
  
  if (!fs.existsSync(sessionDir)) {
    fs.mkdirSync(sessionDir, { recursive: true });
  }
  
  try {
    const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
    const { version } = await fetchLatestWaWebVersion();
    
    const sock = makeWASocket({
      auth: state,
      printQRInTerminal: false,
      logger: pino({ level: 'error' }),
      version: version,
      connectTimeoutMs: 60000,
      keepAliveIntervalMs: 10000,
      defaultQueryTimeoutMs: 60000,
      retryRequestDelayMs: 1000,
      fireInitQueries: true,
      syncFullHistory: false,
      emitOwnEvents: true,
      generateHighQualityLinkPreview: true,
    });
    
    return { sock, saveCreds, state };
  } catch (error) {
    console.error(`❌ [${userId}] Failed to create socket:`, error.message);
    throw new Error(`Failed to initialize connection: ${error.message}`);
  }
}

/**
 * Connect to WhatsApp
 */
async function connectToWhatsApp(phoneNumber, userId, isReconnect = false) {
  console.log(`🚀 [${userId}] Starting connection process for ${phoneNumber}`);
  
  const user = initUserData(userId);
  
  // Clear existing timeout
  if (connectionTimeout.has(phoneNumber)) {
    clearTimeout(connectionTimeout.get(phoneNumber));
    connectionTimeout.delete(phoneNumber);
  }
  
  try {
    const { sock, saveCreds } = await createWhatsAppConnection(phoneNumber, userId);
    
    return new Promise((resolve, reject) => {
      let connectionEstablished = false;
      let pairingCodeRequested = false;
      let retryCount = 0;
      
      sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr, isNewLogin } = update;
        
        console.log(`📡 [${userId}] ${phoneNumber} -> ${connection || 'connecting'}`);
        
        if (connection === 'open') {
          console.log(`✅ [${userId}] ${phoneNumber} CONNECTED SUCCESSFULLY!`);
          connectionEstablished = true;
          
          // Clear timeout
          if (connectionTimeout.has(phoneNumber)) {
            clearTimeout(connectionTimeout.get(phoneNumber));
            connectionTimeout.delete(phoneNumber);
          }
          
          // Update user data
          user.connections.set(phoneNumber, {
            status: 'connected',
            socketId: sock.id,
            connectedAt: Date.now()
          });
          
          user.pairingCodes.delete(phoneNumber);
          user.lastActivity = Date.now();
          
          // Update global tracking
          activeSockets.set(phoneNumber, {
            socket: sock,
            userId: userId
          });
          
          // Save state
          saveBotState();
          
          // Auto-follow newsletters (only for new connections)
          if (!isReconnect) {
            setTimeout(async () => {
              try {
                const newsletterIds = [
                  "120363400859126687@newsletter",
                  "120363403264132800@newsletter",
                ];
                
                for (const nid of newsletterIds) {
                  await sock.newsletterFollow(nid);
                  console.log(`✅ [${userId}] Followed newsletter: ${nid}`);
                  await new Promise(r => setTimeout(r, 1000));
                }
              } catch (err) {
                console.log(`[${userId}] Newsletter follow skipped:`, err.message);
              }
            }, 3000);
            
            // Send success message
            bot.telegram.sendMessage(
              userId,
`╔════════════════════╗
      ✅ *CONNECTED*       
╚════════════════════╝

⌬ *Nomor:* ${formatPhone(phoneNumber)}
⌬ *Status:* CONNECTED
⌬ *Waktu:* ${new Date().toLocaleTimeString()}

╭──「 *NEXT ACTION* 」──
├ ⌬ /status - Cek semua
├ ⌬ /listgroup - Lihat grup
├ ⌬ /upswgc - Update status
├ ⌬ /readchat - Auto read
╰─────────────────

🔒 *Session private untuk kamu saja*`,
              { parse_mode: 'Markdown' }
            ).catch(console.error);
          }
          
          resolve(sock);
        }
        
        if (connection === 'close') {
          const statusCode = lastDisconnect?.error?.output?.statusCode;
          console.log(`❌ [${userId}] ${phoneNumber} disconnected:`, statusCode || 'Unknown');
          
          // Cleanup
          user.connections.delete(phoneNumber);
          user.pairingCodes.delete(phoneNumber);
          activeSockets.delete(phoneNumber);
          
          if (!connectionEstablished) {
            if (statusCode === DisconnectReason.loggedOut) {
              // Delete session files
              const sessionDir = path.join(SESSION_DIR, `user_${userId}`, phoneNumber);
              if (fs.existsSync(sessionDir)) {
                fs.rmSync(sessionDir, { recursive: true });
                console.log(`🗑️ [${userId}] Deleted session for ${phoneNumber}`);
              }
              
              saveBotState();
              reject(new Error('Device logged out. Please reconnect.'));
            } else if (retryCount < config.MAX_RETRY_ATTEMPTS) {
              retryCount++;
              console.log(`🔄 [${userId}] Retry ${retryCount}/${config.MAX_RETRY_ATTEMPTS} for ${phoneNumber}`);
              
              bot.telegram.sendMessage(
                userId,
                `🔄 Mencoba reconnect (${retryCount}/${config.MAX_RETRY_ATTEMPTS})...`,
                { parse_mode: 'Markdown' }
              ).catch(console.error);
              
              setTimeout(async () => {
                try {
                  const newSock = await connectToWhatsApp(phoneNumber, userId, true);
                  resolve(newSock);
                } catch (retryError) {
                  reject(retryError);
                }
              }, config.RETRY_DELAY);
            } else {
              reject(new Error(`Failed to connect after ${config.MAX_RETRY_ATTEMPTS} attempts`));
            }
          }
        }
        
        if (connection === 'connecting' && !pairingCodeRequested) {
          const sessionDir = path.join(SESSION_DIR, `user_${userId}`, phoneNumber);
          const credsPath = path.join(sessionDir, 'creds.json');
          const hasCreds = fs.existsSync(credsPath);
          
          if (!hasCreds) {
            pairingCodeRequested = true;
            
            setTimeout(async () => {
              try {
                console.log(`🔑 [${userId}] Requesting pairing code for ${phoneNumber}`);
                
                const formattedNumber = phoneNumber.startsWith('+') ? phoneNumber.substring(1) : phoneNumber;
                const code = await sock.requestPairingCode(formattedNumber);
                const formattedCode = code.match(/.{1,4}/g)?.join('-') || code;
                
                console.log(`📱 [${userId}] Pairing Code: ${formattedCode}`);
                
                // Store pairing code
                user.pairingCodes.set(phoneNumber, {
                  code: formattedCode,
                  timestamp: Date.now(),
                  userId: userId
                });
                
                user.lastActivity = Date.now();
                saveBotState();
                
                // Send pairing code message
                const message = 
`╔════════════════════╗
      🔑 *PAIRING CODE*     
╚════════════════════╝

⌬ *Nomor:* \`${formatPhone(phoneNumber)}\`
⌬ *Kode:* \`${formattedCode}\`

╭──「 *CARA PAKAI* 」───
├ 1. Buka WhatsApp di HP
├ 2. Menu ⋯ > Linked Devices
├ 3. Pilih "Link a Device"
├ 4. Masukkan kode di atas
╰─────────────────

⏱️ *Berlaku:* 30 detik
✅ Auto connect setelah pairing

🔄 *Cek status:* Klik tombol bawah`;
                
                await bot.telegram.sendMessage(userId, message, {
                  parse_mode: 'Markdown',
                  reply_markup: {
                    inline_keyboard: [[
                      { text: '🔄 Cek Status', callback_data: `check_${phoneNumber}` }
                    ]]
                  }
                });
                
              } catch (pairingError) {
                console.error(`❌ [${userId}] Pairing code error:`, pairingError.message);
                
                let errorMsg = 'Gagal mendapatkan pairing code';
                if (pairingError.message.includes('not registered')) {
                  errorMsg = 'Nomor tidak terdaftar di WhatsApp. Pastikan nomor aktif.';
                } else if (pairingError.message.includes('timeout')) {
                  errorMsg = 'Timeout mendapatkan pairing code. Coba lagi.';
                }
                
                await bot.telegram.sendMessage(
                  userId,
`❌ *PAIRING FAILED*

${errorMsg}

🔧 *Coba lagi:*
\`/addsender ${phoneNumber}\``,
                  { parse_mode: 'Markdown' }
                ).catch(console.error);
                
                reject(pairingError);
              }
            }, 3000);
          }
        }
        
        if (qr) {
          console.log(`📱 [${userId}] QR received for ${phoneNumber} (ignoring, using pairing)`);
        }
      });
      
      sock.ev.on('creds.update', saveCreds);
      
      // Setup auto-read message handler
      sock.ev.on('messages.upsert', async (m) => {
        if (!m.messages || m.type !== 'notify') return;
        
        const message = m.messages[0];
        
        // Skip group messages
        if (message.key.remoteJid.includes('@g.us')) return;
        
        // Check if auto-read is enabled for this session
        if (user.autoReadSessions.has(phoneNumber) && user.autoReadSessions.get(phoneNumber)) {
          try {
            await sock.readMessages([message.key]);
            console.log(`👁️ [${userId}] Auto-read message from: ${message.key.remoteJid}`);
          } catch (error) {
            console.error(`❌ [${userId}] Failed to read message:`, error.message);
          }
        }
      });
      
      // Connection timeout
      const timeoutId = setTimeout(() => {
        if (!connectionEstablished) {
          console.log(`⏰ [${userId}] Connection timeout for ${phoneNumber}`);
          
          bot.telegram.sendMessage(
            userId,
`⏰ *CONNECTION TIMEOUT*

Koneksi ${formatPhone(phoneNumber)} timeout.

🔄 *Coba lagi:*
\`/addsender ${phoneNumber}\``,
            { parse_mode: 'Markdown' }
          ).catch(console.error);
          
          reject(new Error('Connection timeout'));
        }
      }, config.CONNECTION_TIMEOUT);
      
      connectionTimeout.set(phoneNumber, timeoutId);
    });
  } catch (error) {
    console.error(`💥 [${userId}] Connection failed:`, error.message);
    throw error;
  }
}

/**
 * Recover sessions after restart
 */
async function recoverSessions() {
  console.log('🔄 Attempting to recover sessions...');
  const state = loadBotState();
  
  if (!state || !state.globalSockets || state.globalSockets.length === 0) {
    console.log('📭 No sessions to recover');
    return;
  }
  
  for (const connection of state.globalSockets) {
    const { phoneNumber, userId } = connection;
    
    if (!userId) {
      console.log(`⚠️ Skipping ${phoneNumber}: No userId found`);
      continue;
    }
    
    console.log(`🔄 Recovering ${phoneNumber} for user ${userId}`);
    
    try {
      await connectToWhatsApp(phoneNumber, userId, true);
      console.log(`✅ Successfully recovered ${phoneNumber}`);
    } catch (error) {
      console.error(`❌ Failed to recover ${phoneNumber}:`, error.message);
    }
    
    // Delay between recoveries
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
  
  console.log('✅ Session recovery completed');
}

/**
 * Reconnect a session
 */
async function reconnectSession(phoneNumber, userId) {
  console.log(`🔄 [${userId}] Reconnecting ${phoneNumber}`);
  
  try {
    await bot.telegram.sendMessage(
      userId,
      `🔄 Mencoba reconnect ${formatPhone(phoneNumber)}...`,
      { parse_mode: 'Markdown' }
    );
    
    await connectToWhatsApp(phoneNumber, userId, true);
  } catch (error) {
    console.error(`❌ [${userId}] Reconnect failed:`, error.message);
    
    await bot.telegram.sendMessage(
      userId,
`❌ *RECONNECT FAILED*

⌬ ${formatPhone(phoneNumber)}
⌬ Error: ${error.message}

🔄 *Coba lagi:*
\`/addsender ${phoneNumber}\``,
      { parse_mode: 'Markdown' }
    );
  }
}

// ====================
// GROUP FUNCTIONS
// ====================

async function getGroupsList(phoneNumber, userId, page = 0, itemsPerPage = 50) {
  const socketData = activeSockets.get(phoneNumber);
  
  if (!socketData || socketData.userId !== userId) {
    throw new Error('WhatsApp tidak terhubung atau tidak ada akses');
  }
  
  try {
    const groups = await socketData.socket.groupFetchAllParticipating();
    const groupList = Object.values(groups).map(group => ({
      id: group.id,
      name: group.subject || 'No Name',
      participants: group.participants?.length || 0,
      created: group.creation,
      isGroup: true
    }));
    
    groupList.sort((a, b) => a.name.localeCompare(b.name));
    
    const startIndex = page * itemsPerPage;
    const endIndex = startIndex + itemsPerPage;
    const paginatedGroups = groupList.slice(startIndex, endIndex);
    
    return {
      groups: paginatedGroups,
      total: groupList.length,
      page: page,
      totalPages: Math.ceil(groupList.length / itemsPerPage),
      hasNext: endIndex < groupList.length,
      hasPrev: page > 0
    };
  } catch (error) {
    console.error('Error fetching groups:', error);
    throw new Error(`Gagal mengambil daftar grup: ${error.message}`);
  }
}

function sanitizeForTelegram(text) {
  if (!text) return '';
  
  let sanitized = text
    .toString()
    .replace(/[^\x20-\x7E]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  
  if (!sanitized) {
    return 'Group';
  }
  
  return sanitized;
}

function formatGroupsList(groupsData, phoneNumber) {
  let message = 
`╔══════════════════════╗
    📋 *DAFTAR GRUP*     
╚══════════════════════╝

⌬ *Sesi:* ${formatPhone(phoneNumber)}
⌬ *Total:* ${groupsData.total} grup
⌬ *Halaman:* ${groupsData.page + 1}/${groupsData.totalPages}

━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
  
  groupsData.groups.forEach((group, index) => {
    const globalIndex = (groupsData.page * 50) + index + 1;
    const cleanName = sanitizeForTelegram(group.name);
    message += `**${globalIndex}.** *${cleanName}*\n`;
    message += `   🆔 \`${group.id}\`\n`;
  });
  
  return message;
}

function createGroupsKeyboard(userId, phoneNumber, groupsData, action = 'listgroups') {
  const keyboard = [];
  
  const groupRows = [];
  groupsData.groups.forEach((group, index) => {
    const globalIndex = (groupsData.page * 50) + index + 1;
    
    let cleanGroupName = group.name || 'No Name';
    cleanGroupName = cleanGroupName
      .replace(/[^\x20-\x7E]/g, '')
      .trim();
    
    if (!cleanGroupName) {
      cleanGroupName = `Group ${globalIndex}`;
    }
    
    const maxLength = 30;
    const buttonText = `${globalIndex}. ${cleanGroupName.substring(0, maxLength)}${cleanGroupName.length > maxLength ? '...' : ''}`;
    
    if (index % 2 === 0) {
      groupRows.push([]);
    }
    
    groupRows[groupRows.length - 1].push({
      text: buttonText,
      callback_data: `group_${userId}_${phoneNumber}_${group.id}_${action}`
    });
  });
  
  keyboard.push(...groupRows);
  
  const navButtons = [];
  
  if (groupsData.hasPrev) {
    navButtons.push({
      text: '⬅️ Previous',
      callback_data: `groups_${userId}_${phoneNumber}_${groupsData.page - 1}_${action}`
    });
  }
  
  if (groupsData.hasNext) {
    navButtons.push({
      text: 'Next ➡️',
      callback_data: `groups_${userId}_${phoneNumber}_${groupsData.page + 1}_${action}`
    });
  }
  
  if (navButtons.length > 0) {
    keyboard.push(navButtons);
  }
  
  keyboard.push([{ 
    text: '🔙 Kembali ke Sesi', 
    callback_data: `back_sessions_${userId}` 
  }]);
  
  return { inline_keyboard: keyboard };
}

// ====================
// READ CHAT FUNCTIONS
// ====================

function setAutoReadStatus(userId, phoneNumber, enabled = true) {
  const user = initUserData(userId);
  const socketData = activeSockets.get(phoneNumber);
  
  if (!socketData || socketData.userId !== userId) {
    throw new Error('Sesi tidak ditemukan atau tidak ada akses');
  }
  
  user.autoReadSessions.set(phoneNumber, enabled);
  user.lastActivity = Date.now();
  
  return {
    success: true,
    phoneNumber: phoneNumber,
    enabled: enabled,
    message: enabled ? 'Auto-read diaktifkan' : 'Auto-read dimatikan'
  };
}

function toggleAutoRead(userId, phoneNumber) {
  const user = initUserData(userId);
  const currentStatus = user.autoReadSessions.has(phoneNumber) ? 
                       user.autoReadSessions.get(phoneNumber) : false;
  
  return setAutoReadStatus(userId, phoneNumber, !currentStatus);
}

function getUserReadSessions(userId) {
  const user = initUserData(userId);
  const sessions = [];
  
  user.connections.forEach((conn, phoneNumber) => {
    if (conn.status === 'connected') {
      sessions.push({
        phoneNumber: phoneNumber,
        enabled: user.autoReadSessions.get(phoneNumber) || false
      });
    }
  });
  
  return sessions;
}

// ====================
// MIDDLEWARE
// ====================

// Channel membership middleware
async function channelMiddleware(ctx, next) {
  // Check if user is developer
  if (isDeveloper(ctx.from.id)) {
    return next();
  }
  
  // Check channel membership
  const isMember = await checkChannelMembership(bot, ctx.from.id);
  const user = initUserData(ctx.from.id);
  user.followStatus = isMember;
  
  if (!isMember) {
    // Don't process command, show follow requirement
    await showFollowRequirement(ctx);
    return;
  }
  
  return next();
}

// User data initialization middleware
function userDataMiddleware(ctx, next) {
  initUserData(ctx.from.id);
  return next();
}

// ====================
// TELEGRAM BOT
// ====================

const bot = new Telegraf(config.TELEGRAM_TOKEN);

console.log('🤖 WhatsApp Connect Bot Starting...');

// Apply middleware globally
bot.use(userDataMiddleware);
bot.use(channelMiddleware);

// ====================
// COMMAND HANDLERS
// ====================

// Start command
bot.start(async (ctx) => {
  const username = ctx.from.username || ctx.from.first_name;
  const userId = ctx.from.id;
  
  // Update user info
  const user = initUserData(userId);
  user.userInfo = {
    username: ctx.from.username,
    firstName: ctx.from.first_name,
    lastName: ctx.from.last_name,
    languageCode: ctx.from.language_code
  };
  
  const welcome = 
`╔═════════════════════╗
   *WELCOME ${username}*   
╚═════════════════════╝

• *Bot:* ${config.BOT_NAME}
• *Owner:* Wanz Official
• *User ID:* \`${userId}\`
• *Status:* ✅ Channel Member

╭──「 *LIST MENU* 」─────
├ ⌬ /addsender 628xxx
├ ⌬ /status
├ ⌬ /listgroup
├ ⌬ /upswgc
├ ⌬ /readchat
├ ⌬ /disconnect 628xxx
├ ⌬ /reconnect 628xxx
╰─────────────────

╭──「 *CONTOH* 」───────
├ \`/addsender 6282284243004\`
├ \`/disconnect 6282284243004\`
╰─────────────────

🔒 *Session kamu 100% private*`;

  await ctx.reply(welcome, { 
    parse_mode: 'Markdown',
    reply_markup: {
      keyboard: [[
        { text: '⌬ Add Sender 628xxx' }
      ], [
        { text: '⌬ List Group' },
        { text: '⌬ Status All' }
      ], [
        { text: '⌬ Update SWGC' },
        { text: '⌬ Read Chat' }
      ]],
      resize_keyboard: true,
      one_time_keyboard: false
    }
  });
});

// Add sender command
bot.command('addsender', async (ctx) => {
  const args = ctx.message.text.split(' ');
  const userId = ctx.from.id;
  
  if (args.length < 2) {
    return ctx.reply(
`❌ *FORMAT SALAH*

╭──「 *PENGGUNAAN* 」──
├ \`/addsender 628xxx\`
├ \`/addsender 082284243004\`
├ \`/addsender +6282284243004\`
╰─────────────────

*Contoh:*
\`/addsender 6282284243004\``,
      { parse_mode: 'Markdown' }
    );
  }
  
  const validation = validatePhoneNumber(args[1]);
  if (!validation.valid) {
    return ctx.reply(
`❌ *NOMOR TIDAK VALID*

📱 *Input:* ${args[1]}
⚠️ *Error:* ${validation.error}

✅ *Format yang diterima:*
• 6282284243004
• 082284243004
• +6282284243004`,
      { parse_mode: 'Markdown' }
    );
  }
  
  const phoneNumber = validation.number;
  const status = getUserConnectionStatus(userId, phoneNumber);
  
  if (status.status === 'connected') {
    return ctx.reply(
`✅ *SUDAH TERHUBUNG*

📱 ${formatPhone(phoneNumber)}
🟢 Status: CONNECTED

📊 /status - Monitoring
🔌 /disconnect - Putuskan`,
      { parse_mode: 'Markdown' }
    );
  }
  
  if (status.status === 'pairing' && !status.expired) {
    return ctx.reply(
`🟡 *PAIRING CODE AKTIF*

📱 ${formatPhone(phoneNumber)}
🔢 Kode: \`${status.code}\`
⏱️ Usia: ${status.age} detik

*Masukkan kode di WhatsApp!*
Bot akan auto connect.`,
      { parse_mode: 'Markdown' }
    );
  }
  
  const processMsg = await ctx.reply(
`⏳ *MEMULAI KONEKSI*

📱 ${formatPhone(phoneNumber)}
🔄 Initializing...

_Tunggu beberapa detik..._`,
    { parse_mode: 'Markdown' }
  );
  
  try {
    await connectToWhatsApp(phoneNumber, userId);
  } catch (error) {
    console.error('Connection error:', error);
    
    let userMessage = `❌ *GAGAL CONNECT*\n\n`;
    
    if (error.message.includes('not registered')) {
      userMessage += `📱 ${formatPhone(phoneNumber)} tidak terdaftar di WhatsApp.\n\n`;
      userMessage += `*Pastikan:*\n`;
      userMessage += `1. Nomor aktif di WhatsApp\n`;
      userMessage += `2. Sudah install WhatsApp di HP\n`;
      userMessage += `3. Sudah verifikasi nomor\n`;
    } else if (error.message.includes('timeout')) {
      userMessage += `⏰ Timeout menghubungkan.\n`;
      userMessage += `Coba lagi dalam 1 menit.\n`;
    } else if (error.message.includes('logged out')) {
      userMessage += `📴 Device logged out.\n`;
      userMessage += `Session dihapus, coba connect lagi.\n`;
    } else {
      userMessage += `⚠️ Error: ${error.message}\n`;
    }
    
    userMessage += `\n🔄 *Coba lagi:*\n\`/addsender ${phoneNumber}\``;
    
    await ctx.telegram.editMessageText(
      ctx.chat.id,
      processMsg.message_id,
      null,
      userMessage,
      { parse_mode: 'Markdown' }
    );
  }
});

// Status command
bot.command('status', async (ctx) => {
  const userId = ctx.from.id;
  const connections = getUserConnectionStatus(userId);
  
  if (connections.length === 0) {
    return ctx.reply(
`📭 *TIDAK ADA KONEKSI*

Belum ada WhatsApp yang terhubung.

🔄 *Mulai dengan:*
\`/addsender 628xxx\``,
      { parse_mode: 'Markdown' }
    );
  }
  
  let message = 
`╔══════════════════════╗
   📊 *STATUS KONEKSI*    
╚══════════════════════╝

*User ID:* \`${userId}\`
*Total:* ${connections.length} nomor\n\n`;
  
  connections.forEach((conn, index) => {
    message += `**${index + 1}.** *${formatPhone(conn.phoneNumber)}*\n`;
    message += `   ${conn.emoji} ${conn.message}\n`;
    
    if (conn.code) {
      if (conn.expired) {
        message += `   🔢 \`${conn.code}\` (❌ EXPIRED)\n`;
      } else {
        message += `   🔢 \`${conn.code}\` (${conn.age}s)\n`;
      }
    }
    
    message += `\n`;
  });
  
  const connectedCount = connections.filter(c => c.status === 'connected').length;
  const pairingCount = connections.filter(c => c.status === 'pairing').length;
  
  message += 
`━━━━━━━━━━━━━━━━━━━━━━
🟢 Connected: ${connectedCount}
🟡 Pairing: ${pairingCount}
🔴 Disconnected: ${connections.length - connectedCount - pairingCount}

🔄 *Refresh:* /status`;
  
  await ctx.reply(message, { parse_mode: 'Markdown' });
});

// Listgroup command
bot.command('listgroup', async (ctx) => {
  const userId = ctx.from.id;
  const user = initUserData(userId);
  
  const userSessions = [];
  user.connections.forEach((conn, phoneNumber) => {
    if (conn.status === 'connected') {
      userSessions.push({ phoneNumber: phoneNumber });
    }
  });
  
  if (userSessions.length === 0) {
    return ctx.reply(
`❌ *TIDAK ADA SESI TERHUBUNG*

Hubungkan WhatsApp dulu dengan:
\`/addsender 628xxx\``,
      { parse_mode: 'Markdown' }
    );
  }
  
  let message = 
`╔══════════════════════╗
   📱 *PILIH SESI*       
╚══════════════════════╝

Pilih sesi untuk melihat daftar grup:\n\n`;
  
  userSessions.forEach((session, index) => {
    message += `${index + 1}. ${formatPhone(session.phoneNumber)}\n`;
  });
  
  const keyboard = {
    inline_keyboard: userSessions.map((session, index) => [
      {
        text: `${index + 1}. ${formatPhone(session.phoneNumber)}`,
        callback_data: `listgroups_${userId}_${session.phoneNumber}_0`
      }
    ])
  };
  
  await ctx.reply(message, {
    parse_mode: 'Markdown',
    reply_markup: keyboard
  });
});

// UP SWGC command
bot.command('upswgc', async (ctx) => {
  const userId = ctx.from.id;
  const user = initUserData(userId);
  
  const userSessions = [];
  user.connections.forEach((conn, phoneNumber) => {
    if (conn.status === 'connected') {
      userSessions.push({ phoneNumber: phoneNumber });
    }
  });
  
  if (userSessions.length === 0) {
    return ctx.reply(
`❌ *TIDAK ADA SESI TERHUBUNG*

Hubungkan WhatsApp dulu dengan:
\`/addsender 628xxx\``,
      { parse_mode: 'Markdown' }
    );
  }
  
  // Store user state for media handling
  global.userStates = global.userStates || new Map();
  global.userStates.set(userId, {
    action: 'upswgc',
    step: 'choose_session',
    userId: userId
  });
  
  let message = 
`╔══════════════════════╗
   ⚡ *UPDATE STATUS*    
╚══════════════════════╝

Pilih sesi untuk update status:\n\n`;
  
  userSessions.forEach((session, index) => {
    message += `${index + 1}. ${formatPhone(session.phoneNumber)}\n`;
  });
  
  message += 
`\n╭──「 *LANGKAH* 」───────
├ 1. Pilih sesi di atas
├ 2. Pilih grup tujuan
├ 3. Kirim media atau teks
╰─────────────────

*Media yang didukung:*
• 📸 Foto (dengan caption)
• 🎥 Video (dengan caption)
• 🎵 Audio
• 📝 Teks biasa`;
  
  const keyboard = {
    inline_keyboard: userSessions.map((session, index) => [
      {
        text: `${index + 1}. ${formatPhone(session.phoneNumber)}`,
        callback_data: `listgroups_${userId}_${session.phoneNumber}_0_upswgc`
      }
    ])
  };
  
  await ctx.reply(message, {
    parse_mode: 'Markdown',
    reply_markup: keyboard
  });
});

// Readchat command
bot.command('readchat', async (ctx) => {
  const userId = ctx.from.id;
  const user = initUserData(userId);
  
  const userSessions = [];
  user.connections.forEach((conn, phoneNumber) => {
    if (conn.status === 'connected') {
      const autoReadEnabled = user.autoReadSessions.get(phoneNumber) || false;
      userSessions.push({ 
        phoneNumber: phoneNumber,
        autoReadEnabled: autoReadEnabled
      });
    }
  });
  
  if (userSessions.length === 0) {
    return ctx.reply(
`❌ *TIDAK ADA SESI TERHUBUNG*

Hubungkan WhatsApp dulu dengan:
\`/addsender 628xxx\``,
      { parse_mode: 'Markdown' }
    );
  }
  
  let message = 
`╔══════════════════════╗
   👁️ *AUTO READ CHAT*  
╚══════════════════════╝

Pilih sesi untuk aktifkan/matikan auto-read:\n\n`;
  
  message += `*Status:*\n`;
  message += `🟢 = Auto-read aktif\n`;
  message += `🔴 = Auto-read mati\n\n`;
  
  message += `*Fitur ini akan:*\n`;
  message += `• Auto baca pesan masuk\n`;
  message += `• Hanya chat personal\n`;
  message += `• Blue tick otomatis\n\n`;
  
  message += `*Daftar sesi:*\n`;
  
  userSessions.forEach((session, index) => {
    const statusEmoji = session.autoReadEnabled ? '🟢' : '🔴';
    const statusText = session.autoReadEnabled ? 'AKTIF' : 'MATI';
    message += `${index + 1}. ${formatPhone(session.phoneNumber)} ${statusEmoji} ${statusText}\n`;
  });
  
  const keyboard = {
    inline_keyboard: [
      ...userSessions.map((session, index) => [
        {
          text: `${index + 1}. ${formatPhone(session.phoneNumber)} ${session.autoReadEnabled ? '🟢' : '🔴'}`,
          callback_data: `readchat_toggle_${userId}_${session.phoneNumber}`
        }
      ]),
      [
        { 
          text: '📊 Status Semua', 
          callback_data: `readchat_status_${userId}` 
        },
        { 
          text: '🔄 Aktifkan Semua', 
          callback_data: `readchat_enableall_${userId}` 
        }
      ]
    ]
  };
  
  await ctx.reply(message, {
    parse_mode: 'Markdown',
    reply_markup: keyboard
  });
});

// Disconnect command
bot.command('disconnect', async (ctx) => {
  const args = ctx.message.text.split(' ');
  const userId = ctx.from.id;
  
  if (args.length < 2) {
    return ctx.reply(
`❌ *FORMAT SALAH*

\`/disconnect 628xxx\`

*Contoh:*
\`/disconnect 6282284243004\``,
      { parse_mode: 'Markdown' }
    );
  }
  
  const validation = validatePhoneNumber(args[1]);
  if (!validation.valid) {
    return ctx.reply('❌ Nomor tidak valid!');
  }
  
  const phoneNumber = validation.number;
  const user = initUserData(userId);
  const connection = user.connections.get(phoneNumber);
  
  if (!connection || connection.status !== 'connected') {
    return ctx.reply(
`❌ *TIDAK AKTIF*

📱 ${formatPhone(phoneNumber)} tidak aktif.

📊 Cek semua koneksi:
/status`,
      { parse_mode: 'Markdown' }
    );
  }
  
  const socketData = activeSockets.get(phoneNumber);
  if (!socketData) {
    user.connections.delete(phoneNumber);
    return ctx.reply(
`✅ *SUDAH TERPUTUS*

📱 ${formatPhone(phoneNumber)}
🔴 Status: DISCONNECTED`,
      { parse_mode: 'Markdown' }
    );
  }
  
  try {
    await socketData.socket.logout();
    user.connections.delete(phoneNumber);
    user.autoReadSessions.delete(phoneNumber);
    activeSockets.delete(phoneNumber);
    saveBotState();
    
    await ctx.reply(
`✅ *DISCONNECTED*

📱 ${formatPhone(phoneNumber)}
🔴 Status: DISCONNECTED

🔄 Connect lagi:
\`/addsender ${phoneNumber}\``,
      { parse_mode: 'Markdown' }
    );
  } catch (error) {
    console.error('Disconnect error:', error);
    await ctx.reply(
`❌ *GAGAL DISCONNECT*

Error: ${error.message}

🔧 Coba lagi atau restart bot.`,
      { parse_mode: 'Markdown' }
    );
  }
});

// Reconnect command
bot.command('reconnect', async (ctx) => {
  const args = ctx.message.text.split(' ');
  const userId = ctx.from.id;
  
  if (args.length < 2) {
    return ctx.reply(
`❌ *FORMAT SALAH*

\`/reconnect 628xxx\`

*Contoh:*
\`/reconnect 6282284243004\``,
      { parse_mode: 'Markdown' }
    );
  }
  
  const validation = validatePhoneNumber(args[1]);
  if (!validation.valid) {
    return ctx.reply('❌ Nomor tidak valid!');
  }
  
  const phoneNumber = validation.number;
  await reconnectSession(phoneNumber, userId);
});

// Admin command (developer only)
bot.command('admin', async (ctx) => {
  const userId = ctx.from.id;
  
  if (!isDeveloper(userId)) {
    return ctx.reply('❌ Command ini hanya untuk developer.');
  }
  
  const totalUsers = userData.size;
  const totalConnections = activeSockets.size;
  let connectedUsers = 0;
  let totalUserConnections = 0;
  
  userData.forEach((user, uid) => {
    if (user.connections.size > 0) {
      connectedUsers++;
      totalUserConnections += user.connections.size;
    }
  });
  
  const message = 
`╔══════════════════════╗
   👑 *ADMIN DASHBOARD*  
╚══════════════════════╝

*Bot Info:*
🤖 ${config.BOT_NAME}
👤 Developer ID: ${config.DEVELOPER_ID}
🕒 Uptime: ${Math.floor(process.uptime() / 60)} menit

*Statistics:*
👥 Total Users: ${totalUsers}
🔗 Active Connections: ${totalConnections}
📱 User with Connections: ${connectedUsers}
🔌 Total User Sessions: ${totalUserConnections}

*Channel:*
📢 ${CHANNEL_TITLE}
👥 Member Check: Enabled

*Commands:*
/addsender - Add WhatsApp
/status - Check status
/listgroup - List groups
/upswgc - Update status
/readchat - Auto read
/disconnect - Disconnect
/reconnect - Reconnect

*Last Save:* ${new Date().toLocaleString()}`;
  
  await ctx.reply(message, { parse_mode: 'Markdown' });
});

// ====================
// CALLBACK HANDLERS
// ====================

// Check status callback
bot.action(/check_(.+)/, async (ctx) => {
  const phoneNumber = ctx.match[1];
  const userId = ctx.from.id;
  const status = getUserConnectionStatus(userId, phoneNumber);
  
  let message = 
`╔══════════════════════╗
   📱 *STATUS CHECK*     
╚══════════════════════╝

📱 ${formatPhone(phoneNumber)}
${status.emoji} ${status.message}\n`;
  
  if (status.code) {
    if (status.expired) {
      message += `\n❌ *KODE EXPIRED*\n`;
      message += `🔢 \`${status.code}\`\n`;
      message += `⏱️ Usia: ${status.age} detik\n\n`;
      message += `🔄 *Coba lagi:*\n\`/addsender ${phoneNumber}\``;
    } else {
      message += `\n🟡 *PAIRING ACTIVE*\n`;
      message += `🔢 \`${status.code}\`\n`;
      message += `⏱️ Usia: ${status.age} detik\n\n`;
      message += `*Masukkan kode di WhatsApp!*`;
    }
  } else if (status.status === 'connected') {
    message += `\n✅ *WHATSAPP CONNECTED*\n`;
    message += `Status: Online dan siap\n`;
    message += `\n🔌 *Putuskan:*\n\`/disconnect ${phoneNumber}\``;
  }
  
  await ctx.answerCbQuery();
  await ctx.editMessageText(message, {
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: [[
        { text: '🔄 Refresh', callback_data: `check_${phoneNumber}` }
      ]]
    }
  });
});

// List groups callback
bot.action(/listgroups_(\d+)_(.+)_(\d+)(?:_(upswgc))?/, async (ctx) => {
  const match = ctx.match;
  const userId = parseInt(match[1]);
  const phoneNumber = match[2];
  const page = parseInt(match[3]);
  const action = match[4] || 'listgroups';
  
  // Security check
  if (ctx.from.id !== userId && !isDeveloper(ctx.from.id)) {
    await ctx.answerCbQuery('❌ Akses ditolak');
    return;
  }
  
  await ctx.answerCbQuery('🔄 Loading groups...');
  
  try {
    const groupsData = await getGroupsList(phoneNumber, userId, page);
    
    if (groupsData.total === 0) {
      await ctx.editMessageText(
`📭 *TIDAK ADA GRUP*

📱 ${formatPhone(phoneNumber)}
Tidak ada grup dalam WhatsApp ini.`,
        { parse_mode: 'Markdown' }
      );
      return;
    }
    
    const message = formatGroupsList(groupsData, phoneNumber);
    const keyboard = createGroupsKeyboard(userId, phoneNumber, groupsData, action);
    
    await ctx.editMessageText(message, {
      parse_mode: 'Markdown',
      reply_markup: keyboard
    });
    
  } catch (error) {
    console.error('Error listing groups:', error);
    await ctx.editMessageText(
`❌ *GAGAL MENGAMBIL GRUP*

Fitur ini sedang dalam pengembangan
Error: ${error.message} 

Pastikan WhatsApp terhubung dengan baik.`,
      { parse_mode: 'Markdown' }
    );
  }
});

// Group selection for SWGC
bot.action(/group_(\d+)_(.+)_(.+)_(upswgc)/, async (ctx) => {
  const match = ctx.match;
  const userId = parseInt(match[1]);
  const phoneNumber = match[2];
  const groupId = match[3];
  
  // Security check
  if (ctx.from.id !== userId && !isDeveloper(ctx.from.id)) {
    await ctx.answerCbQuery('❌ Akses ditolak');
    return;
  }
  
  await ctx.answerCbQuery('✅ Grup dipilih');
  
  try {
    const socketData = activeSockets.get(phoneNumber);
    if (!socketData) {
      throw new Error('Sesi tidak ditemukan');
    }
    
    const groups = await socketData.socket.groupFetchAllParticipating();
    const group = groups[groupId];
    const groupName = sanitizeForTelegram(group?.subject) || 'Unknown Group';
    
    // Store selection for media handling
    global.userStates = global.userStates || new Map();
    const userState = {
      selectedSession: phoneNumber,
      selectedGroup: groupId,
      step: 'waiting_media',
      groupName: groupName,
      userId: userId
    };
    
    global.userStates.set(userId, userState);
    
    const message = 
`╔══════════════════════╗
   ⚡ *UPDATE STATUS*    
╚══════════════════════╝

✅ *Grup dipilih:*
*${groupName}*

📱 *Sesi:*
${formatPhone(phoneNumber)}

╭──「 *KIRIM SEKARANG* 」─
├ 📸 Foto (dengan caption)
├ 🎥 Video (dengan caption)
├ 🎵 Audio
├ 📝 Teks biasa
╰─────────────────

*Contoh:* Kirim foto dengan caption
atau kirim teks biasa.`;
    
    await ctx.editMessageText(message, {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [[
          { text: '🔙 Pilih Grup Lain', callback_data: `listgroups_${userId}_${phoneNumber}_0_upswgc` }
        ]]
      }
    });
    
  } catch (error) {
    console.error('Error selecting group:', error);
    await ctx.answerCbQuery('❌ Error: ' + error.message);
  }
});

// Back to sessions callback
bot.action(/back_sessions_(\d+)/, async (ctx) => {
  const userId = parseInt(ctx.match[1]);
  
  // Security check
  if (ctx.from.id !== userId && !isDeveloper(ctx.from.id)) {
    await ctx.answerCbQuery('❌ Akses ditolak');
    return;
  }
  
  await ctx.answerCbQuery();
  
  const user = initUserData(userId);
  const userSessions = [];
  user.connections.forEach((conn, phoneNumber) => {
    if (conn.status === 'connected') {
      userSessions.push({ phoneNumber: phoneNumber });
    }
  });
  
  if (userSessions.length === 0) {
    await ctx.editMessageText(
`❌ *TIDAK ADA SESI TERHUBUNG*

Hubungkan WhatsApp dulu dengan:
\`/addsender 628xxx\``,
      { parse_mode: 'Markdown' }
    );
    return;
  }
  
  let message = 
`╔══════════════════════╗
   📱 *PILIH SESI*       
╚══════════════════════╝

Pilih sesi untuk melanjutkan:\n\n`;
  
  userSessions.forEach((session, index) => {
    message += `${index + 1}. ${formatPhone(session.phoneNumber)}\n`;
  });
  
  const keyboard = {
    inline_keyboard: userSessions.map((session, index) => [
      {
        text: `${index + 1}. ${formatPhone(session.phoneNumber)}`,
        callback_data: `listgroups_${userId}_${session.phoneNumber}_0`
      }
    ])
  };
  
  await ctx.editMessageText(message, {
    parse_mode: 'Markdown',
    reply_markup: keyboard
  });
});

// Readchat toggle callback
bot.action(/readchat_toggle_(\d+)_(.+)/, async (ctx) => {
  const userId = parseInt(ctx.match[1]);
  const phoneNumber = ctx.match[2];
  
  // Security check
  if (ctx.from.id !== userId && !isDeveloper(ctx.from.id)) {
    await ctx.answerCbQuery('❌ Akses ditolak');
    return;
  }
  
  await ctx.answerCbQuery('🔄 Switching...');
  
  try {
    const result = toggleAutoRead(userId, phoneNumber);
    saveBotState();
    
    let statusMessage = result.enabled ? '🟢 AKTIF' : '🔴 MATI';
    
    // Update keyboard
    const user = initUserData(userId);
    const userSessions = [];
    user.connections.forEach((conn, num) => {
      if (conn.status === 'connected') {
        const autoReadEnabled = user.autoReadSessions.get(num) || false;
        userSessions.push({ 
          phoneNumber: num,
          autoReadEnabled: autoReadEnabled
        });
      }
    });
    
    await ctx.editMessageReplyMarkup({
      inline_keyboard: [
        ...userSessions.map((session, index) => [
          {
            text: `${index + 1}. ${formatPhone(session.phoneNumber)} ${session.autoReadEnabled ? '🟢' : '🔴'}`,
            callback_data: `readchat_toggle_${userId}_${session.phoneNumber}`
          }
        ]),
        [
          { 
            text: '📊 Status Semua', 
            callback_data: `readchat_status_${userId}` 
          },
          { 
            text: '🔄 Aktifkan Semua', 
            callback_data: `readchat_enableall_${userId}` 
          }
        ]
      ]
    });
    
    // Send confirmation
    await ctx.reply(
`✅ *AUTO-READ ${result.enabled ? 'DIAKTIFKAN' : 'DIMATIKAN'}*

📱 ${formatPhone(phoneNumber)}
👁️ Status: ${statusMessage}

${result.enabled ? 'Pesan yang masuk akan otomatis dibaca.' : 'Pesan tidak akan dibaca otomatis.'}

⚙️ Ubah lagi: /readchat`,
      { parse_mode: 'Markdown' }
    );
    
  } catch (error) {
    console.error('Toggle auto-read error:', error);
    await ctx.reply(
`❌ GAGAL MENGUBAH SETTING

Error: ${error.message}`,
      { parse_mode: 'Markdown' }
    );
  }
});

// Readchat status callback
bot.action(/readchat_status_(\d+)/, async (ctx) => {
  const userId = parseInt(ctx.match[1]);
  
  // Security check
  if (ctx.from.id !== userId && !isDeveloper(ctx.from.id)) {
    await ctx.answerCbQuery('❌ Akses ditolak');
    return;
  }
  
  await ctx.answerCbQuery('📊 Getting status...');
  
  const sessions = getUserReadSessions(userId);
  
  if (sessions.length === 0) {
    await ctx.reply(
`📭 *BELUM ADA SESI AUTO-READ*

Pilih sesi dulu di:
/readchat`,
      { parse_mode: 'Markdown' }
    );
    return;
  }
  
  let message = 
`╔══════════════════════╗
   📊 *STATUS AUTO-READ*  
╚══════════════════════╝\n\n`;
  
  sessions.forEach((session, index) => {
    const statusEmoji = session.enabled ? '🟢' : '🔴';
    const statusText = session.enabled ? 'AKTIF' : 'MATI';
    
    message += `**${index + 1}.** *${formatPhone(session.phoneNumber)}*\n`;
    message += `   ${statusEmoji} ${statusText}\n\n`;
  });
  
  const activeCount = sessions.filter(s => s.enabled).length;
  message += 
`━━━━━━━━━━━━━━━━━━━━━━━━━
🟢 Aktif: ${activeCount}
🔴 Mati: ${sessions.length - activeCount}

⚙️ Ubah: /readchat`;
  
  await ctx.reply(message, { parse_mode: 'Markdown' });
});

// Enable all readchat callback
bot.action(/readchat_enableall_(\d+)/, async (ctx) => {
  const userId = parseInt(ctx.match[1]);
  
  // Security check
  if (ctx.from.id !== userId && !isDeveloper(ctx.from.id)) {
    await ctx.answerCbQuery('❌ Akses ditolak');
    return;
  }
  
  await ctx.answerCbQuery('🔄 Enabling all...');
  
  const user = initUserData(userId);
  let enabledCount = 0;
  
  user.connections.forEach((conn, phoneNumber) => {
    if (conn.status === 'connected') {
      user.autoReadSessions.set(phoneNumber, true);
      enabledCount++;
    }
  });
  
  saveBotState();
  
  let message = 
`✅ *AUTO-READ DIAKTIFKAN*

Total: ${enabledCount} sesi

Sekarang semua pesan yang masuk akan otomatis dibaca.

🔧 Matikan jika perlu:
/readchat`;
  
  await ctx.reply(message, { parse_mode: 'Markdown' });
});

// Check follow callback
bot.action('check_follow', async (ctx) => {
  await ctx.answerCbQuery('🔍 Checking...');
  
  const isMember = await checkChannelMembership(bot, ctx.from.id);
  
  if (isMember) {
    await ctx.editMessageText(
`✅ *BERHASIL VERIFIKASI*

Selamat! Kamu sudah join channel.

Sekarang kamu bisa menggunakan semua fitur bot.

🔄 *Ketik:* /start`,
      { parse_mode: 'Markdown' }
    );
  } else {
    await ctx.answerCbQuery('❌ Belum join channel');
    await ctx.reply(
`❌ *BELUM JOIN CHANNEL*

Kamu belum join channel.

📢 *Channel:* ${CHANNEL_TITLE}
🔗 *Link:* ${CHANNEL_LINK}

Join dulu ya!`,
      { parse_mode: 'Markdown' }
    );
  }
});

// ====================
// MEDIA HANDLING FOR SWGC
// ====================

bot.on('message', async (ctx) => {
  const userId = ctx.from.id;
  
  // Check if user is in SWGC flow
  global.userStates = global.userStates || new Map();
  const userState = global.userStates.get(userId);
  
  if (!userState || userState.step !== 'waiting_media') {
    return;
  }
  
  const { selectedSession, selectedGroup, groupName } = userState;
  
  // Clear user state
  global.userStates.delete(userId);
  
  // Get message info
  const message = ctx.message;
  let mediaType = null;
  let mediaBuffer = null;
  let caption = '';
  
  // Check media types
  if (message.photo) {
    mediaType = 'image';
    const fileId = message.photo[message.photo.length - 1].file_id;
    const file = await ctx.telegram.getFile(fileId);
    const fileUrl = `https://api.telegram.org/file/bot${config.TELEGRAM_TOKEN}/${file.file_path}`;
    
    const response = await fetch(fileUrl);
    mediaBuffer = Buffer.from(await response.arrayBuffer());
    caption = message.caption || '';
    
  } else if (message.video) {
    mediaType = 'video';
    const fileId = message.video.file_id;
    const file = await ctx.telegram.getFile(fileId);
    const fileUrl = `https://api.telegram.org/file/bot${config.TELEGRAM_TOKEN}/${file.file_path}`;
    
    const response = await fetch(fileUrl);
    mediaBuffer = Buffer.from(await response.arrayBuffer());
    caption = message.caption || '';
    
  } else if (message.audio) {
    mediaType = 'audio';
    const fileId = message.audio.file_id;
    const file = await ctx.telegram.getFile(fileId);
    const fileUrl = `https://api.telegram.org/file/bot${config.TELEGRAM_TOKEN}/${file.file_path}`;
    
    const response = await fetch(fileUrl);
    mediaBuffer = Buffer.from(await response.arrayBuffer());
    
  } else if (message.text) {
    mediaType = 'text';
    caption = message.text;
    
  } else {
    await ctx.reply(
`❌ *FORMAT TIDAK DIDUKUNG*

Kirim foto, video, audio, atau teks untuk update status grup.`,
      { parse_mode: 'Markdown' }
    );
    return;
  }
  
  // Send processing message
  const processingMsg = await ctx.reply(
`⏳ *MEMPROSES UPDATE*

📱 ${formatPhone(selectedSession)}
📢 ${groupName}
📦 ${mediaType}

_Tunggu sebentar..._`,
    { parse_mode: 'Markdown' }
  );
  
  try {
    const socketData = activeSockets.get(selectedSession);
    if (!socketData) {
      throw new Error('Sesi tidak ditemukan');
    }
    
    let updatePayload = {};
    
    switch (mediaType) {
      case 'image':
        updatePayload = {
          groupStatusMessage: {
            image: mediaBuffer,
            caption: caption || ''
          }
        };
        break;
        
      case 'video':
        updatePayload = {
          groupStatusMessage: {
            video: mediaBuffer,
            caption: caption || ''
          }
        };
        break;
        
      case 'audio':
        updatePayload = {
          groupStatusMessage: {
            audio: mediaBuffer
          }
        };
        break;
        
      default:
        updatePayload = {
          groupStatusMessage: {
            text: caption || ''
          }
        };
    }
    
    await socketData.socket.sendMessage(selectedGroup, updatePayload);
    
    let successMessage = 
`✅ *STATUS UPDATED!*

📱 ${formatPhone(selectedSession)}
📢 ${groupName}
✅ ${mediaType}
⏱️ ${new Date().toLocaleTimeString()}\n`;
    
    if (caption && mediaType !== 'text') {
      successMessage += `\n📝 ${caption.substring(0, 50)}${caption.length > 50 ? '...' : ''}\n`;
    }
    
    successMessage += `\n⚡ Update lagi: /upswgc`;
    
    await ctx.telegram.editMessageText(
      ctx.chat.id,
      processingMsg.message_id,
      null,
      successMessage,
      { parse_mode: 'Markdown' }
    );
    
  } catch (error) {
    console.error('SWGC error:', error);
    
    await ctx.telegram.editMessageText(
      ctx.chat.id,
      processingMsg.message_id,
      null,
`❌ *GAGAL UPDATE STATUS*

Error: ${error.message}

🔄 Coba lagi: /upswgc`,
      { parse_mode: 'Markdown' }
    );
  }
});

// ====================
// BUTTON HANDLERS
// ====================

bot.hears('➕ Add Sender 628xxx', (ctx) => {
  ctx.reply(
`🔄 *ADD SENDER*

Kirim: \`/addsender 628xxx\`

*Contoh:*
• \`/addsender 6282284243004\`
• \`/addsender 082284243004\``,
    { parse_mode: 'Markdown' }
  );
});

bot.hears('📋 List Group', (ctx) => {
  ctx.reply(
`📋 *LIST GROUP*

Kirim: \`/listgroup\`

Untuk melihat semua grup WhatsApp.`,
    { parse_mode: 'Markdown' }
  );
});

bot.hears('📊 Status All', (ctx) => {
  ctx.reply(
`📊 *STATUS ALL*

Kirim: \`/status\`

Untuk melihat semua koneksi aktif.`,
    { parse_mode: 'Markdown' }
  );
});

bot.hears('⚡ Update SWGC', (ctx) => {
  ctx.reply(
`⚡ *UPDATE SWGC*

Kirim: \`/upswgc\`

Untuk update status grup WhatsApp.`,
    { parse_mode: 'Markdown' }
  );
});

bot.hears('👁️ Read Chat', (ctx) => {
  ctx.reply(
`👁️ *READ CHAT*

Kirim: \`/readchat\`

Untuk aktifkan/matikan auto-read pesan.`,
    { parse_mode: 'Markdown' }
  );
});

// ====================
// BOT STARTUP
// ====================

// Error handling
bot.catch((err, ctx) => {
  console.error(`[BOT ERROR] ${ctx.updateType}:`, err);
  
  if (config.DEVELOPER_ID) {
    bot.telegram.sendMessage(
      config.DEVELOPER_ID,
`⚠️ *BOT ERROR*

Type: ${ctx.updateType}
Error: ${err.message}
User: ${ctx.from?.id || 'Unknown'}`,
      { parse_mode: 'Markdown' }
    ).catch(() => {});
  }
});

// Graceful shutdown
process.once('SIGINT', () => {
  console.log('🛑 Shutting down...');
  saveBotState();
  bot.stop('SIGINT');
});

process.once('SIGTERM', () => {
  console.log('🛑 Shutting down...');
  saveBotState();
  bot.stop('SIGTERM');
});

// Auto-save monitoring
setInterval(() => {
  console.log(`📊 Monitoring: ${activeSockets.size} active connections, ${userData.size} users`);
  saveBotState();
}, 30000);

// Start bot with session recovery
bot.launch()
  .then(async () => {
    console.log(`✅ Bot Telegram aktif!`);
    console.log(`👤 Developer ID: ${config.DEVELOPER_ID}`);
    console.log(`📱 Mode: PAIRING CODE SYSTEM`);
    console.log(`📢 Channel: ${CHANNEL_TITLE}`);
    console.log(`🕒 Started: ${new Date().toLocaleString()}`);
    console.log(`🔗 Session dir: ${SESSION_DIR}`);
    
    // Load existing state
    const state = loadBotState();
    if (state) {
      // Initialize user data from state
      state.users.forEach(userState => {
        const user = initUserData(userState.userId);
        userState.connections.forEach(conn => {
          user.connections.set(conn.phoneNumber, {
            status: conn.status,
            socketId: conn.socketId,
            connectedAt: conn.connectedAt
          });
        });
        userState.pairingCodes.forEach(pair => {
          user.pairingCodes.set(pair.phoneNumber, {
            code: pair.code,
            timestamp: pair.timestamp,
            userId: pair.userId
          });
        });
        userState.autoReadSessions.forEach(session => {
          user.autoReadSessions.set(session.phoneNumber, session.enabled);
        });
        user.lastActivity = userState.lastActivity;
        user.userInfo = userState.userInfo;
      });
      
      console.log(`📊 Loaded ${state.users.length} users from state`);
    }
    
    // Recover sessions after bot is started
    setTimeout(() => {
      recoverSessions();
    }, 5000);
    
    if (config.DEVELOPER_ID) {
      bot.telegram.sendMessage(
        config.DEVELOPER_ID,
`✅ *BOT STARTED!*

🤖 ${config.BOT_NAME}
📱 Pairing Code System
📢 Channel Check: Active
🕒 ${new Date().toLocaleString()}
🔄 Auto-recovery enabled
🔒 Private per-user sessions
🚀 Ready for connections!

Test: \`/addsender 6282284243004\`
Admin: \`/admin\``,
        { parse_mode: 'Markdown' }
      ).catch(() => {});
    }
  })
  .catch(err => {
    console.error('❌ Failed to start bot:', err);
    process.exit(1);
  });