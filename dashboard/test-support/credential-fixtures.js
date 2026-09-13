'use strict';

const crypto = require('node:crypto');

// Keep test credentials process-local. The salt makes every test process use a
// different set of values while deterministic labels keep related fixtures
// stable within that process.
const PROCESS_SALT = crypto.randomBytes(32);

function digest(scope, label) {
  return crypto.createHmac('sha256', PROCESS_SALT)
    .update(`${scope}:${label}`)
    .digest('hex');
}

function createTelegramBotToken(scope, label) {
  const idDigest = Buffer.from(digest(scope, `${label}:id`), 'hex');
  const botId = 100000 + (idDigest.readUInt32BE(0) % 900000);
  return `${botId}:${digest(scope, `${label}:value`)}`;
}

function createPrivateKeyExample() {
  const { privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  return privateKey;
}

function createCredentialFixtures(scope = 'flowboard-test', { includeHighConfidenceExamples = false } = {}) {
  const name = String(scope);
  const jwtSecret = digest(name, 'jwt-secret');
  const jwtLike = [
    `eyJ${digest(name, 'jwt-header')}`,
    `eyJ${digest(name, 'jwt-payload')}`,
    digest(name, 'jwt-signature'),
  ].join('.');
  const botToken = createTelegramBotToken(name, 'primary-bot');
  const secondaryBotToken = createTelegramBotToken(name, 'secondary-bot');
  const tertiaryBotToken = createTelegramBotToken(name, 'tertiary-bot');
  const unsupportedBotToken = createTelegramBotToken(name, 'unsupported-bot');
  const optionalApiToken = `sk-${digest(name, 'optional-api')}`;
  const projectApiToken = `sk-proj-${digest(name, 'project-api')}`;
  const anthropicApiToken = `sk-ant_${digest(name, 'anthropic-api')}`;
  const githubToken = `ghp_${digest(name, 'github')}`;
  const githubPat = `github_pat_${digest(name, 'github-pat')}`;
  const bearerToken = digest(name, 'bearer');
  const assignmentValue = digest(name, 'assignment');
  const urlUsername = `review-${digest(name, 'url-user').slice(0, 16)}`;
  const urlPassword = `review-${digest(name, 'url-password').slice(0, 24)}`;

  const fixtures = {
    jwtSecret,
    wrongJwtSecret: digest(name, 'wrong-jwt-secret'),
    botToken,
    secondaryBotToken,
    tertiaryBotToken,
    botTokens: Object.freeze([botToken, secondaryBotToken, tertiaryBotToken]),
    unsupportedBotToken,
    hooksToken: digest(name, 'hooks-token'),
    optionalApiToken,
    projectApiToken,
    historyApiToken: `sk-proj-${digest(name, 'history-api')}`,
    githubToken,
    githubPat,
    bearerToken,
    jwtLike,
    legacyCookie: `flowboard_session=${jwtLike}`,
    parentSecret: digest(name, 'parent-secret'),
    discardedCredential: digest(name, 'discarded-credential'),
  };

  if (includeHighConfidenceExamples) {
    fixtures.highConfidenceExamples = Object.freeze([
      createPrivateKeyExample(),
      `Bearer ${bearerToken}`,
      jwtLike,
      optionalApiToken,
      projectApiToken,
      anthropicApiToken,
      githubToken,
      githubPat,
      createTelegramBotToken(name, 'telegram-example'),
      `https://${urlUsername}:${urlPassword}@example.test/path`,
      `password: ${assignmentValue}`,
    ]);
  }

  return Object.freeze(fixtures);
}

module.exports = {
  createCredentialFixtures,
};
