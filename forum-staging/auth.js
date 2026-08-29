import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from '@simplewebauthn/server';
import argon2 from 'argon2';
import { normalizeDatabaseId } from './database-id.js';
import { isAdministrator } from './policy.js';
import { digestRegistrationInviteToken } from './registration-invites.js';
import { isValidUsername, normalizeUsername } from './username.js';
import { isCanonicalUuid } from './uuid.js';

const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const oneTimeTokenPattern = /^[A-Za-z0-9_-]{43}$/;
const verificationLifetimeMs = 24 * 60 * 60 * 1000;
const resetLifetimeMs = 60 * 60 * 1000;
const sessionLifetimeMs = 12 * 60 * 60 * 1000;
const persistentSessionLifetimeMs = 30 * 24 * 60 * 60 * 1000;
const defaultSessionIdleTimeoutMs = 7 * 24 * 60 * 60 * 1000;
const loginBackoffResetMs = 15 * 60 * 1000;
const passkeyChallengeLifetimeMs = 5 * 60 * 1000;
const maximumPasskeysPerAccount = 10;
const topicCreationWindowMs = 30 * 60 * 1000;
const defaultNotificationLimit = 4;
const maximumNotificationLimit = 50;
const passkeyCredentialIdPattern = /^[A-Za-z0-9_-]{1,1364}$/;
const passkeyLabelPattern = /^[^\u0000-\u001f\u007f]{1,80}$/;
const passkeyAlgorithmIds = [-7, -257];
const passkeyTransports = new Set([
  'ble', 'cable', 'hybrid', 'internal', 'nfc', 'smart-card', 'usb',
]);

export const CURRENT_RULES_VERSION = '2026-08-21';

export class AuthError extends Error {
  constructor(code, statusCode, { retryAfterMs } = {}) {
    super(code);
    this.code = code;
    this.retryAfterMs = retryAfterMs;
    this.statusCode = statusCode;
  }
}

export function normalizeEmail(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

export { normalizeUsername } from './username.js';

export function digestToken(value) {
  return createHash('sha256').update(value).digest('hex');
}

function parseNotificationQueryValue(value, fallback, maximum) {
  if (value === undefined || value === null) {
    return fallback;
  }
  if (!['number', 'string'].includes(typeof value) || !/^\d+$/.test(String(value))) {
    throw new AuthError('invalid_notification_query', 400);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed > maximum) {
    throw new AuthError('invalid_notification_query', 400);
  }
  return parsed;
}

export function createPasswordHasher() {
  return {
    hash(password) {
      return argon2.hash(password, {
        memoryCost: 19_456,
        parallelism: 1,
        timeCost: 2,
        type: argon2.argon2id,
      });
    },
    verify(hash, password) {
      return argon2.verify(hash, password);
    },
  };
}

function validateEmail(email) {
  if (email.length > 254 || !emailPattern.test(email)) {
    throw new AuthError('invalid_email', 400);
  }
}

function isValidOneTimeToken(value) {
  return typeof value === 'string' && oneTimeTokenPattern.test(value);
}

function validatePassword(password) {
  if (typeof password !== 'string' || password.length < 12 || password.length > 128) {
    throw new AuthError('invalid_password', 400);
  }
}

function validateUsername(username) {
  if (!isValidUsername(username)) {
    throw new AuthError('invalid_username', 400);
  }
}

function normalizeUserAgent(value) {
  return typeof value === 'string'
    ? value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 200) || 'Unknown device'
    : 'Unknown device';
}

function tokensMatch(expectedDigest, value) {
  if (!expectedDigest || typeof value !== 'string') {
    return false;
  }

  const actualDigest = digestToken(value);
  return timingSafeEqual(Buffer.from(expectedDigest, 'hex'), Buffer.from(actualDigest, 'hex'));
}

function publicAccount(account) {
  return {
    avatarContentType: account.avatarUpdatedAt ? account.avatarContentType : null,
    avatarUrl: account.avatarUpdatedAt
      ? `/api/avatars/${account.id}?v=${new Date(account.avatarUpdatedAt).getTime()}`
      : null,
    createdAt: account.createdAt,
    description: account.description,
    displayName: account.displayName,
    email: account.email,
    forumPostingMuted: account.forumPostingMuted,
    id: account.id,
    membershipStatus: account.membershipStatus,
    mustChangePassword: account.forcePasswordChange,
    permissions: account.permissions,
    role: account.role,
    signature: account.signature,
    slowdownMs: account.slowdownMs,
    shoutboxPostingMuted: account.shoutboxPostingMuted,
    timestampColor: account.timestampColor,
    username: account.username,
    usernameColor: account.usernameColor,
    usernameColorEffect: account.usernameColorEffect,
    usernameColorEffectsUnlocked: account.usernameColorEffectsUnlocked,
    preferences: {
      colorScheme: account.colorScheme,
      fontSize: account.fontSize,
      fontTypeface: account.fontTypeface,
      shoutboxEnabled: account.shoutboxEnabled,
      shoutboxHeightLines: account.shoutboxHeightLines,
      shoutboxMuted: account.shoutboxMuted,
      shoutboxOrder: account.shoutboxOrder ?? 'oldest-first',
      statusAndActivityVisible: account.statusAndActivityVisible,
      theme: account.theme,
      timeZone: account.timeZone,
    },
  };
}

function publicNotification(notification) {
  return {
    createdAt: notification.createdAt,
    href: notification.href,
    id: String(notification.id),
    message: notification.message,
    read: Boolean(notification.readAt),
  };
}

function publicPasskey(passkey) {
  return {
    backedUp: Boolean(passkey.backedUp),
    createdAt: passkey.createdAt,
    deviceType: passkey.deviceType,
    id: passkey.id,
    label: passkey.label,
    lastUsedAt: passkey.lastUsedAt,
    transports: passkey.transports,
  };
}

function normalizePasskeyLabel(value) {
  const label = typeof value === 'string' ? value.trim() : '';
  if (!passkeyLabelPattern.test(label)) {
    throw new AuthError('invalid_passkey_label', 400);
  }
  return label;
}

function validateCredentialResponse(value) {
  if (
    !value
    || typeof value !== 'object'
    || Array.isArray(value)
    || !passkeyCredentialIdPattern.test(value.id ?? '')
  ) {
    throw new AuthError('invalid_passkey_response', 400);
  }
  return value;
}

function webauthnUserId(accountId) {
  if (!isCanonicalUuid(accountId)) {
    throw new AuthError('passkey_unavailable', 503);
  }
  return Buffer.from(accountId.replaceAll('-', ''), 'hex');
}

export function createAuthService({
  avatarProcessor,
  clock = () => new Date(),
  mailer,
  passwordHasher,
  publicOrigin,
  randomToken = () => randomBytes(32).toString('base64url'),
  repository,
  sessionIdleTimeoutMs = defaultSessionIdleTimeoutMs,
  webauthn = {
    generateAuthenticationOptions,
    generateRegistrationOptions,
    verifyAuthenticationResponse,
    verifyRegistrationResponse,
  },
}) {
  function getRelyingParty() {
    const origin = new URL(publicOrigin).origin;
    return { id: new URL(origin).hostname, origin };
  }

  async function withinRateLimit(action, subject, limit, windowMs) {
    return repository.consumeRateLimit({
      action,
      limit,
      now: clock(),
      subjectDigest: digestToken(subject),
      windowMs,
    });
  }

  async function recordAuthenticationEvent(accountId, action, details = {}) {
    await repository.recordAuthenticationEvent({
      accountId,
      action,
      details,
      occurredAt: clock(),
    });
  }

  async function issueVerification(account) {
    const token = randomToken();
    const expiresAt = new Date(clock().getTime() + verificationLifetimeMs);
    await repository.replaceVerificationToken(account.id, digestToken(token), expiresAt);
    await mailer.sendVerification({
      email: account.email,
      url: `${publicOrigin}/account#verify=${encodeURIComponent(token)}`,
    });
  }

  function createSessionMaterial(account, rememberMe, userAgent) {
    const sessionToken = randomToken();
    const csrfToken = randomToken();
    const expiresAt = new Date(clock().getTime() + (
      rememberMe ? persistentSessionLifetimeMs : sessionLifetimeMs
    ));
    return {
      account,
      csrfToken,
      expiresAt,
      persistent: rememberMe,
      sessionId: randomUUID(),
      sessionToken,
      userAgent: normalizeUserAgent(userAgent),
    };
  }

  function canVerifyAccount(account) {
    return Boolean(
      account
      && !account.deletedAt
      && !account.emailVerifiedAt
      && account.membershipStatus === 'pending'
    );
  }

  async function register({
    email: inputEmail,
    inviteToken,
    password,
    rulesAgreed,
    username: inputUsername,
  }) {
    if (rulesAgreed !== true) {
      throw new AuthError('rules_agreement_required', 400);
    }
    const email = normalizeEmail(inputEmail);
    const username = typeof inputUsername === 'string' ? inputUsername.trim() : '';
    const normalizedUsername = normalizeUsername(username);
    const inviteTokenDigest = digestRegistrationInviteToken(inviteToken);
    validateEmail(email);
    validatePassword(password);
    validateUsername(username);
    if (!inviteTokenDigest) {
      throw new AuthError('invalid_registration_invite', 400);
    }
    if (!await withinRateLimit('register', email, 3, 60 * 60 * 1000)) {
      return;
    }

    const passwordHash = await passwordHasher.hash(password);
    const registeredAt = clock();
    const result = await repository.createAccount({
      email,
      inviteToken,
      inviteTokenDigest,
      normalizedUsername,
      passwordHash,
      registeredAt,
      rulesAgreedAt: registeredAt,
      rulesVersion: CURRENT_RULES_VERSION,
      username,
    });
    if (!result.inviteValid) {
      throw new AuthError('invalid_registration_invite', 400);
    }
    if (canVerifyAccount(result.account)) {
      await issueVerification(result.account);
    }
  }

  async function verifyEmail(token) {
    if (!isValidOneTimeToken(token)) {
      throw new AuthError('invalid_token', 400);
    }

    const verifiedAccount = await repository.consumeVerificationToken(digestToken(token), clock());
    if (!verifiedAccount) {
      throw new AuthError('invalid_token', 400);
    }
    await mailer.sendAccountVerified({ email: verifiedAccount.email });
  }

  async function login(
    { username: inputUsername, password, rememberMe = false },
    { userAgent } = {},
  ) {
    const username = normalizeUsername(inputUsername);
    if (
      !isValidUsername(username)
      || typeof password !== 'string'
      || password.length > 128
      || typeof rememberMe !== 'boolean'
    ) {
      throw new AuthError('invalid_credentials', 401);
    }
    const subjectDigest = digestToken(username);
    const retryAfterMs = await repository.getLoginBackoff(subjectDigest, clock());
    if (retryAfterMs > 0) {
      throw new AuthError('try_again_later', 429, { retryAfterMs });
    }
    if (!await withinRateLimit('login', username, 10, 15 * 60 * 1000)) {
      throw new AuthError('try_again_later', 429);
    }
    const account = await repository.findAccountByUsername(username);
    const passwordMatches = account
      ? await passwordHasher.verify(account.passwordHash, password)
      : await passwordHasher.verify(repository.dummyPasswordHash, password);

    if (!account || !passwordMatches) {
      const failureRetryAfterMs = await repository.recordLoginFailure({
        accountId: account?.id ?? null,
        now: clock(),
        resetAfterMs: loginBackoffResetMs,
        subjectDigest,
      });
      if (failureRetryAfterMs > 0) {
        throw new AuthError('try_again_later', 429, { retryAfterMs: failureRetryAfterMs });
      }
      throw new AuthError('invalid_credentials', 401);
    }
    await repository.clearLoginBackoff(subjectDigest);
    if (!account.emailVerifiedAt) {
      await recordAuthenticationEvent(account.id, 'auth.login.account_denied', {
        reason: 'unverified',
      });
      throw new AuthError('email_unverified', 403);
    }
    if (account.membershipStatus === 'pending') {
      await recordAuthenticationEvent(account.id, 'auth.login.account_denied', {
        reason: 'pending',
      });
      throw new AuthError('membership_pending', 403);
    }
    if (account.membershipStatus !== 'active') {
      await recordAuthenticationEvent(account.id, 'auth.login.account_denied', {
        reason: 'inactive',
      });
      throw new AuthError('account_unavailable', 403);
    }
    if (account.forcePasswordChange) {
      await recordAuthenticationEvent(account.id, 'auth.login.account_denied', {
        reason: 'password_change_required',
      });
      throw new AuthError('password_change_required', 403);
    }

    const session = createSessionMaterial(account, rememberMe, userAgent);
    await repository.createSession({
      accountId: account.id,
      csrfDigest: digestToken(session.csrfToken),
      expiresAt: session.expiresAt,
      id: session.sessionId,
      persistent: rememberMe,
      tokenDigest: digestToken(session.sessionToken),
      userAgent: session.userAgent,
    });

    return {
      account: publicAccount(account),
      csrfToken: session.csrfToken,
      expiresAt: session.expiresAt,
      persistent: rememberMe,
      sessionToken: session.sessionToken,
    };
  }

  async function createPasskeyAuthenticationOptions() {
    const relyingParty = getRelyingParty();
    const options = await webauthn.generateAuthenticationOptions({
      rpID: relyingParty.id,
      userVerification: 'required',
    });
    const challengeId = randomUUID();
    const createdAt = clock();
    await repository.createWebAuthnChallenge({
      accountId: null,
      challenge: options.challenge,
      createdAt,
      expiresAt: new Date(createdAt.getTime() + passkeyChallengeLifetimeMs),
      id: challengeId,
      purpose: 'authentication',
      sessionId: null,
    });
    return { challengeId, options };
  }

  async function loginWithPasskey(
    { challengeId, credential: inputCredential, rememberMe = false },
    { clientAddress = 'unknown', userAgent } = {},
  ) {
    const relyingParty = getRelyingParty();
    if (!isCanonicalUuid(challengeId) || typeof rememberMe !== 'boolean') {
      throw new AuthError('invalid_credentials', 401);
    }
    let credential;
    try {
      credential = validateCredentialResponse(inputCredential);
    } catch {
      throw new AuthError('invalid_credentials', 401);
    }
    const challenge = await repository.claimWebAuthnChallenge({
      accountId: null,
      id: challengeId,
      now: clock(),
      purpose: 'authentication',
      sessionId: null,
    });
    if (
      !challenge
      || !await withinRateLimit(
        'passkey_login',
        `${clientAddress}:${credential.id}`,
        10,
        15 * 60 * 1000,
      )
    ) {
      throw new AuthError('invalid_credentials', 401);
    }
    const stored = await repository.findPasskeyByCredentialId(credential.id);
    if (!stored) {
      throw new AuthError('invalid_credentials', 401);
    }
    const expectedUserHandle = webauthnUserId(stored.account.id).toString('base64url');
    if (credential.response?.userHandle !== expectedUserHandle) {
      throw new AuthError('invalid_credentials', 401);
    }
    let verification;
    try {
      verification = await webauthn.verifyAuthenticationResponse({
        credential: {
          counter: stored.passkey.counter,
          id: stored.passkey.id,
          publicKey: stored.passkey.publicKey,
          transports: stored.passkey.transports,
        },
        expectedChallenge: challenge,
        expectedOrigin: relyingParty.origin,
        expectedRPID: relyingParty.id,
        requireUserVerification: true,
        response: credential,
      });
    } catch {
      throw new AuthError('invalid_credentials', 401);
    }
    if (!verification.verified || !verification.authenticationInfo) {
      throw new AuthError('invalid_credentials', 401);
    }
    const session = createSessionMaterial(stored.account, rememberMe, userAgent);
    const completed = await repository.completePasskeyLogin({
      accountId: stored.account.id,
      backedUp: verification.authenticationInfo.credentialBackedUp
        ?? stored.passkey.backedUp,
      credentialId: stored.passkey.id,
      csrfDigest: digestToken(session.csrfToken),
      expectedCounter: stored.passkey.counter,
      expiresAt: session.expiresAt,
      deviceType: verification.authenticationInfo.credentialDeviceType
        ?? stored.passkey.deviceType,
      newCounter: verification.authenticationInfo.newCounter,
      persistent: rememberMe,
      sessionId: session.sessionId,
      tokenDigest: digestToken(session.sessionToken),
      usedAt: clock(),
      userAgent: session.userAgent,
    });
    if (!completed) {
      throw new AuthError('invalid_credentials', 401);
    }
    return {
      account: publicAccount(stored.account),
      csrfToken: session.csrfToken,
      expiresAt: session.expiresAt,
      persistent: rememberMe,
      sessionToken: session.sessionToken,
    };
  }

  async function getSession(sessionToken) {
    if (!sessionToken) {
      throw new AuthError('authentication_required', 401);
    }

    const session = await repository.findSession(
      digestToken(sessionToken),
      clock(),
      sessionIdleTimeoutMs,
    );
    if (!session) {
      throw new AuthError('authentication_required', 401);
    }
    if (session.account.membershipStatus !== 'active' || session.account.forcePasswordChange) {
      throw new AuthError('authentication_required', 401);
    }

    return { account: publicAccount(session.account), csrfDigest: session.csrfDigest, id: session.id };
  }

  async function requireCsrf(session, csrfToken) {
    if (!tokensMatch(session.csrfDigest, csrfToken)) {
      throw new AuthError('invalid_csrf_token', 403);
    }
  }

  async function requireCurrentPassword(session, password) {
    if (typeof password !== 'string' || password.length > 128) {
      throw new AuthError('reauthentication_required', 403);
    }
    if (!await withinRateLimit('reauthenticate', session.account.id, 5, 15 * 60 * 1000)) {
      throw new AuthError('try_again_later', 429);
    }
    const account = await repository.findAccountByUsername(
      normalizeUsername(session.account.username),
    );
    if (
      !account
      || account.id !== session.account.id
      || !await passwordHasher.verify(account.passwordHash, password)
    ) {
      await recordAuthenticationEvent(
        session.account.id,
        'auth.reauthentication.failed',
      );
      throw new AuthError('reauthentication_required', 403);
    }
    await recordAuthenticationEvent(
      session.account.id,
      'auth.reauthentication.succeeded',
    );
  }

  async function createPasskeyRegistrationOptions(sessionToken, csrfToken, { currentPassword }) {
    const relyingParty = getRelyingParty();
    const session = await getSession(sessionToken);
    await requireCsrf(session, csrfToken);
    await requireCurrentPassword(session, currentPassword);
    const existingPasskeys = await repository.listPasskeys(session.account.id);
    if (existingPasskeys.length >= maximumPasskeysPerAccount) {
      throw new AuthError('passkey_limit_reached', 409);
    }
    const userId = webauthnUserId(session.account.id);
    const options = await webauthn.generateRegistrationOptions({
      attestationType: 'none',
      authenticatorSelection: {
        residentKey: 'required',
        userVerification: 'required',
      },
      excludeCredentials: existingPasskeys.map((passkey) => ({
        id: passkey.id,
        transports: passkey.transports,
      })),
      rpID: relyingParty.id,
      rpName: 'roriwalrus',
      supportedAlgorithmIDs: passkeyAlgorithmIds,
      userDisplayName: session.account.username,
      userID: userId,
      userName: session.account.username,
    });
    const challengeId = randomUUID();
    const createdAt = clock();
    await repository.createWebAuthnChallenge({
      accountId: session.account.id,
      challenge: options.challenge,
      createdAt,
      expiresAt: new Date(createdAt.getTime() + passkeyChallengeLifetimeMs),
      id: challengeId,
      purpose: 'registration',
      sessionId: session.id,
    });
    return { challengeId, options };
  }

  async function registerPasskey(
    sessionToken,
    csrfToken,
    { challengeId, credential: inputCredential, label: inputLabel },
  ) {
    const relyingParty = getRelyingParty();
    const session = await getSession(sessionToken);
    await requireCsrf(session, csrfToken);
    const label = normalizePasskeyLabel(inputLabel);
    const credential = validateCredentialResponse(inputCredential);
    if (!isCanonicalUuid(challengeId)) {
      throw new AuthError('invalid_passkey_response', 400);
    }
    const challenge = await repository.claimWebAuthnChallenge({
      accountId: session.account.id,
      id: challengeId,
      now: clock(),
      purpose: 'registration',
      sessionId: session.id,
    });
    if (!challenge) {
      throw new AuthError('passkey_challenge_expired', 410);
    }
    let verification;
    try {
      verification = await webauthn.verifyRegistrationResponse({
        expectedChallenge: challenge,
        expectedOrigin: relyingParty.origin,
        expectedRPID: relyingParty.id,
        requireUserVerification: true,
        response: credential,
        supportedAlgorithmIDs: passkeyAlgorithmIds,
      });
    } catch {
      throw new AuthError('passkey_verification_failed', 400);
    }
    if (!verification.verified || !verification.registrationInfo) {
      throw new AuthError('passkey_verification_failed', 400);
    }
    const { credential: verifiedCredential, credentialBackedUp, credentialDeviceType } = (
      verification.registrationInfo
    );
    const transports = (verifiedCredential.transports ?? [])
      .filter((transport) => passkeyTransports.has(transport));
    const createdAt = clock();
    const result = await repository.createPasskey({
      accountId: session.account.id,
      backedUp: credentialBackedUp,
      counter: verifiedCredential.counter,
      createdAt,
      deviceType: credentialDeviceType,
      id: verifiedCredential.id,
      idleTimeoutMs: sessionIdleTimeoutMs,
      label,
      sessionId: session.id,
      publicKey: verifiedCredential.publicKey,
      transports,
    });
    if (result.reason === 'session') {
      throw new AuthError('authentication_required', 401);
    }
    if (result.reason === 'limit') {
      throw new AuthError('passkey_limit_reached', 409);
    }
    if (result.reason === 'conflict') {
      throw new AuthError('passkey_already_registered', 409);
    }
    return publicPasskey(result.passkey);
  }

  async function listPasskeys(sessionToken) {
    const session = await getSession(sessionToken);
    return (await repository.listPasskeys(session.account.id)).map(publicPasskey);
  }

  async function removePasskey(sessionToken, csrfToken, credentialId, { currentPassword }) {
    const session = await getSession(sessionToken);
    await requireCsrf(session, csrfToken);
    await requireCurrentPassword(session, currentPassword);
    if (!passkeyCredentialIdPattern.test(credentialId ?? '')) {
      throw new AuthError('invalid_passkey', 400);
    }
    const result = await repository.removePasskey({
      accountId: session.account.id,
      credentialId,
      currentSessionId: session.id,
      removedAt: clock(),
    });
    if (!result) {
      throw new AuthError('passkey_not_found', 404);
    }
    return result;
  }

  async function renamePasskey(
    sessionToken,
    csrfToken,
    credentialId,
    { currentPassword, label: inputLabel },
  ) {
    const session = await getSession(sessionToken);
    await requireCsrf(session, csrfToken);
    await requireCurrentPassword(session, currentPassword);
    if (!passkeyCredentialIdPattern.test(credentialId ?? '')) {
      throw new AuthError('invalid_passkey', 400);
    }
    const label = normalizePasskeyLabel(inputLabel);
    const passkey = await repository.renamePasskey({
      accountId: session.account.id,
      credentialId,
      label,
      renamedAt: clock(),
    });
    if (!passkey) {
      throw new AuthError('passkey_not_found', 404);
    }
    return publicPasskey(passkey);
  }

  async function requirePostingAllowed(account, { detectFlood = false } = {}) {
    if (isAdministrator(account) || account.role === 'moderator') {
      return;
    }
    if (
      detectFlood
      && !await withinRateLimit('content_burst', account.id, 5, 10_000)
    ) {
      throw new AuthError('posting_flood_detected', 429, { retryAfterMs: 10_000 });
    }
    if (!await withinRateLimit('content_rate', account.id, 30, 60_000)) {
      throw new AuthError('posting_rate_limited', 429, { retryAfterMs: 60_000 });
    }
    if (!account.slowdownMs) {
      return;
    }
    if (!await withinRateLimit('content_post', account.id, 1, account.slowdownMs)) {
      throw new AuthError('posting_slowdown', 429, { retryAfterMs: account.slowdownMs });
    }
  }

  function requireForumPostingEnabled(account) {
    if (account.forumPostingMuted) {
      throw new AuthError('forum_posting_muted', 403);
    }
  }

  async function requireForumPostingAllowed(account) {
    requireForumPostingEnabled(account);
    await requirePostingAllowed(account, { detectFlood: true });
  }

  async function requireTopicCreationAllowed(account) {
    await requireForumPostingAllowed(account);
    if (isAdministrator(account) || account.role === 'moderator') {
      return;
    }
    if (!await withinRateLimit('topic_create', account.id, 1, topicCreationWindowMs)) {
      throw new AuthError('topic_creation_limited', 429, {
        retryAfterMs: topicCreationWindowMs,
      });
    }
  }

  async function requireShoutboxPostingAllowed(account) {
    if (account.shoutboxPostingMuted) {
      throw new AuthError('shoutbox_posting_muted', 403);
    }
    await requirePostingAllowed(account, { detectFlood: true });
  }

  async function logout(sessionToken, csrfToken) {
    const session = await getSession(sessionToken);
    await requireCsrf(session, csrfToken);
    await repository.revokeSession(digestToken(sessionToken), clock(), session.account.id);
  }

  async function listSessions(sessionToken) {
    const session = await getSession(sessionToken);
    return repository.listSessions(
      session.account.id,
      session.id,
      clock(),
      sessionIdleTimeoutMs,
    );
  }

  async function revokeAccountSession(sessionToken, csrfToken, sessionId) {
    const session = await getSession(sessionToken);
    await requireCsrf(session, csrfToken);
    if (!isCanonicalUuid(sessionId)) {
      throw new AuthError('invalid_session', 400);
    }
    const normalizedSessionId = String(sessionId).toLowerCase();
    const revoked = await repository.revokeAccountSession(
      session.account.id,
      normalizedSessionId,
      clock(),
    );
    if (!revoked) {
      throw new AuthError('session_not_found', 404);
    }
    return { current: session.id === normalizedSessionId };
  }

  async function logoutAll(sessionToken, csrfToken) {
    const session = await getSession(sessionToken);
    await requireCsrf(session, csrfToken);
    return repository.revokeAllSessions(session.account.id, clock());
  }

  async function listNotifications(sessionToken, query = {}) {
    const session = await getSession(sessionToken);
    const limit = parseNotificationQueryValue(
      query.limit,
      defaultNotificationLimit,
      maximumNotificationLimit,
    );
    const offset = parseNotificationQueryValue(query.offset, 0, Number.MAX_SAFE_INTEGER);
    if (limit === 0) {
      throw new AuthError('invalid_notification_query', 400);
    }
    const [notifications, unreadCount] = await Promise.all([
      repository.listNotifications(session.account.id, limit + 1, offset),
      repository.countUnreadNotifications(session.account.id),
    ]);
    return {
      hasMore: notifications.length > limit,
      notifications: notifications.slice(0, limit).map(publicNotification),
      nextOffset: offset + Math.min(notifications.length, limit),
      unreadCount,
    };
  }

  async function setNotificationRead(sessionToken, csrfToken, notificationId, read) {
    const session = await getSession(sessionToken);
    await requireCsrf(session, csrfToken);
    const id = normalizeDatabaseId(notificationId);
    if (!id || typeof read !== 'boolean') {
      throw new AuthError('invalid_notification', 400);
    }

    const notification = await repository.setNotificationRead({
      accountId: session.account.id,
      notificationId: id,
      read,
      updatedAt: clock(),
    });
    if (!notification) {
      throw new AuthError('notification_not_found', 404);
    }
    return publicNotification(notification);
  }

  async function markAllNotificationsRead(sessionToken, csrfToken) {
    const session = await getSession(sessionToken);
    await requireCsrf(session, csrfToken);
    const updatedCount = await repository.markAllNotificationsRead({
      accountId: session.account.id,
      updatedAt: clock(),
    });
    return { updatedCount };
  }

  async function requestPasswordReset(inputEmail) {
    const email = normalizeEmail(inputEmail);
    if (email.length > 254 || !emailPattern.test(email)) {
      return;
    }
    if (!await withinRateLimit('password_reset', email, 3, 60 * 60 * 1000)) {
      return;
    }

    const account = await repository.findAccountByEmail(email);
    if (!account?.emailVerifiedAt || account.membershipStatus !== 'active' || account.deletedAt) {
      return;
    }

    const token = randomToken();
    const expiresAt = new Date(clock().getTime() + resetLifetimeMs);
    await repository.replacePasswordResetToken(account.id, digestToken(token), expiresAt);
    await mailer.sendPasswordReset({
      email: account.email,
      url: `${publicOrigin}/account#reset=${encodeURIComponent(token)}`,
    });
  }

  async function resendVerification(inputEmail) {
    const email = normalizeEmail(inputEmail);
    if (email.length > 254 || !emailPattern.test(email)) {
      return;
    }
    if (!await withinRateLimit('register', email, 3, 60 * 60 * 1000)) {
      return;
    }

    const account = await repository.findAccountByEmail(email);
    if (!canVerifyAccount(account)) {
      return;
    }
    await issueVerification(account);
  }

  async function resetPassword({ password, token }) {
    validatePassword(password);
    if (!isValidOneTimeToken(token)) {
      throw new AuthError('invalid_token', 400);
    }

    const passwordHash = await passwordHasher.hash(password);
    const reset = await repository.consumePasswordResetToken({
      passwordHash,
      tokenDigest: digestToken(token),
      usedAt: clock(),
    });
    if (!reset) {
      throw new AuthError('invalid_token', 400);
    }
  }

  async function updatePreferences(sessionToken, csrfToken, input) {
    const session = await getSession(sessionToken);
    await requireCsrf(session, csrfToken);
    const preferences = {
      colorScheme: input.colorScheme,
      fontSize: input.fontSize,
      fontTypeface: input.fontTypeface,
      shoutboxEnabled: input.shoutboxEnabled,
      shoutboxHeightLines: input.shoutboxHeightLines
        ?? session.account.preferences.shoutboxHeightLines,
      shoutboxMuted: input.shoutboxMuted,
      shoutboxOrder: input.shoutboxOrder ?? session.account.preferences.shoutboxOrder,
      statusAndActivityVisible: input.statusAndActivityVisible
        ?? session.account.preferences.statusAndActivityVisible,
      theme: input.theme,
      timeZone: input.timeZone,
    };

    let validTimeZone = preferences.timeZone === 'local';
    if (
      preferences.timeZone !== 'local'
      && typeof preferences.timeZone === 'string'
      && preferences.timeZone.length <= 100
      && /^[A-Za-z][A-Za-z0-9._+-]*(\/[A-Za-z0-9._+-]+)*$/.test(preferences.timeZone)
    ) {
      try {
        new Intl.DateTimeFormat('en-US', { timeZone: preferences.timeZone }).format();
        validTimeZone = true;
      } catch {
        validTimeZone = false;
      }
    }

    if (
      !['green', 'blue', 'tan', 'red', 'black', 'gray'].includes(preferences.colorScheme)
      || !['compact', 'standard', 'comfortable', 'large', 'extra-large'].includes(
        preferences.fontSize,
      )
      || !['verdana', 'trebuchet', 'georgia', 'monospace'].includes(
        preferences.fontTypeface,
      )
      || !['system', 'light', 'dark'].includes(preferences.theme)
      || typeof preferences.shoutboxEnabled !== 'boolean'
      || !Number.isInteger(preferences.shoutboxHeightLines)
      || preferences.shoutboxHeightLines < 7
      || preferences.shoutboxHeightLines > 60
      || typeof preferences.shoutboxMuted !== 'boolean'
      || !['oldest-first', 'newest-first'].includes(preferences.shoutboxOrder)
      || typeof preferences.statusAndActivityVisible !== 'boolean'
      || !validTimeZone
    ) {
      throw new AuthError('invalid_preferences', 400);
    }

    const account = await repository.updatePreferences(session.account.id, preferences);
    return publicAccount(account).preferences;
  }

  async function getAvatar(viewerId, accountId) {
    return repository.getAvatar(viewerId, accountId);
  }

  async function updateAvatar(sessionToken, csrfToken, data) {
    const session = await getSession(sessionToken);
    await requireCsrf(session, csrfToken);
    const avatar = await avatarProcessor.validate(data);
    const account = await repository.updateAvatar({
      accountId: session.account.id,
      contentType: avatar.contentType,
      data: avatar.data,
      updatedAt: clock(),
    });
    return publicAccount(account);
  }

  return {
    createPasskeyAuthenticationOptions,
    createPasskeyRegistrationOptions,
    getAvatar,
    getSession,
    listPasskeys,
    listSessions,
    listNotifications,
    login,
    loginWithPasskey,
    logout,
    logoutAll,
    markAllNotificationsRead,
    register,
    registerPasskey,
    removePasskey,
    renamePasskey,
    requireCsrf,
    requireCurrentPassword,
    requireForumPostingAllowed,
    requireForumPostingEnabled,
    requirePostingAllowed,
    requireShoutboxPostingAllowed,
    requireTopicCreationAllowed,
    requestPasswordReset,
    resendVerification,
    resetPassword,
    revokeAccountSession,
    setNotificationRead,
    updatePreferences,
    updateAvatar,
    verifyEmail,
  };
}