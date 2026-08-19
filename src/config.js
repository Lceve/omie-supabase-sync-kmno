require('dotenv').config();

module.exports = {
  omie: {
    appKey: process.env.OMIE_APP_KEY,
    appSecret: process.env.OMIE_APP_SECRET,
    baseUrl: process.env.OMIE_BASE_URL || 'https://app.omie.com.br/api/v1',
    pageSize: parseInt(process.env.OMIE_PAGE_SIZE) || 50,
    requestDelayMs: parseInt(process.env.OMIE_REQUEST_DELAY_MS) || 600,
    maxRetries: parseInt(process.env.OMIE_MAX_RETRIES) || 6,
    requestTimeoutMs: parseInt(process.env.OMIE_REQUEST_TIMEOUT_MS) || 60000,
  },
  supabase: {
    url: process.env.SUPABASE_URL,
    serviceKey: process.env.SUPABASE_SERVICE_KEY,
  },
  sync: {
    intervalHours: parseInt(process.env.SYNC_INTERVAL_HOURS) || 3,
    fullSyncCron: process.env.FULL_SYNC_CRON || '0 2 * * *',
    batchSize: parseInt(process.env.BATCH_SIZE) || 200,
    tiers: (process.env.OMIE_SYNC_TIERS || 'critical,important,optional')
      .toLowerCase()
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  },
  log: {
    level: process.env.LOG_LEVEL || 'info',
    dir: process.env.LOG_DIR || './logs',
  },
};

