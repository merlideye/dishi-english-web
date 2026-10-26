import {
  FALLBACK_ITERATIONS,
  pbkdf2Sha256,
} from "./password.js";

const ACCOUNT_STORE_KEY = "danshi-accounts-v1";
const FIRST_ACCOUNT_STORAGE_KEY = "legacy";
const ADMIN_ITERATIONS = 210_000;

function newId() {
  if (crypto.randomUUID) {
    return `account-${crypto.randomUUID()}`;
  }
  return `account-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function readState() {
  try {
    const stored = JSON.parse(localStorage.getItem(ACCOUNT_STORE_KEY));
    if (stored && Array.isArray(stored.accounts)) {
      return {
        version: 1,
        accounts: stored.accounts,
        activeAccountId: stored.activeAccountId || null,
        admin: stored.admin || null,
      };
    }
  } catch {
    // A broken local record should not prevent the account screen from loading.
  }
  return {
    version: 1,
    accounts: [],
    activeAccountId: null,
    admin: null,
  };
}

function writeState(state) {
  localStorage.setItem(ACCOUNT_STORE_KEY, JSON.stringify(state));
  return state;
}

function bytesToBase64(bytes) {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

function base64ToBytes(value) {
  return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
}

async function derivePasswordHash(password, salt, iterations = ADMIN_ITERATIONS) {
  if (!globalThis.crypto?.subtle) {
    return pbkdf2Sha256(password, salt, iterations);
  }
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      hash: "SHA-256",
      salt,
      iterations,
    },
    keyMaterial,
    256,
  );
  return new Uint8Array(bits);
}

function hashesMatch(left, right) {
  if (left.length !== right.length) {
    return false;
  }
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left[index] ^ right[index];
  }
  return difference === 0;
}

export function normalizeAccountName(value) {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 24);
}

export function listAccounts() {
  return [...readState().accounts].sort((left, right) =>
    String(left.createdAt).localeCompare(String(right.createdAt)),
  );
}

export function getActiveAccount() {
  const state = readState();
  return (
    state.accounts.find((account) => account.id === state.activeAccountId) ||
    null
  );
}

export function selectAccount(accountId) {
  const state = readState();
  const account = state.accounts.find((item) => item.id === accountId);
  if (!account) {
    throw new Error("账号不存在。");
  }
  account.lastOpenedAt = new Date().toISOString();
  state.activeAccountId = account.id;
  writeState(state);
  return account;
}

export function clearActiveAccount() {
  const state = readState();
  state.activeAccountId = null;
  writeState(state);
}

function validateNewAccountName(name) {
  const normalized = normalizeAccountName(name);
  if (!normalized) {
    throw new Error("请输入账号名称。");
  }
  const duplicate = readState().accounts.some(
    (account) => account.name.toLocaleLowerCase("zh-CN") ===
      normalized.toLocaleLowerCase("zh-CN"),
  );
  if (duplicate) {
    throw new Error("这个账号名称已经存在。");
  }
  return normalized;
}

export function createAccount(name) {
  const state = readState();
  const normalized = validateNewAccountName(name);
  const account = {
    id: newId(),
    name: normalized,
    storageKey:
      state.accounts.length === 0 ? FIRST_ACCOUNT_STORAGE_KEY : newId(),
    createdAt: new Date().toISOString(),
  };
  state.accounts.push(account);
  writeState(state);
  return account;
}

export async function saveAdminPassword(password) {
  if (String(password ?? "").length < 6) {
    throw new Error("管理员密码至少需要 6 个字符。");
  }
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iterations = globalThis.crypto?.subtle
    ? ADMIN_ITERATIONS
    : FALLBACK_ITERATIONS;
  const hash = await derivePasswordHash(password, salt, iterations);
  const state = readState();
  state.admin = {
    algorithm: "PBKDF2-SHA-256",
    iterations,
    salt: bytesToBase64(salt),
    hash: bytesToBase64(hash),
    updatedAt: new Date().toISOString(),
  };
  writeState(state);
}

export async function setupFirstAccount({ name, adminPassword }) {
  if (listAccounts().length) {
    throw new Error("账号已经完成初始化。");
  }
  await saveAdminPassword(adminPassword);
  const account = createAccount(name);
  selectAccount(account.id);
  return account;
}

export function isAdminConfigured() {
  return Boolean(readState().admin);
}

export async function verifyAdminPassword(password) {
  const admin = readState().admin;
  if (!admin) {
    throw new Error("尚未设置管理员密码。");
  }
  const salt = base64ToBytes(admin.salt);
  const expected = base64ToBytes(admin.hash);
  const actual = await derivePasswordHash(
    String(password ?? ""),
    salt,
    admin.iterations,
  );
  return hashesMatch(actual, expected);
}

export async function changeAdminPassword(currentPassword, newPassword) {
  const verified = await verifyAdminPassword(currentPassword);
  if (!verified) {
    throw new Error("当前管理员密码不正确。");
  }
  if (currentPassword === newPassword) {
    throw new Error("新密码不能与当前密码相同。");
  }
  await saveAdminPassword(newPassword);
}

export function accountInitial(name) {
  return Array.from(normalizeAccountName(name) || "学")[0].toUpperCase();
}
