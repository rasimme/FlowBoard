'use strict';

const crypto = require('crypto');

// Public Telegram WebApp domain separator. Bot tokens are the secrets.
const TELEGRAM_WEBAPP_HMAC_SALT = 'WebAppData';
const TELEGRAM_INIT_DATA_MAX_AGE_SECONDS = 300;

const AUTH_FAILURES = Object.freeze({
  MISSING: Object.freeze({
    ok: false,
    status: 403,
    code: 'TELEGRAM_INIT_DATA_MISSING',
    error: 'Telegram init data is required.',
  }),
  INVALID: Object.freeze({
    ok: false,
    status: 403,
    code: 'TELEGRAM_INIT_DATA_INVALID',
    error: 'Telegram init data is invalid.',
  }),
  EXPIRED: Object.freeze({
    ok: false,
    status: 403,
    code: 'TELEGRAM_INIT_DATA_EXPIRED',
    error: 'Telegram init data has expired. Reopen the Mini App and try again.',
  }),
  FUTURE: Object.freeze({
    ok: false,
    status: 403,
    code: 'TELEGRAM_INIT_DATA_FUTURE',
    error: 'Telegram init data has an invalid authentication time.',
  }),
  UNSUPPORTED_BOT: Object.freeze({
    ok: false,
    status: 403,
    code: 'TELEGRAM_BOT_NOT_SUPPORTED',
    error: 'Telegram init data was not signed by a configured bot.',
  }),
  USER_NOT_ALLOWED: Object.freeze({
    ok: false,
    status: 403,
    code: 'TELEGRAM_USER_NOT_ALLOWED',
    error: 'This Telegram user is not allowed to access FlowBoard.',
  }),
  MAPPING_MISSING: Object.freeze({
    ok: false,
    status: 503,
    code: 'TELEGRAM_AGENT_MAPPING_MISSING',
    error: 'The authenticated Telegram bot has no configured FlowBoard agent mapping.',
  }),
});

function configError(code, message) {
  return { code, message };
}

function orderedCsv(raw, { emptyCode, label }) {
  if (!String(raw || '').trim()) return { values: [], errors: [] };
  const entries = String(raw).split(',').map(value => value.trim());
  const errors = [];
  entries.forEach((value, index) => {
    if (!value) {
      errors.push(configError(
        emptyCode,
        `${label} contains an empty entry at position ${index + 1}; ordered mappings may not contain gaps.`
      ));
    }
  });
  return { values: entries.filter(Boolean), errors };
}

/**
 * Build the ordered bot-token -> FlowBoard-agent identity list.
 *
 * No diagnostic ever includes a token value. Position 1 is always
 * TELEGRAM_BOT_TOKEN; later positions follow TELEGRAM_BOT_TOKENS in order.
 */
function buildTelegramAuthConfig({
  primaryToken = '',
  additionalTokens = '',
  agentIds = '',
  requireAgentMappings = true,
  validateAgentId,
} = {}) {
  const errors = [];
  const primary = String(primaryToken || '').trim();

  if (primary.includes(',')) {
    errors.push(configError(
      'TELEGRAM_PRIMARY_TOKEN_MULTIPLE',
      'TELEGRAM_BOT_TOKEN must contain exactly one primary bot token.'
    ));
  }

  const extra = orderedCsv(additionalTokens, {
    emptyCode: 'TELEGRAM_TOKEN_LIST_EMPTY_ENTRY',
    label: 'TELEGRAM_BOT_TOKENS',
  });
  errors.push(...extra.errors);

  if (!primary && extra.values.length > 0) {
    errors.push(configError(
      'TELEGRAM_PRIMARY_TOKEN_REQUIRED',
      'TELEGRAM_BOT_TOKENS contains additional tokens but TELEGRAM_BOT_TOKEN is empty.'
    ));
  }

  const tokens = primary ? [primary, ...extra.values] : [];
  const tokenPositions = new Map();
  tokens.forEach((token, index) => {
    if (tokenPositions.has(token)) {
      errors.push(configError(
        'TELEGRAM_TOKEN_DUPLICATE',
        `Telegram bot tokens must be unique; positions ${tokenPositions.get(token) + 1} and ${index + 1} duplicate one another.`
      ));
    } else {
      tokenPositions.set(token, index);
    }
  });

  const agents = orderedCsv(agentIds, {
    emptyCode: 'TELEGRAM_AGENT_MAPPING_EMPTY_ENTRY',
    label: 'FLOWBOARD_TELEGRAM_AGENT_IDS',
  });
  errors.push(...agents.errors);

  if ((requireAgentMappings || agents.values.length > 0) && agents.values.length !== tokens.length) {
    errors.push(configError(
      'TELEGRAM_AGENT_MAPPING_COUNT',
      `FLOWBOARD_TELEGRAM_AGENT_IDS must contain exactly ${tokens.length} ordered entr${tokens.length === 1 ? 'y' : 'ies'} for the configured bot tokens; received ${agents.values.length}.`
    ));
  }

  const agentPositions = new Map();
  agents.values.forEach((agentId, index) => {
    const identity = typeof validateAgentId === 'function'
      ? validateAgentId(agentId, `FLOWBOARD_TELEGRAM_AGENT_IDS entry ${index + 1}`)
      : { ok: true, id: agentId };
    if (!identity.ok) {
      errors.push(configError('TELEGRAM_AGENT_ID_INVALID', identity.error));
    }
    if (agentPositions.has(agentId)) {
      errors.push(configError(
        'TELEGRAM_AGENT_MAPPING_DUPLICATE',
        `FLOWBOARD_TELEGRAM_AGENT_IDS must be unique; positions ${agentPositions.get(agentId) + 1} and ${index + 1} both map to "${agentId}".`
      ));
    } else {
      agentPositions.set(agentId, index);
    }
  });

  const botIdentities = tokens.map((token, index) => ({
    token,
    agentId: agents.values[index] || null,
    position: index + 1,
  }));

  return {
    ok: errors.length === 0,
    errors,
    botIdentities,
    tokenCount: tokens.length,
  };
}

function validateTelegramInitData(initData, {
  botIdentities = [],
  allowedUserIds = [],
  nowSeconds = Math.floor(Date.now() / 1000),
} = {}) {
  if (!initData) return AUTH_FAILURES.MISSING;

  let params;
  try {
    params = new URLSearchParams(initData);
  } catch {
    return AUTH_FAILURES.INVALID;
  }

  const hashes = params.getAll('hash');
  if (hashes.length !== 1 || !/^[a-fA-F0-9]{64}$/.test(hashes[0])) {
    return AUTH_FAILURES.INVALID;
  }

  const authDateRaw = params.get('auth_date') || '';
  if (!/^\d+$/.test(authDateRaw)) return AUTH_FAILURES.INVALID;
  const authDate = Number(authDateRaw);
  if (!Number.isSafeInteger(authDate)) return AUTH_FAILURES.INVALID;
  if (authDate > nowSeconds) return AUTH_FAILURES.FUTURE;
  if (nowSeconds - authDate > TELEGRAM_INIT_DATA_MAX_AGE_SECONDS) return AUTH_FAILURES.EXPIRED;

  params.delete('hash');
  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
  const receivedHash = Buffer.from(hashes[0], 'hex');

  // Evaluate every configured bot, rather than stopping on the first match, so
  // response timing does not disclose the matching token's position.
  let matchedBotIndex = -1;
  botIdentities.forEach(({ token }, index) => {
    const secretKey = crypto
      .createHmac('sha256', TELEGRAM_WEBAPP_HMAC_SALT)
      .update(token)
      .digest();
    const expectedHash = crypto
      .createHmac('sha256', secretKey)
      .update(dataCheckString)
      .digest();
    if (crypto.timingSafeEqual(expectedHash, receivedHash) && matchedBotIndex === -1) {
      matchedBotIndex = index;
    }
  });

  if (matchedBotIndex === -1) return AUTH_FAILURES.UNSUPPORTED_BOT;

  let telegramUser;
  try {
    telegramUser = JSON.parse(params.get('user') || 'null');
  } catch {
    return AUTH_FAILURES.INVALID;
  }
  if (!telegramUser || typeof telegramUser !== 'object' || Array.isArray(telegramUser)) {
    return AUTH_FAILURES.INVALID;
  }
  if (!allowedUserIds.includes(telegramUser.id)) return AUTH_FAILURES.USER_NOT_ALLOWED;

  const matchedIdentity = botIdentities[matchedBotIndex];
  if (!matchedIdentity?.agentId) return AUTH_FAILURES.MAPPING_MISSING;

  return {
    ok: true,
    user: { ...telegramUser, agentId: matchedIdentity.agentId },
    agentId: matchedIdentity.agentId,
    botIndex: matchedBotIndex,
  };
}

module.exports = {
  AUTH_FAILURES,
  TELEGRAM_INIT_DATA_MAX_AGE_SECONDS,
  buildTelegramAuthConfig,
  validateTelegramInitData,
};
