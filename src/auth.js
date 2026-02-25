/**
 * Auth module: JWT + Refresh token, bcrypt
 */
const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");
const { getPool, sql } = require("./db");

const JWT_SECRET = process.env.JWT_SECRET || "mps-erp-secret-change-in-production";
const JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || "mps-erp-refresh-secret-change-in-production";
const ACCESS_TOKEN_EXPIRY = process.env.JWT_ACCESS_EXPIRY || "15m";
const REFRESH_TOKEN_EXPIRY = process.env.JWT_REFRESH_EXPIRY || "7d";

const SALT_ROUNDS = 10;

async function hashPassword(plain) {
  return bcrypt.hash(plain, SALT_ROUNDS);
}

async function verifyPassword(plain, hash) {
  return bcrypt.compare(plain, hash);
}

function generateAccessToken(user) {
  return jwt.sign(
    { userId: user.UserId, username: user.Username },
    JWT_SECRET,
    { expiresIn: ACCESS_TOKEN_EXPIRY }
  );
}

function generateRefreshToken(user) {
  return jwt.sign(
    { userId: user.UserId, type: "refresh" },
    JWT_REFRESH_SECRET,
    { expiresIn: REFRESH_TOKEN_EXPIRY }
  );
}

function verifyAccessToken(token) {
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch {
    return null;
  }
}

function verifyRefreshToken(token) {
  try {
    return jwt.verify(token, JWT_REFRESH_SECRET);
  } catch {
    return null;
  }
}

/**
 * Middleware: verify JWT access token, attach req.user
 */
async function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization;
  const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;

  if (!token) {
    return res.status(401).json({ error: "Unauthorized", code: "NO_TOKEN" });
  }

  const payload = verifyAccessToken(token);
  if (!payload) {
    return res.status(401).json({ error: "Token expired or invalid", code: "INVALID_TOKEN" });
  }

  try {
    const pool = await getPool();
    const result = await pool
      .request()
      .input("userId", sql.Int, payload.userId)
      .query(`
        SELECT u.UserId, u.Username, u.FullName, u.Email, u.Phone, u.DeptId, u.IsActive,
               d.DeptName
        FROM Users u
        LEFT JOIN Department d ON d.DeptId = u.DeptId
        WHERE u.UserId = @userId AND u.IsActive = 1
      `);
    if (!result.recordset.length) {
      return res.status(401).json({ error: "User not found or inactive", code: "USER_INVALID" });
    }
    req.user = result.recordset[0];
    next();
  } catch (err) {
    console.error("[Auth] Middleware error:", err);
    res.status(500).json({ error: "Auth error" });
  }
}

/**
 * Optional auth: attach user if token valid, else req.user = null
 */
async function optionalAuthMiddleware(req, res, next) {
  const authHeader = req.headers.authorization;
  const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
  req.user = null;

  if (!token) return next();

  const payload = verifyAccessToken(token);
  if (!payload) return next();

  try {
    const pool = await getPool();
    const result = await pool
      .request()
      .input("userId", sql.Int, payload.userId)
      .query(`
        SELECT u.UserId, u.Username, u.FullName, u.Email, u.Phone, u.DeptId, u.IsActive
        FROM Users u WHERE u.UserId = @userId AND u.IsActive = 1
      `);
    if (result.recordset.length) req.user = result.recordset[0];
  } catch (_) {}
  next();
}

/**
 * Check if user has permission (module.action)
 */
async function hasPermission(userId, permissionCode) {
  try {
    const pool = await getPool();
    const result = await pool
      .request()
      .input("userId", sql.Int, userId)
      .input("permCode", sql.NVarChar, permissionCode)
      .query(`
        SELECT 1
        FROM UserRoles ur
        JOIN RolePermissions rp ON rp.RoleId = ur.RoleId
        JOIN Permissions p ON p.PermissionId = rp.PermissionId
        WHERE ur.UserId = @userId AND p.PermissionCode = @permCode
      `);
    return result.recordset.length > 0;
  } catch {
    return false;
  }
}

/**
 * Middleware: require permission
 */
function requirePermission(permissionCode) {
  return async (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: "Unauthorized", code: "NO_TOKEN" });
    }
    const allowed = await hasPermission(req.user.UserId, permissionCode);
    if (!allowed) {
      return res.status(403).json({ error: "Forbidden", code: "NO_PERMISSION" });
    }
    next();
  };
}

/**
 * Ensure admin user exists (for first run)
 */
async function ensureAdminUser() {
  try {
    const pool = await getPool();
    const count = await pool.request().query("SELECT COUNT(*) AS c FROM Users");
    if (count.recordset[0].c > 0) return;

    const hash = await hashPassword("admin123");
    await pool
      .request()
      .input("username", sql.NVarChar, "admin")
      .input("hash", sql.NVarChar, hash)
      .input("fullName", sql.NVarChar, "Administrator")
      .input("email", sql.NVarChar, "admin@admin.com")
      .query(`
        INSERT INTO Users (Username, PasswordHash, FullName, Email, IsActive)
        VALUES (@username, @hash, @fullName, @email, 1)
      `);
    const admin = await pool.request().query("SELECT UserId FROM Users WHERE Username = 'admin'");
    const adminId = admin.recordset[0].UserId;
    await pool.request().input("userId", sql.Int, adminId).input("roleId", sql.Int, 1).query(`
      INSERT INTO UserRoles (UserId, RoleId) VALUES (@userId, @roleId)
    `);
    console.log("[Auth] Admin user created (admin/admin123)");
  } catch (err) {
    console.error("[Auth] ensureAdminUser error:", err);
  }
}

module.exports = {
  hashPassword,
  verifyPassword,
  generateAccessToken,
  generateRefreshToken,
  verifyAccessToken,
  verifyRefreshToken,
  authMiddleware,
  optionalAuthMiddleware,
  hasPermission,
  requirePermission,
  ensureAdminUser,
};
