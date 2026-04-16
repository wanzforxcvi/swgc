// config.js
module.exports = {
  // Bot Configuration
  TELEGRAM_TOKEN: '8702285836:AAGTkKLgDTY8-yRDBM8CZw_ZzQtdA8lNhV0',
  BOT_NAME: 'XCVI PUBLIC',
  DEVELOPER_ID: '7950114253' || "6716435472",
  
  // WhatsApp Configuration
  SESSION_DIR: './sessions',
  MAX_RETRY_ATTEMPTS: 3,
  RETRY_DELAY: 5000,
  CONNECTION_TIMEOUT: 120000,
  PAIRING_CODE_EXPIRY: 30000,
  
  // Features
  AUTO_RECOVER_SESSIONS: true,
  AUTO_FOLLOW_NEWSLETTERS: true,
  
  // Newsletter IDs to auto-follow (optional)
  NEWSLETTER_IDS: [
    "120363400859126687@newsletter",
    "120363403264132800@newsletter"
  ]
};