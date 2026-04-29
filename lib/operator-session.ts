import {
  ACCOUNT_NAME_MAX_LENGTH,
  ADMIN_USERNAME,
  PASSWORD_MAX_LENGTH,
} from "@/lib/account-rules";
import { OPERATOR_COOKIE_NAME, SYSTEM_USER_NAME } from "@/lib/fee-type-config";
import { prisma } from "@/lib/prisma";
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";

const ADMIN_PASSWORD = "1234";
const AUTH_COOKIE_NAME = "fee_type_auth";
const AUTH_COOKIE_VALUE = "authenticated";
const DIGIT_PASSWORD_PATTERN = /^\d{1,8}$/;

type AccountActionResult =
  | {
      success: true;
      username: string;
    }
  | {
      success: false;
      error: string;
      status: number;
    };

function getCookieOptions() {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 60 * 24 * 30,
  };
}

function getCharacterLength(value: string) {
  return Array.from(value).length;
}

function normalizeUsername(input: string | null | undefined) {
  return input?.trim() ?? "";
}

function normalizePassword(input: string | null | undefined) {
  return input?.trim() ?? "";
}

function validateCredentials(username: string, password: string) {
  if (!username) {
    return "请输入账户名。";
  }

  if (getCharacterLength(username) > ACCOUNT_NAME_MAX_LENGTH) {
    return `账户名长度不能超过 ${ACCOUNT_NAME_MAX_LENGTH} 位。`;
  }

  if (!DIGIT_PASSWORD_PATTERN.test(password)) {
    return `密码仅支持 ${PASSWORD_MAX_LENGTH} 位以内数字。`;
  }

  return null;
}

function hashPassword(password: string) {
  const salt = randomBytes(16).toString("hex");
  const hashedPassword = scryptSync(password, salt, 64).toString("hex");

  return `${salt}:${hashedPassword}`;
}

function verifyPassword(password: string, storedPasswordHash: string) {
  const [salt, storedHash] = storedPasswordHash.split(":");

  if (!salt || !storedHash) {
    return false;
  }

  const calculatedHash = scryptSync(password, salt, 64).toString("hex");

  return timingSafeEqual(
    Buffer.from(storedHash, "hex"),
    Buffer.from(calculatedHash, "hex"),
  );
}

export function normalizeOperatorName(input: string | null | undefined) {
  const value = normalizeUsername(input);

  if (!value) {
    return SYSTEM_USER_NAME;
  }

  return Array.from(value).slice(0, 32).join("");
}

export async function authenticateUser(
  username: string | null | undefined,
  password: string | null | undefined,
): Promise<AccountActionResult> {
  const normalizedUsername = normalizeUsername(username);
  const normalizedPassword = normalizePassword(password);
  const validationError = validateCredentials(normalizedUsername, normalizedPassword);

  if (validationError) {
    return {
      success: false,
      error: validationError,
      status: 400,
    };
  }

  if (
    normalizedUsername === ADMIN_USERNAME &&
    normalizedPassword === ADMIN_PASSWORD
  ) {
    return {
      success: true,
      username: ADMIN_USERNAME,
    };
  }

  const account = await prisma.userAccount.findUnique({
    where: {
      username: normalizedUsername,
    },
  });

  if (!account || !verifyPassword(normalizedPassword, account.passwordHash)) {
    return {
      success: false,
      error: "账户名或密码错误。",
      status: 401,
    };
  }

  return {
    success: true,
    username: account.username,
  };
}

export async function registerUser(
  username: string | null | undefined,
  password: string | null | undefined,
): Promise<AccountActionResult> {
  const normalizedUsername = normalizeUsername(username);
  const normalizedPassword = normalizePassword(password);
  const validationError = validateCredentials(normalizedUsername, normalizedPassword);

  if (validationError) {
    return {
      success: false,
      error: validationError,
      status: 400,
    };
  }

  if (normalizedUsername === ADMIN_USERNAME) {
    return {
      success: false,
      error: "admin 为系统保留账号，请更换账户名。",
      status: 400,
    };
  }

  const existingAccount = await prisma.userAccount.findUnique({
    where: {
      username: normalizedUsername,
    },
  });

  if (existingAccount) {
    return {
      success: false,
      error: "该账户名已存在，请直接登录。",
      status: 409,
    };
  }

  await prisma.userAccount.create({
    data: {
      username: normalizedUsername,
      passwordHash: hashPassword(normalizedPassword),
    },
  });

  return {
    success: true,
    username: normalizedUsername,
  };
}

export async function isAuthenticated() {
  const cookieStore = await cookies();
  const authCookie = cookieStore.get(AUTH_COOKIE_NAME)?.value;
  const operatorName = normalizeUsername(cookieStore.get(OPERATOR_COOKIE_NAME)?.value);

  return authCookie === AUTH_COOKIE_VALUE && Boolean(operatorName);
}

export async function getOperatorNameFromSession() {
  const cookieStore = await cookies();
  const authenticated = await isAuthenticated();

  if (!authenticated) {
    return SYSTEM_USER_NAME;
  }

  return normalizeOperatorName(cookieStore.get(OPERATOR_COOKIE_NAME)?.value);
}

export async function getSessionUsername() {
  const authenticated = await isAuthenticated();

  if (!authenticated) {
    return null;
  }

  const cookieStore = await cookies();
  return normalizeUsername(cookieStore.get(OPERATOR_COOKIE_NAME)?.value);
}

export async function createSession(username: string) {
  const cookieStore = await cookies();
  const options = getCookieOptions();

  cookieStore.set(AUTH_COOKIE_NAME, AUTH_COOKIE_VALUE, options);
  cookieStore.set(OPERATOR_COOKIE_NAME, normalizeOperatorName(username), options);
}

export async function clearSession() {
  const cookieStore = await cookies();
  cookieStore.delete(AUTH_COOKIE_NAME);
  cookieStore.delete(OPERATOR_COOKIE_NAME);
}
