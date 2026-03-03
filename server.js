require("dotenv").config();
const path = require("path");
const express = require("express");
const cors = require("cors");
const multer = require("multer");
const xlsx = require("xlsx");
const http = require("http");
const { Server } = require("socket.io");
const { getPool, sql } = require("./src/db");
const auth = require("./src/auth");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
  },
});

io.on("connection", (socket) => {
  console.log("[Socket] client connected:", socket.id);
  socket.on("disconnect", () => {
    console.log("[Socket] client disconnected:", socket.id);
  });
});

// Limits for Excel import to reduce DoS surface
const MAX_IMPORT_FILE_SIZE = 2 * 1024 * 1024; // 2 MB
const MAX_IMPORT_ROWS = 5000;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: MAX_IMPORT_FILE_SIZE,
  },
});
app.use(cors());
app.use(express.json());
app.use(express.static(__dirname)); // serve root static files
app.use("/modules", express.static(path.join(__dirname, "modules")));

// Auth middleware: protect /api/* except login & refresh
app.use("/api", (req, res, next) => {
  if (req.path === "/auth/login" || req.path === "/auth/refresh") return next();
  return auth.authMiddleware(req, res, next);
});

const parseIntSafe = (v) =>
  v === undefined || v === null || v === "" ? null : parseInt(v, 10);

/** Ghi log thao tác vào ActivityLog. Bỏ qua lỗi nếu bảng chưa có. */
async function logActivity(pool, req, opts = {}) {
  const { menuCode, menuId, action, entityType, entityId, entitySummary, details } = opts;
  if (!action || !entityType) return;
  const user = req?.user;
  const userId = user?.UserId ?? null;
  const userName = user?.FullName || user?.Username || null;
  try {
    const r = pool.request()
      .input("userId", sql.Int, userId)
      .input("userName", sql.NVarChar, userName)
      .input("action", sql.NVarChar, action.toUpperCase().slice(0, 20))
      .input("entityType", sql.NVarChar, (entityType || "").slice(0, 50))
      .input("entityId", sql.NVarChar, entityId != null ? String(entityId).slice(0, 50) : null)
      .input("entitySummary", sql.NVarChar, (entitySummary || "").slice(0, 500))
      .input("details", sql.NVarChar(sql.MAX), details || null);
    let menuIdVal = menuId;
    if (!menuIdVal && menuCode) {
      const m = await pool.request().input("code", sql.NVarChar, menuCode).query("SELECT MenuId FROM Menus WHERE MenuCode = @code");
      menuIdVal = m.recordset?.[0]?.MenuId ?? null;
    }
    r.input("menuId", sql.Int, menuIdVal);
    await r.query(`INSERT INTO ActivityLog (UserId, UserName, MenuId, Action, EntityType, EntityId, EntitySummary, Details) 
      VALUES (@userId, @userName, @menuId, @action, @entityType, @entityId, @entitySummary, @details)`);
  } catch (e) {
    if (!/Invalid object name|ActivityLog|Menus/i.test(e.message || "")) console.warn("[logActivity]", e.message);
  }
}

/** Chuyển giá trị ngày từ DB (Date object hoặc string) sang YYYY-MM-DD. Tránh lỗi String(date).slice(0,10) cho "Fri Feb 27". */
const toDateString = (val) => {
  if (!val) return null;
  if (val instanceof Date) {
    return `${val.getFullYear()}-${String(val.getMonth() + 1).padStart(2, "0")}-${String(val.getDate()).padStart(2, "0")}`;
  }
  const s = String(val);
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  return null;
};

// -------- Auth (public) ----------
app.post("/api/auth/login", async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: "Username and password required" });
  }
  try {
    const pool = await getPool();
    const result = await pool
      .request()
      .input("username", sql.NVarChar, username)
      .query(`
        SELECT UserId, Username, PasswordHash, FullName, Email, Phone, DeptId, IsActive
        FROM Users WHERE Username = @username AND IsActive = 1
      `);
    if (!result.recordset.length) {
      return res.status(401).json({ error: "Invalid username or password" });
    }
    const user = result.recordset[0];
    const valid = await auth.verifyPassword(password, user.PasswordHash);
    if (!valid) {
      return res.status(401).json({ error: "Invalid username or password" });
    }
    const accessToken = auth.generateAccessToken(user);
    const refreshToken = auth.generateRefreshToken(user);
    await pool
      .request()
      .input("userId", sql.Int, user.UserId)
      .input("token", sql.NVarChar, refreshToken)
      .input("expiresAt", sql.DateTime2, new Date(Date.now() + 7 * 24 * 60 * 60 * 1000))
      .query(`
        INSERT INTO RefreshTokens (UserId, Token, ExpiresAt) VALUES (@userId, @token, @expiresAt)
      `);
    const perms = await pool
      .request()
      .input("userId", sql.Int, user.UserId)
      .query(`
        SELECT p.PermissionCode FROM UserRoles ur
        JOIN RolePermissions rp ON rp.RoleId = ur.RoleId
        JOIN Permissions p ON p.PermissionId = rp.PermissionId
        WHERE ur.UserId = @userId
      `);
    const roles = await pool
      .request()
      .input("userId", sql.Int, user.UserId)
      .query(`SELECT r.RoleCode FROM UserRoles ur JOIN Roles r ON r.RoleId = ur.RoleId WHERE ur.UserId = @userId`);
    let permCodes = (perms.recordset || []).map((p) => p.PermissionCode);
    if ((roles.recordset || []).some((r) => r.RoleCode === "admin")) permCodes = ["admin", ...permCodes];
    res.json({
      accessToken,
      refreshToken,
      expiresIn: 900,
      user: {
        id: user.UserId,
        username: user.Username,
        fullName: user.FullName,
        email: user.Email,
        phone: user.Phone,
        deptId: user.DeptId,
      },
      permissions: permCodes,
    });
  } catch (err) {
    console.error("[Auth] Login error:", err);
    res.status(500).json({ error: "Login failed" });
  }
});

app.post("/api/auth/refresh", async (req, res) => {
  const { refreshToken } = req.body || {};
  if (!refreshToken) return res.status(400).json({ error: "Refresh token required" });
  const payload = auth.verifyRefreshToken(refreshToken);
  if (!payload) return res.status(401).json({ error: "Invalid or expired refresh token" });
  try {
    const pool = await getPool();
    const tokenRow = await pool
      .request()
      .input("token", sql.NVarChar, refreshToken)
      .query(`
        SELECT rt.UserId, u.Username, u.FullName, u.Email, u.Phone, u.DeptId
        FROM RefreshTokens rt
        JOIN Users u ON u.UserId = rt.UserId
        WHERE rt.Token = @token AND rt.RevokedAt IS NULL AND rt.ExpiresAt > SYSDATETIME()
      `);
    if (!tokenRow.recordset.length) {
      return res.status(401).json({ error: "Refresh token invalid or revoked" });
    }
    const user = tokenRow.recordset[0];
    const accessToken = auth.generateAccessToken(user);
    res.json({ accessToken, expiresIn: 900 });
  } catch (err) {
    console.error("[Auth] Refresh error:", err);
    res.status(500).json({ error: "Refresh failed" });
  }
});

app.get("/api/auth/me", auth.authMiddleware, async (req, res) => {
  try {
    const pool = await getPool();
    const perms = await pool
      .request()
      .input("userId", sql.Int, req.user.UserId)
      .query(`
        SELECT p.PermissionCode FROM UserRoles ur
        JOIN RolePermissions rp ON rp.RoleId = ur.RoleId
        JOIN Permissions p ON p.PermissionId = rp.PermissionId
        WHERE ur.UserId = @userId
      `);
    const roles = await pool
      .request()
      .input("userId", sql.Int, req.user.UserId)
      .query(`SELECT r.RoleCode FROM UserRoles ur JOIN Roles r ON r.RoleId = ur.RoleId WHERE ur.UserId = @userId`);
    let permCodes = (perms.recordset || []).map((p) => p.PermissionCode);
    if ((roles.recordset || []).some((r) => r.RoleCode === "admin")) permCodes = ["admin", ...permCodes];
    res.json({
      user: {
        id: req.user.UserId,
        username: req.user.Username,
        fullName: req.user.FullName,
        email: req.user.Email,
        phone: req.user.Phone,
        deptId: req.user.DeptId,
        deptName: req.user.DeptName,
      },
      permissions: permCodes,
    });
  } catch (err) {
    res.status(500).json({ error: "Failed to get user" });
  }
});

// -------- Products ----------
app.get("/api/products", auth.requirePermission("product.view"), async (_req, res) => {
  try {
    const pool = await getPool();
    const result = await pool.request().query(
      `SELECT ProductId AS id,
                ProductCode AS code,
                ProductName AS name,
                LeadTimeWeeks AS leadTimeWeeks,
                ImageUrl
         FROM Products
         ORDER BY ProductCode`
    );
    res.json(result.recordset);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch products" });
  }
});

// -------- Materials by product (via BOM) ----------
app.get("/api/materials", auth.requirePermission("product.view"), async (req, res) => {
  const productId = parseIntSafe(req.query.productId);
  if (!productId)
    return res.status(400).json({ error: "productId is required" });
  try {
    const pool = await getPool();
    const request = pool.request().input("productId", sql.Int, productId);
    let result;
    try {
      result = await request.query(`
        SELECT m.MaterialId AS id, m.MaterialCode AS code, m.MaterialName AS name, b.ConsumePerUnit AS consume,
               ISNULL(m.SafetyStockQty, 0) AS safetyStockQty
        FROM BomLines b
        JOIN Materials m ON m.MaterialId = b.MaterialId
        WHERE b.ProductId = @productId
        ORDER BY m.MaterialCode
      `);
    } catch (colErr) {
      // Cột SafetyStockQty chưa tồn tại - chạy fix_safety_stock.sql
      if (colErr.message && /SafetyStockQty|Invalid column name/i.test(colErr.message)) {
        result = await pool.request().input("productId", sql.Int, productId).query(`
          SELECT m.MaterialId AS id, m.MaterialCode AS code, m.MaterialName AS name, b.ConsumePerUnit AS consume
          FROM BomLines b
          JOIN Materials m ON m.MaterialId = b.MaterialId
          WHERE b.ProductId = @productId
          ORDER BY m.MaterialCode
        `);
        result.recordset = result.recordset.map((r) => ({ ...r, safetyStockQty: 0 }));
      } else throw colErr;
    }
    res.json(result.recordset);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch materials" });
  }
});

// -------- BOM (Thiết kế BOM) - list products, BOM chi tiết, CRUD ----------
app.get("/api/bom/products", auth.requirePermission("product.view"), async (req, res) => {
  const page = Math.max(1, parseIntSafe(req.query.page) || 1);
  const limit = Math.min(100, Math.max(1, parseIntSafe(req.query.limit) || 20));
  const search = (req.query.search || req.query.q || "").trim();
  const offset = (page - 1) * limit;
  try {
    const pool = await getPool();
    const countReq = pool.request();
    if (search) countReq.input("like", sql.NVarChar, `%${search}%`);
    const countResult = await countReq.query(`
      SELECT COUNT(*) AS total FROM Products p
      WHERE ${search ? "(p.ProductCode LIKE @like OR p.ProductName LIKE @like)" : "1=1"}
    `);
    const total = countResult.recordset[0]?.total || 0;
    const dataReq = pool.request().input("limit", sql.Int, limit).input("offset", sql.Int, offset);
    if (search) dataReq.input("like", sql.NVarChar, `%${search}%`);
    const dataResult = await dataReq.query(`
      SELECT p.ProductId AS id, p.ProductCode AS code, p.ProductName AS name, p.ImageUrl AS imageUrl
      FROM Products p
      WHERE ${search ? "(p.ProductCode LIKE @like OR p.ProductName LIKE @like)" : "1=1"}
      ORDER BY p.ProductCode
      OFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY
    `);
    res.json({ data: dataResult.recordset, total, page, limit, totalPages: Math.ceil(total / limit) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch products" });
  }
});

app.get("/api/bom/product/:productId", auth.requirePermission("product.view"), async (req, res) => {
  const productId = parseIntSafe(req.params.productId);
  if (!productId) return res.status(400).json({ error: "Invalid productId" });
  try {
    const pool = await getPool();
    const header = await pool.request().input("productId", sql.Int, productId).query(`
      SELECT p.ProductId AS id, p.ProductCode AS code, p.ProductName AS name, p.ImageUrl AS imageUrl
      FROM Products p WHERE p.ProductId = @productId
    `);
    if (!header.recordset.length) return res.status(404).json({ error: "Product not found" });
    const product = header.recordset[0];
    let lines;
    try {
      lines = await pool.request().input("productId", sql.Int, productId).query(`
        SELECT b.BomLineId AS id, b.MaterialId, b.ConsumePerUnit AS consumePerUnit,
               m.MaterialCode AS code, m.MaterialName AS name, ISNULL(m.Unit, 'PCS') AS unit
        FROM BomLines b
        JOIN Materials m ON m.MaterialId = b.MaterialId
        WHERE b.ProductId = @productId
        ORDER BY m.MaterialCode
      `);
    } catch (unitErr) {
      if (unitErr.message && /Invalid column name 'Unit'/i.test(unitErr.message)) {
        lines = await pool.request().input("productId", sql.Int, productId).query(`
          SELECT b.BomLineId AS id, b.MaterialId, b.ConsumePerUnit AS consumePerUnit,
                 m.MaterialCode AS code, m.MaterialName AS name, 'PCS' AS unit
          FROM BomLines b
          JOIN Materials m ON m.MaterialId = b.MaterialId
          WHERE b.ProductId = @productId
          ORDER BY m.MaterialCode
        `);
      } else throw unitErr;
    }
    let audit = { recordset: [{ createdAt: null, updatedAt: null, createdBy: null, updatedBy: null }] };
    try {
      audit = await pool.request().input("productId", sql.Int, productId).query(`
        SELECT MIN(b.CreatedAt) AS createdAt, MAX(b.UpdatedAt) AS updatedAt,
               (SELECT TOP 1 CreatedBy FROM BomLines WHERE ProductId = @productId ORDER BY CreatedAt ASC) AS createdBy,
               (SELECT TOP 1 UpdatedBy FROM BomLines WHERE ProductId = @productId ORDER BY UpdatedAt DESC) AS updatedBy
        FROM BomLines b WHERE b.ProductId = @productId
      `);
    } catch (_) {
      try {
        audit = await pool.request().input("productId", sql.Int, productId).query(`
          SELECT MIN(b.CreatedAt) AS createdAt, MAX(b.UpdatedAt) AS updatedAt FROM BomLines b WHERE b.ProductId = @productId
        `);
        if (audit.recordset[0]) audit.recordset[0].createdBy = audit.recordset[0].updatedBy = null;
      } catch (__) {}
    }
    product.lines = lines.recordset || [];
    const auditRow = audit.recordset?.[0] || {};
    product.audit = {
      createdAt: auditRow.createdAt ?? auditRow.CreatedAt ?? null,
      updatedAt: auditRow.updatedAt ?? auditRow.UpdatedAt ?? null,
      createdBy: auditRow.createdBy ?? auditRow.CreatedBy ?? null,
      updatedBy: auditRow.updatedBy ?? auditRow.UpdatedBy ?? null,
    };
    res.json(product);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch BOM detail" });
  }
});

app.get("/api/bom", auth.requirePermission("product.view"), async (req, res) => {
  const page = Math.max(1, parseIntSafe(req.query.page) || 1);
  const limit = Math.min(100, Math.max(1, parseIntSafe(req.query.limit) || 20));
  const search = (req.query.search || req.query.q || "").trim();
  const offset = (page - 1) * limit;
  try {
    const pool = await getPool();
    const countReq = pool.request();
    if (search) countReq.input("like", sql.NVarChar, `%${search}%`);
    const countResult = await countReq.query(`
      SELECT COUNT(DISTINCT b.ProductId) AS total FROM BomLines b
      JOIN Products p ON p.ProductId = b.ProductId
      JOIN Materials m ON m.MaterialId = b.MaterialId
      WHERE ${search ? "(p.ProductCode LIKE @like OR p.ProductName LIKE @like OR m.MaterialCode LIKE @like OR m.MaterialName LIKE @like)" : "1=1"}
    `);
    const total = countResult.recordset[0]?.total || 0;
    const dataRequest = pool.request().input("limit", sql.Int, limit).input("offset", sql.Int, offset);
    if (search) dataRequest.input("like", sql.NVarChar, `%${search}%`);
    const dataResult = await dataRequest.query(`
      SELECT b.BomLineId AS id, b.ProductId, b.MaterialId, b.ConsumePerUnit AS consumePerUnit,
             p.ProductCode, p.ProductName, m.MaterialCode, m.MaterialName
      FROM BomLines b
      JOIN Products p ON p.ProductId = b.ProductId
      JOIN Materials m ON m.MaterialId = b.MaterialId
      WHERE ${search ? "(p.ProductCode LIKE @like OR p.ProductName LIKE @like OR m.MaterialCode LIKE @like OR m.MaterialName LIKE @like)" : "1=1"}
      ORDER BY p.ProductCode, m.MaterialCode
      OFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY
    `);
    res.json({ data: dataResult.recordset, total, page, limit, totalPages: Math.ceil(total / limit) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch BOM" });
  }
});

app.post("/api/bom", auth.requirePermission("product.edit"), async (req, res) => {
  const { productId, materialId, consumePerUnit } = req.body || {};
  if (!productId || !materialId)
    return res.status(400).json({ error: "productId and materialId are required" });
  const consume = parseFloat(consumePerUnit) || 1;
  if (consume <= 0) return res.status(400).json({ error: "consumePerUnit must be > 0" });
  const createdBy = req.user?.FullName || req.user?.Username || null;
  try {
    const pool = await getPool();
    let result;
    try {
      result = await pool.request()
        .input("productId", sql.Int, productId)
        .input("materialId", sql.Int, materialId)
        .input("consumePerUnit", sql.Decimal(18, 3), consume)
        .input("createdBy", sql.NVarChar, createdBy)
        .query(`INSERT INTO BomLines (ProductId, MaterialId, ConsumePerUnit, CreatedBy) OUTPUT INSERTED.BomLineId AS id VALUES (@productId, @materialId, @consumePerUnit, @createdBy)`);
    } catch (colErr) {
      if (colErr.message && /Invalid column name 'CreatedBy'/i.test(colErr.message)) {
        result = await pool.request()
          .input("productId", sql.Int, productId)
          .input("materialId", sql.Int, materialId)
          .input("consumePerUnit", sql.Decimal(18, 3), consume)
          .query(`INSERT INTO BomLines (ProductId, MaterialId, ConsumePerUnit) OUTPUT INSERTED.BomLineId AS id VALUES (@productId, @materialId, @consumePerUnit)`);
      } else throw colErr;
    }
    const newId = result.recordset[0].id;
    await logActivity(pool, req, { menuCode: "bom-design", action: "CREATE", entityType: "BomLine", entityId: newId, entitySummary: `BOM line #${newId}` });
    res.status(201).json({ id: newId });
  } catch (err) {
    if (err.message && /UNIQUE|duplicate|Violation of UNIQUE/i.test(err.message))
      return res.status(400).json({ error: "Định mức này đã tồn tại (trùng sản phẩm + NVL)" });
    console.error(err);
    res.status(500).json({ error: "Failed to create BOM" });
  }
});

app.put("/api/bom/:id", auth.requirePermission("product.edit"), async (req, res) => {
  const id = parseIntSafe(req.params.id);
  const { productId, materialId, consumePerUnit } = req.body || {};
  if (!id) return res.status(400).json({ error: "Invalid id" });
  const consume = consumePerUnit !== undefined ? parseFloat(consumePerUnit) : null;
  if (consume !== null && consume <= 0) return res.status(400).json({ error: "consumePerUnit must be > 0" });
  try {
    const pool = await getPool();
    const request = pool.request().input("id", sql.Int, id);
    const updates = [];
    if (productId !== undefined) { request.input("productId", sql.Int, productId); updates.push("ProductId = @productId"); }
    if (materialId !== undefined) { request.input("materialId", sql.Int, materialId); updates.push("MaterialId = @materialId"); }
    if (consume !== null) { request.input("consumePerUnit", sql.Decimal(18, 3), consume); updates.push("ConsumePerUnit = @consumePerUnit"); }
    if (!updates.length) return res.status(400).json({ error: "No fields to update" });
    updates.push("UpdatedAt = SYSDATETIME()");
    const updatedBy = req.user?.FullName || req.user?.Username || null;
    request.input("updatedBy", sql.NVarChar, updatedBy);
    updates.push("UpdatedBy = @updatedBy");
    await request.query(`UPDATE BomLines SET ${updates.join(", ")} WHERE BomLineId = @id`);
    await logActivity(pool, req, { menuCode: "bom-design", action: "UPDATE", entityType: "BomLine", entityId: id, entitySummary: `BOM line #${id}` });
    res.json({ ok: true });
  } catch (err) {
    if (err.message && /UNIQUE|duplicate|Violation of UNIQUE/i.test(err.message))
      return res.status(400).json({ error: "Định mức này đã tồn tại (trùng sản phẩm + NVL)" });
    console.error(err);
    res.status(500).json({ error: "Failed to update BOM" });
  }
});

app.delete("/api/bom/:id", auth.requirePermission("product.edit"), async (req, res) => {
  const id = parseIntSafe(req.params.id);
  if (!id) return res.status(400).json({ error: "Invalid id" });
  try {
    const pool = await getPool();
    await pool.request().input("id", sql.Int, id).query(`DELETE FROM BomLines WHERE BomLineId = @id`);
    await logActivity(pool, req, { menuCode: "bom-design", action: "DELETE", entityType: "BomLine", entityId: id, entitySummary: `BOM line #${id}` });
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to delete BOM" });
  }
});

// Xóa NVL khỏi BOM theo productId + materialId (tiện cho API bên ngoài)
app.delete("/api/bom/product/:productId/material/:materialId", auth.requirePermission("product.edit"), async (req, res) => {
  const productId = parseIntSafe(req.params.productId);
  const materialId = parseIntSafe(req.params.materialId);
  if (!productId || !materialId) return res.status(400).json({ error: "productId and materialId are required" });
  try {
    const pool = await getPool();
    await pool.request()
      .input("productId", sql.Int, productId)
      .input("materialId", sql.Int, materialId)
      .query(`DELETE FROM BomLines WHERE ProductId = @productId AND MaterialId = @materialId`);
    await logActivity(pool, req, { menuCode: "bom-design", action: "DELETE", entityType: "BomLine", entityId: `${productId}-${materialId}`, entitySummary: `BOM P${productId}/M${materialId}` });
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to delete BOM" });
  }
});

app.post("/api/bom/delete-batch", auth.requirePermission("product.edit"), async (req, res) => {
  const { ids } = req.body || {};
  if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ error: "ids array is required" });
  const validIds = ids.map(id => parseInt(id, 10)).filter(id => id > 0);
  if (!validIds.length) return res.status(400).json({ error: "No valid ids" });
  try {
    const pool = await getPool();
    for (const id of validIds) {
      await pool.request().input("id", sql.Int, id).query(`DELETE FROM BomLines WHERE BomLineId = @id`);
      await logActivity(pool, req, { menuCode: "bom-design", action: "DELETE", entityType: "BomLine", entityId: id, entitySummary: `BOM line #${id}` });
    }
    res.json({ ok: true, deleted: validIds.length });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to delete BOM lines" });
  }
});

app.get("/api/bom/export", auth.requirePermission("product.view"), async (req, res) => {
  const search = (req.query.search || req.query.q || "").trim();
  try {
    const pool = await getPool();
    const dataReq = pool.request();
    if (search) dataReq.input("like", sql.NVarChar, `%${search}%`);
    const rows = await dataReq.query(`
      SELECT TOP 5000 p.ProductCode, p.ProductName, m.MaterialCode, m.MaterialName, b.ConsumePerUnit
      FROM Products p
      LEFT JOIN BomLines b ON b.ProductId = p.ProductId
      LEFT JOIN Materials m ON m.MaterialId = b.MaterialId
      WHERE ${search ? "(p.ProductCode LIKE @like OR p.ProductName LIKE @like)" : "1=1"}
      ORDER BY p.ProductCode, m.MaterialCode
    `);
    const data = (rows.recordset || []).map(r => ({
      "Mã thành phẩm": r.ProductCode || "",
      "Tên thành phẩm": r.ProductName || "",
      "Mã NVL": r.MaterialCode || "",
      "Tên NVL": r.MaterialName || "",
      "Số lượng tiêu hao": r.ConsumePerUnit ?? "",
    }));
    const wb = xlsx.utils.book_new();
    const ws = xlsx.utils.json_to_sheet(data);
    xlsx.utils.book_append_sheet(wb, ws, "BOM");
    const buf = xlsx.write(wb, { type: "buffer", bookType: "xlsx" });
    res.setHeader("Content-Disposition", "attachment; filename=bom-export.xlsx");
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.send(buf);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to export BOM" });
  }
});

app.get("/api/bom/template", auth.requirePermission("product.view"), async (_req, res) => {
  try {
    const data = [
      { "Mã thành phẩm": "SP001", "Mã NVL": "NVL001", "Số lượng tiêu hao": 1 },
      { "Mã thành phẩm": "SP001", "Mã NVL": "NVL002", "Số lượng tiêu hao": 2.5 },
    ];
    const wb = xlsx.utils.book_new();
    const ws = xlsx.utils.json_to_sheet(data);
    xlsx.utils.book_append_sheet(wb, ws, "BOM");
    const buf = xlsx.write(wb, { type: "buffer", bookType: "xlsx" });
    res.setHeader("Content-Disposition", "attachment; filename=bom-mau.xlsx");
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.send(buf);
  } catch (err) {
    res.status(500).json({ error: "Failed to download template" });
  }
});

app.post("/api/bom/import-paste", auth.requirePermission("product.edit"), async (req, res) => {
  const { text } = req.body || {};
  if (!text || typeof text !== "string") return res.status(400).json({ error: "text is required" });
  const lines = text.trim().split(/\r?\n/).filter(Boolean);
  if (!lines.length) return res.status(400).json({ error: "No data" });
  const sep = /\t/.test(lines[0]) ? "\t" : ",";
  const headers = lines[0].split(sep).map(h => h.trim());
  const codeProductIdx = headers.findIndex(h => /mã thành phẩm|productcode|product_code|ma thanh pham/i.test(h));
  const codeMaterialIdx = headers.findIndex(h => /mã nvl|materialcode|material_code|ma nvl/i.test(h));
  const consumeIdx = headers.findIndex(h => /số lượng tiêu hao|consume|consumeperunit|so luong tieu hao|định mức/i.test(h));
  if (codeProductIdx < 0 || codeMaterialIdx < 0 || consumeIdx < 0) {
    return res.status(400).json({ error: "Cần các cột: Mã thành phẩm, Mã NVL, Số lượng tiêu hao" });
  }
  const rows = lines.slice(1).map(line => {
    const cells = line.split(sep).map(c => c.trim());
    return {
      productCode: (cells[codeProductIdx] || "").trim(),
      materialCode: (cells[codeMaterialIdx] || "").trim(),
      consume: parseFloat(cells[consumeIdx]) || 0,
    };
  }).filter(r => r.productCode && r.materialCode && r.consume > 0);
  if (!rows.length) return res.status(400).json({ error: "Không có dòng dữ liệu hợp lệ" });
  try {
    const pool = await getPool();
    const productMap = {};
    const materialMap = {};
    const prodRes = await pool.request().query("SELECT ProductId, ProductCode FROM Products");
    (prodRes.recordset || []).forEach(p => { productMap[(p.ProductCode || "").toUpperCase()] = p.ProductId; });
    const matRes = await pool.request().query("SELECT MaterialId, MaterialCode FROM Materials");
    (matRes.recordset || []).forEach(m => { materialMap[(m.MaterialCode || "").toUpperCase()] = m.MaterialId; });
    let inserted = 0, skipped = 0;
    for (const r of rows) {
      const productId = productMap[(r.productCode || "").toUpperCase()];
      const materialId = materialMap[(r.materialCode || "").toUpperCase()];
      if (!productId || !materialId) { skipped++; continue; }
      try {
        await pool.request()
          .input("productId", sql.Int, productId)
          .input("materialId", sql.Int, materialId)
          .input("consume", sql.Decimal(18, 3), r.consume)
          .query(`INSERT INTO BomLines (ProductId, MaterialId, ConsumePerUnit) VALUES (@productId, @materialId, @consume)`);
        inserted++;
      } catch (e) {
        if (!/UNIQUE|duplicate/i.test(e.message || "")) throw e;
        skipped++;
      }
    }
    res.json({ ok: true, inserted, skipped });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || "Failed to import" });
  }
});

// -------- History / Lược sử (từ ActivityLog) ----------
const ENTITY_TO_TICKET = { PurchaseOrder: "PO", SalesOrder: "SO", StockReceipt: "RECEIPT", StockIssue: "ISSUE", StockAdjustment: "ADJUSTMENT", StockTransfer: "TRANSFER", BomLine: "BOM", Partner: "PARTNER", Item: "ITEM" };
const ACTION_LABELS = { CREATE: "Thêm", UPDATE: "Sửa", DELETE: "Xóa" };

app.get("/api/history", auth.authMiddleware, async (req, res) => {
  const fromDate = req.query.fromDate || req.query.from;
  const toDate = req.query.toDate || req.query.to;
  const ticketType = (req.query.type || "").toUpperCase();
  const executor = (req.query.executor || "").trim();
  const limit = Math.min(500, Math.max(1, parseInt(req.query.limit) || 100));
  let from = fromDate ? new Date(fromDate) : new Date(new Date().setDate(1));
  let to = toDate ? new Date(toDate) : new Date();
  if (isNaN(from.getTime())) from = new Date(new Date().setDate(1));
  if (isNaN(to.getTime())) to = new Date();
  const fromStr = from.toISOString().slice(0, 10);
  const toStr = to.toISOString().slice(0, 10);

  try {
    const pool = await getPool();
    const request = pool.request()
      .input("from", sql.Date, fromStr)
      .input("to", sql.Date, toStr)
      .input("limit", sql.Int, limit);
    if (executor) request.input("executor", sql.NVarChar, `%${executor}%`);

    const entityFilter = ticketType ? (() => {
      const map = { PO: "PurchaseOrder", SO: "SalesOrder", RECEIPT: "StockReceipt", ISSUE: "StockIssue", ADJUSTMENT: "StockAdjustment", TRANSFER: "StockTransfer", BOM: "BomLine", PARTNER: "Partner", ITEM: "Item" };
      return map[ticketType] || null;
    })() : null;
    if (entityFilter) request.input("entityType", sql.NVarChar, entityFilter);

    const sqlQuery = `
      SELECT TOP (@limit)
        al.LogAt AS executionDate,
        al.EntityId AS ticketId,
        al.EntitySummary AS ticketNumber,
        al.Action,
        al.EntityType,
        al.UserName AS performer,
        m.DetailUrlPattern,
        m.MenuCode
      FROM ActivityLog al
      LEFT JOIN Menus m ON m.MenuId = al.MenuId
      WHERE CAST(al.LogAt AS DATE) BETWEEN @from AND @to
        ${executor ? "AND al.UserName LIKE @executor" : ""}
        ${entityFilter ? "AND al.EntityType = @entityType" : ""}
      ORDER BY al.LogAt DESC
    `;

    const result = await request.query(sqlQuery);
    const rows = (result.recordset || []).map(r => {
      const tt = ENTITY_TO_TICKET[r.EntityType] || r.EntityType || "-";
      const detailUrl = (r.DetailUrlPattern || "").trim() && r.ticketId
        ? (r.DetailUrlPattern + r.ticketId)
        : (tt === "PO" ? `/modules/Purchase/detail.html?id=${r.ticketId}` : tt === "SO" ? `/modules/Sales/detail.html?id=${r.ticketId}` : tt === "BOM" ? "/modules/BOM/design.html" : "#");
      return {
        ticketType: tt,
        ticketId: r.ticketId,
        ticketNumber: r.ticketNumber || `#${r.ticketId}`,
        executionDate: r.executionDate,
        action: ACTION_LABELS[r.Action] || r.Action,
        customerCode: "-",
        customerName: "-",
        assignedName: "-",
        performer: r.performer || "-",
        status: "-",
        detailUrl,
      };
    });

    res.json({ data: rows, total: rows.length, from: fromStr, to: toStr });
  } catch (err) {
    if (err.message && /Invalid object name 'ActivityLog'|Invalid object name 'Menus'/i.test(err.message)) {
      return res.status(503).json({ error: "Chạy fix_activity_log.sql trước" });
    }
    console.error("[History API]", err);
    res.status(500).json({ error: err.message || "Failed to fetch history" });
  }
});

// -------- Opening balance (get) ----------
app.get("/api/opening-balance/:type/:id", auth.requirePermission("product.view"), async (req, res) => {
  const { type, id } = req.params; // type: product|material
  const itemType = type === "product" ? "P" : "M";
  const itemId = parseIntSafe(id);
  if (!itemId) return res.status(400).json({ error: "Invalid id" });
  try {
    const pool = await getPool();
    const result = await pool
      .request()
      .input("itemType", sql.VarChar, itemType)
      .input("itemId", sql.Int, itemId).query(`
        SELECT StartYear AS year, StartWeek AS week, BalanceQty AS balance
        FROM OpeningBalances
        WHERE ItemType = @itemType AND ItemId = @itemId
      `);
    res.json(result.recordset[0] || null);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch opening balance" });
  }
});

// -------- Opening balance (upsert) ----------
app.put("/api/opening-balance", auth.requirePermission("product.edit"), async (req, res) => {
  const { itemType, itemId, startYear, startWeek, balanceQty } = req.body;
  if (!["P", "M"].includes(itemType))
    return res.status(400).json({ error: "itemType must be P or M" });
  if (!itemId || !startYear || !startWeek || balanceQty === undefined)
    return res.status(400).json({ error: "Missing fields" });
  try {
    const pool = await getPool();
    await pool
      .request()
      .input("itemType", sql.Char(1), itemType)
      .input("itemId", sql.Int, itemId)
      .input("startYear", sql.SmallInt, startYear)
      .input("startWeek", sql.TinyInt, startWeek)
      .input("balanceQty", sql.Decimal(18, 3), balanceQty).query(`
        MERGE OpeningBalances AS target
        USING (SELECT @itemType AS ItemType, @itemId AS ItemId) AS src
        ON target.ItemType = src.ItemType AND target.ItemId = src.ItemId
        WHEN MATCHED THEN
          UPDATE SET StartYear=@startYear, StartWeek=@startWeek, BalanceQty=@balanceQty, UpdatedAt=SYSDATETIME()
        WHEN NOT MATCHED THEN
          INSERT (ItemType, ItemId, StartYear, StartWeek, BalanceQty)
          VALUES (@itemType, @itemId, @startYear, @startWeek, @balanceQty);
      `);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to upsert opening balance" });
  }
});

// -------- Đồng bộ OpeningBalances từ Stock (OpeningBalance + StockTransactions) ----------
// Công thức: Balance = OpeningBalance + SUM(StockTransactions từ tuần opening đến hiện tại)
// Đảm bảo MPS và Stock dùng cùng logic
app.post("/api/opening-balance/sync-from-stock", auth.authMiddleware, async (req, res) => {
  try {
    const pool = await getPool();
    const now = new Date();
    const startYear = now.getFullYear();
    const startWeek = Math.min(52, Math.max(1, getISOWeek(now)));
    const today = now.toISOString().slice(0, 10);
    const result = await pool.request()
      .input("startYear", sql.SmallInt, startYear)
      .input("startWeek", sql.TinyInt, startWeek)
      .input("today", sql.Date, today)
      .query(`
        MERGE OpeningBalances AS t
        USING (
          SELECT st.ItemType, st.ItemId,
                 ISNULL(ob.BalanceQty, 0) + SUM(st.Quantity) AS qty
          FROM StockTransactions st
          LEFT JOIN OpeningBalances ob ON ob.ItemType = st.ItemType AND ob.ItemId = st.ItemId
          WHERE st.TransactionDate <= @today
            AND (ob.ItemType IS NULL OR (YEAR(st.TransactionDate) > ob.StartYear OR (YEAR(st.TransactionDate) = ob.StartYear AND DATEPART(ISO_WEEK, st.TransactionDate) >= ob.StartWeek)))
          GROUP BY st.ItemType, st.ItemId, ob.BalanceQty
        ) AS s ON t.ItemType = s.ItemType AND t.ItemId = s.ItemId
        WHEN MATCHED THEN UPDATE SET StartYear = @startYear, StartWeek = @startWeek, BalanceQty = s.qty, UpdatedAt = SYSDATETIME()
        WHEN NOT MATCHED THEN INSERT (ItemType, ItemId, StartYear, StartWeek, BalanceQty) VALUES (s.ItemType, s.ItemId, @startYear, @startWeek, s.qty);
      `);
    res.json({ ok: true, startYear, startWeek, message: "Đã đồng bộ OpeningBalances từ Stock (OpeningBalance + StockTransactions)" });
  } catch (err) {
    if (err.message && /Invalid object name/i.test(err.message)) {
      return res.status(503).json({ error: "Run fix_inventory.sql first" });
    }
    console.error("[Sync OpeningBalance]", err);
    res.status(500).json({ error: "Sync failed: " + err.message });
  }
});
function getISOWeek(d) {
  d = new Date(d); d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + 4 - (d.getDay() || 7));
  const y = d.getFullYear();
  const start = new Date(y, 0, 1);
  return Math.ceil((((d - start) / 86400000) + 1) / 7);
}

/** Trả về ngày đầu tuần (Thứ 2) của ISO week. VD: getISOWeekStart(2026, 1) => "2026-01-05" */
function getISOWeekStartDate(year, week) {
  const d = new Date(year, 0, 1 + (week - 1) * 7);
  const dow = d.getDay();
  const mondayOffset = dow === 0 ? -6 : 1 - dow;
  d.setDate(d.getDate() + mondayOffset);
  return d.toISOString().slice(0, 10);
}

/** Parse ETA từ line: etaDate (ưu tiên) hoặc etaYear/etaWeek. Trả về { etaDate, etaYear, etaWeek } */
function parseEtaFromLine(line) {
  const etaDateStr = line.etaDate ? toDateString(line.etaDate) : null;
  if (etaDateStr) {
    const d = new Date(etaDateStr);
    return {
      etaDate: etaDateStr,
      etaYear: d.getFullYear(),
      etaWeek: Math.min(52, Math.max(1, getISOWeek(d))),
    };
  }
  const y = parseInt(line.etaYear, 10) || new Date().getFullYear();
  const w = parseInt(line.etaWeek, 10) || 1;
  return { etaDate: null, etaYear: y, etaWeek: Math.min(53, Math.max(1, w)) };
}

// -------- Production (ACTIVE/COMPLETE) - for MPS pro_qty ----------
app.get("/api/production", auth.requireAnyPermission("production.view", "mps.view"), async (req, res) => {
  const productId = parseIntSafe(req.query.productId);
  const fromYear = parseIntSafe(req.query.fromYear);
  const fromWeek = parseIntSafe(req.query.fromWeek);
  const toYear = parseIntSafe(req.query.toYear);
  const toWeek = parseIntSafe(req.query.toWeek);
  if (!fromYear || !fromWeek || !toYear || !toWeek)
    return res
      .status(400)
      .json({ error: "fromYear/fromWeek/toYear/toWeek required" });
  try {
    const pool = await getPool();
    const result = await pool
      .request()
      .input("productId", sql.Int, productId)
      .input("fromYear", sql.Int, fromYear)
      .input("fromWeek", sql.Int, fromWeek)
      .input("toYear", sql.Int, toYear)
      .input("toWeek", sql.Int, toWeek).query(`
        SELECT ProductId AS productId, PlanYear AS year, PlanWeek AS week, SUM(Quantity) AS qty
        FROM ProductionOrders
        WHERE UPPER(Status) IN ('ACTIVE','COMPLETE')
          AND (PlanYear > @fromYear OR (PlanYear = @fromYear AND PlanWeek >= @fromWeek))
          AND (PlanYear < @toYear OR (PlanYear = @toYear AND PlanWeek <= @toWeek))
          AND (@productId IS NULL OR ProductId = @productId)
        GROUP BY ProductId, PlanYear, PlanWeek
        ORDER BY PlanYear, PlanWeek
      `);
    console.log(
      `[Production API] productId=${productId}, fromYear=${fromYear}, fromWeek=${fromWeek}, toYear=${toYear}, toWeek=${toWeek}, found ${result.recordset.length} records`
    );
    res.json(result.recordset);
  } catch (err) {
    console.error("[Production API Error]", err);
    res.status(500).json({ error: "Failed to fetch production" });
  }
});

// -------- Purchase / Stock_in - debug: xem PO lines CONFIRM có ETA ----------
app.get("/api/purchase/debug", auth.requirePermission("mps.view"), async (req, res) => {
  try {
    const pool = await getPool();
    const r = await pool.request().query(`
      SELECT po.PurchaseOrderId, po.PONumber, po.Status, pol.MaterialId, pol.EtaDate, pol.EtaYear, pol.EtaWeek, pol.Quantity
      FROM PurchaseOrderLines pol
      JOIN PurchaseOrders po ON po.PurchaseOrderId = pol.PurchaseOrderId
      WHERE UPPER(po.Status) = 'CONFIRM'
      ORDER BY pol.EtaDate, pol.EtaYear, pol.EtaWeek
    `);
    res.json({ count: r.recordset?.length || 0, rows: r.recordset || [] });
  } catch (e) {
    res.status(500).json({ error: String(e.message) });
  }
});

// -------- Purchase / Stock_in - for MPS module ----------
// Quá khứ: stock_in = phiếu nhập kho đã xác nhận (thực tế)
// Tương lai: stock_in = phiếu mua hàng ETA (dự báo, hàng chưa về)
// Tương lai: lấy TẤT CẢ PO trong range, loại trùng với past (ưu tiên actual)
app.get("/api/purchase", auth.requirePermission("mps.view"), async (req, res) => {
  const materialId = parseIntSafe(req.query.materialId);
  const fromYear = parseIntSafe(req.query.fromYear);
  const fromWeek = parseIntSafe(req.query.fromWeek);
  const toYear = parseIntSafe(req.query.toYear);
  const toWeek = parseIntSafe(req.query.toWeek);
  if (!fromYear || !fromWeek || !toYear || !toWeek)
    return res
      .status(400)
      .json({ error: "fromYear/fromWeek/toYear/toWeek required" });
  try {
    const pool = await getPool();
    const now = new Date();
    const currentYear = now.getFullYear();
    const currentWeek = Math.min(52, Math.max(1, getISOWeek(now)));
    const request = pool.request()
      .input("materialId", sql.Int, materialId)
      .input("fromYear", sql.Int, fromYear)
      .input("fromWeek", sql.Int, fromWeek)
      .input("toYear", sql.Int, toYear)
      .input("toWeek", sql.Int, toWeek)
      .input("currentYear", sql.Int, currentYear)
      .input("currentWeek", sql.Int, currentWeek);

    // Quá khứ: phiếu nhập kho đã xác nhận (StockTransactions RECEIPT, STOCK_RECEIPT)
    let pastRows = [];
    try {
      const pastResult = await request.query(`
        SELECT st.ItemId AS materialId, DATEPART(YEAR, st.TransactionDate) AS year, DATEPART(ISO_WEEK, st.TransactionDate) AS week, SUM(st.Quantity) AS qty
        FROM StockTransactions st
        WHERE st.TransactionType = 'RECEIPT' AND st.ItemType = 'M'
          AND st.ReferenceType = 'STOCK_RECEIPT'
          AND (DATEPART(YEAR, st.TransactionDate) > @fromYear OR (DATEPART(YEAR, st.TransactionDate) = @fromYear AND DATEPART(ISO_WEEK, st.TransactionDate) >= @fromWeek))
          AND (DATEPART(YEAR, st.TransactionDate) < @toYear OR (DATEPART(YEAR, st.TransactionDate) = @toYear AND DATEPART(ISO_WEEK, st.TransactionDate) <= @toWeek))
          AND (DATEPART(YEAR, st.TransactionDate) < @currentYear OR (DATEPART(YEAR, st.TransactionDate) = @currentYear AND DATEPART(ISO_WEEK, st.TransactionDate) <= @currentWeek))
          AND (@materialId IS NULL OR st.ItemId = @materialId)
        GROUP BY st.ItemId, DATEPART(YEAR, st.TransactionDate), DATEPART(ISO_WEEK, st.TransactionDate)
      `);
      pastRows = pastResult.recordset || [];
    } catch (e) {
      if (!/Invalid object name|StockTransactions/i.test(e.message || "")) throw e;
    }

    // Tương lai: phiếu mua hàng CONFIRM (EtaDate - dự báo, tự tính year/week)
    // Lấy TẤT CẢ PO lines trong range, rồi loại những tuần đã có trong past (tránh trùng)
    let futureRows = [];
    try {
      const futureResult = await pool.request()
        .input("materialId", sql.Int, materialId)
        .input("fromYear", sql.Int, fromYear)
        .input("fromWeek", sql.Int, fromWeek)
        .input("toYear", sql.Int, toYear)
        .input("toWeek", sql.Int, toWeek)
        .query(`
          SELECT pol.MaterialId AS materialId,
            COALESCE(DATEPART(YEAR, pol.EtaDate), pol.EtaYear) AS year,
            COALESCE(DATEPART(ISO_WEEK, pol.EtaDate), pol.EtaWeek) AS week,
            SUM(pol.Quantity) AS qty
          FROM PurchaseOrderLines pol
          JOIN PurchaseOrders po ON po.PurchaseOrderId = pol.PurchaseOrderId
          WHERE UPPER(LTRIM(RTRIM(po.Status))) = 'CONFIRM'
            AND (pol.EtaDate IS NOT NULL OR (pol.EtaYear IS NOT NULL AND pol.EtaWeek IS NOT NULL))
            AND (
              (COALESCE(DATEPART(YEAR, pol.EtaDate), pol.EtaYear) > @fromYear)
              OR (COALESCE(DATEPART(YEAR, pol.EtaDate), pol.EtaYear) = @fromYear AND COALESCE(DATEPART(ISO_WEEK, pol.EtaDate), pol.EtaWeek) >= @fromWeek)
            )
            AND (
              (COALESCE(DATEPART(YEAR, pol.EtaDate), pol.EtaYear) < @toYear)
              OR (COALESCE(DATEPART(YEAR, pol.EtaDate), pol.EtaYear) = @toYear AND COALESCE(DATEPART(ISO_WEEK, pol.EtaDate), pol.EtaWeek) <= @toWeek)
            )
            AND (@materialId IS NULL OR pol.MaterialId = @materialId)
          GROUP BY pol.MaterialId, COALESCE(DATEPART(YEAR, pol.EtaDate), pol.EtaYear), COALESCE(DATEPART(ISO_WEEK, pol.EtaDate), pol.EtaWeek)
        `);
      const allFuture = futureResult.recordset || [];
      const pastKeys = new Set(pastRows.map(r => `${r.materialId}_${r.year}_${r.week}`));
      futureRows = allFuture.filter(r => !pastKeys.has(`${r.materialId}_${r.year}_${r.week}`));
    } catch (e) {
      if (!/Invalid object name|PurchaseOrder/i.test(e.message || "")) throw e;
    }

    res.json([...pastRows, ...futureRows]);
  } catch (err) {
    if (err.message && /Invalid object name/i.test(err.message)) {
      return res.status(503).json({ error: "Run fix_inventory.sql and fix_stock_receipt.sql first" });
    }
    if (err.message && /Invalid column name 'EtaDate'/i.test(err.message)) {
      return res.status(503).json({ error: "Run fix_eta_date.sql first" });
    }
    console.error(err);
    res.status(500).json({ error: "Failed to fetch purchase/stock_in" });
  }
});

// -------- Item master (Products + Materials) ----------
app.get("/api/items", auth.requirePermission("product.view"), async (req, res) => {
  const q = (req.query.q || "").trim();
  const type = (req.query.type || "").toUpperCase(); // 'P' | 'M' | ''
  try {
    const pool = await getPool();
    const request = pool.request();
    if (q) {
      request.input("like", sql.NVarChar, `%${q}%`);
    }
    const whereProduct =
      type === "M"
        ? "WHERE 1=0"
        : q
        ? "WHERE (p.ProductCode LIKE @like OR p.ProductName LIKE @like)"
        : "";
    const whereMaterial =
      type === "P"
        ? "WHERE 1=0"
        : q
        ? "WHERE (m.MaterialCode LIKE @like OR m.MaterialName LIKE @like)"
        : "";
    const result = await request.query(`
      SELECT 'P' AS itemType,
             p.ProductId AS id,
             p.ProductCode AS code,
             p.ProductName AS name,
             p.ImageUrl,
             ob.StartYear,
             ob.StartWeek,
             ob.BalanceQty,
             NULL AS SafetyStockQty
      FROM Products p
      LEFT JOIN OpeningBalances ob
        ON ob.ItemType = 'P' AND ob.ItemId = p.ProductId
      ${whereProduct}
      UNION ALL
      SELECT 'M' AS itemType,
             m.MaterialId AS id,
             m.MaterialCode AS code,
             m.MaterialName AS name,
             m.ImageUrl,
             ob.StartYear,
             ob.StartWeek,
             ob.BalanceQty,
             m.SafetyStockQty
      FROM Materials m
      LEFT JOIN OpeningBalances ob
        ON ob.ItemType = 'M' AND ob.ItemId = m.MaterialId
      ${whereMaterial}
      ORDER BY itemType, code;
    `);
    res.json(result.recordset);
  } catch (err) {
    console.error("[Items API Error]", err);
    res.status(500).json({ error: "Failed to fetch items" });
  }
});

app.post("/api/items", auth.requirePermission("product.edit"), async (req, res) => {
  const {
    type,
    code,
    name,
    imageUrl,
    openingYear,
    openingWeek,
    openingBalance,
    safetyStockQty,
  } = req.body || {};
  const itemType = (type || "").toUpperCase();
  if (!["P", "M"].includes(itemType))
    return res.status(400).json({ error: "type must be P or M" });
  if (!code || !name)
    return res
      .status(400)
      .json({ error: "code and name are required for item" });

  try {
    const pool = await getPool();
    const request = pool.request();
    let insertQuery;
    if (itemType === "P") {
      request
        .input("code", sql.NVarChar, code)
        .input("name", sql.NVarChar, name)
        .input("imageUrl", sql.NVarChar(sql.MAX), imageUrl || null);
      insertQuery = `
        INSERT INTO Products (ProductCode, ProductName, ImageUrl)
        OUTPUT INSERTED.ProductId AS id
        VALUES (@code, @name, @imageUrl);
      `;
    } else {
      request
        .input("code", sql.NVarChar, code)
        .input("name", sql.NVarChar, name)
        .input("imageUrl", sql.NVarChar(sql.MAX), imageUrl || null)
        .input("safetyStockQty", sql.Decimal(18, 3), safetyStockQty != null ? Number(safetyStockQty) : 0);
      insertQuery = `
        INSERT INTO Materials (MaterialCode, MaterialName, ImageUrl, SafetyStockQty)
        OUTPUT INSERTED.MaterialId AS id
        VALUES (@code, @name, @imageUrl, @safetyStockQty);
      `;
    }
    const insertResult = await request.query(insertQuery);
    const newId = insertResult.recordset[0].id;

    if (openingYear && openingWeek && openingBalance !== undefined) {
      await pool
        .request()
        .input("itemType", sql.Char(1), itemType)
        .input("itemId", sql.Int, newId)
        .input("startYear", sql.SmallInt, openingYear)
        .input("startWeek", sql.TinyInt, openingWeek)
        .input("balanceQty", sql.Decimal(18, 3), openingBalance).query(`
          MERGE OpeningBalances AS target
          USING (SELECT @itemType AS ItemType, @itemId AS ItemId) AS src
          ON target.ItemType = src.ItemType AND target.ItemId = src.ItemId
          WHEN MATCHED THEN
            UPDATE SET StartYear=@startYear, StartWeek=@startWeek, BalanceQty=@balanceQty, UpdatedAt=SYSDATETIME()
          WHEN NOT MATCHED THEN
            INSERT (ItemType, ItemId, StartYear, StartWeek, BalanceQty)
            VALUES (@itemType, @itemId, @startYear, @startWeek, @balanceQty);
        `);
    }

    const entityType = itemType === "M" ? "Material" : "Product";
    await logActivity(pool, req, { menuCode: "items", action: "CREATE", entityType, entityId: newId, entitySummary: code ? `${code}` : `${entityType} #${newId}` });
    res.status(201).json({ id: newId });
  } catch (err) {
    console.error("[Items API Create Error]", err);
    res.status(500).json({ error: "Failed to create item" });
  }
});

app.put("/api/items/:type/:id", auth.requirePermission("product.edit"), async (req, res) => {
  const itemType = (req.params.type || "").toUpperCase();
  const itemId = parseIntSafe(req.params.id);
  const { code, name, imageUrl, openingYear, openingWeek, openingBalance, safetyStockQty } =
    req.body || {};
  if (!["P", "M"].includes(itemType))
    return res.status(400).json({ error: "type must be P or M" });
  if (!itemId) return res.status(400).json({ error: "Invalid id" });

  try {
    const pool = await getPool();
    const request = pool.request();
    request
      .input("id", sql.Int, itemId)
      .input("code", sql.NVarChar, code || null)
      .input("name", sql.NVarChar, name || null)
      .input("imageUrl", sql.NVarChar(sql.MAX), imageUrl || null);
    if (itemType === "P") {
      await request.query(`
        UPDATE Products
        SET ProductCode = COALESCE(@code, ProductCode),
            ProductName = COALESCE(@name, ProductName),
            ImageUrl = @imageUrl,
            UpdatedAt = SYSDATETIME()
        WHERE ProductId = @id;
      `);
    } else {
      request.input("safetyStockQty", sql.Decimal(18, 3), safetyStockQty != null ? Number(safetyStockQty) : 0);
      await request.query(`
        UPDATE Materials
        SET MaterialCode = COALESCE(@code, MaterialCode),
            MaterialName = COALESCE(@name, MaterialName),
            ImageUrl = @imageUrl,
            SafetyStockQty = @safetyStockQty,
            UpdatedAt = SYSDATETIME()
        WHERE MaterialId = @id;
      `);
    }

    if (openingYear && openingWeek && openingBalance !== undefined) {
      await pool
        .request()
        .input("itemType", sql.Char(1), itemType)
        .input("itemId", sql.Int, itemId)
        .input("startYear", sql.SmallInt, openingYear)
        .input("startWeek", sql.TinyInt, openingWeek)
        .input("balanceQty", sql.Decimal(18, 3), openingBalance).query(`
          MERGE OpeningBalances AS target
          USING (SELECT @itemType AS ItemType, @itemId AS ItemId) AS src
          ON target.ItemType = src.ItemType AND target.ItemId = src.ItemId
          WHEN MATCHED THEN
            UPDATE SET StartYear=@startYear, StartWeek=@startWeek, BalanceQty=@balanceQty, UpdatedAt=SYSDATETIME()
          WHEN NOT MATCHED THEN
            INSERT (ItemType, ItemId, StartYear, StartWeek, BalanceQty)
            VALUES (@itemType, @itemId, @startYear, @startWeek, @balanceQty);
        `);
    }

    const itemType = req.params.type?.toUpperCase() === "M" ? "Material" : "Product";
    await logActivity(pool, req, { menuCode: "items", action: "UPDATE", entityType: itemType, entityId: itemId, entitySummary: `${itemType} #${itemId}` });
    res.json({ ok: true });
  } catch (err) {
    console.error("[Items API Update Error]", err);
    res.status(500).json({ error: "Failed to update item" });
  }
});

app.delete("/api/items/:type/:id", auth.requirePermission("product.edit"), async (req, res) => {
  const itemType = (req.params.type || "").toUpperCase();
  const itemId = parseIntSafe(req.params.id);
  if (!["P", "M"].includes(itemType))
    return res.status(400).json({ error: "type must be P or M" });
  if (!itemId) return res.status(400).json({ error: "Invalid id" });
  try {
    const pool = await getPool();
    const request = pool.request().input("id", sql.Int, itemId);
    // Remove opening balance first
    await pool
      .request()
      .input("itemType", sql.Char(1), itemType)
      .input("itemId", sql.Int, itemId).query(`
        DELETE FROM OpeningBalances WHERE ItemType = @itemType AND ItemId = @itemId;
      `);
    if (itemType === "P") {
      await request.query(`DELETE FROM Products WHERE ProductId = @id;`);
    } else {
      await request.query(`DELETE FROM Materials WHERE MaterialId = @id;`);
    }
    const entityType = itemType === "P" ? "Product" : "Material";
    await logActivity(pool, req, { menuCode: "items", action: "DELETE", entityType, entityId: itemId, entitySummary: `${entityType} #${itemId}` });
    res.json({ ok: true });
  } catch (err) {
    console.error("[Items API Delete Error]", err);
    res.status(500).json({ error: "Failed to delete item" });
  }
});

// Bulk import items from Excel
app.post("/api/items/import", auth.requirePermission("product.edit"), upload.single("file"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "file is required" });
  try {
    const workbook = xlsx.read(req.file.buffer, { type: "buffer" });
    const sheetName = workbook.SheetNames[0];
    const sheet = workbook.Sheets[sheetName];
    const rows = xlsx.utils.sheet_to_json(sheet, { defval: null });
    const pool = await getPool();

    for (const row of rows) {
      const itemType = (row.Type || row.ItemType || "").toUpperCase();
      const code = row.Code || row.MCode || row.PCode;
      const name = row.Name || row.ItemName;
      if (!["P", "M"].includes(itemType) || !code || !name) continue;
      const imageUrl = row.ImageUrl || null;
      const openingYear = row.StartYear || row.OpenYear;
      const openingWeek = row.StartWeek || row.OpenWeek;
      const openingBalance = row.Balance || row.OpeningBalance;
      const safetyStockQty = row.SafetyStockQty ?? row.SafetyStock ?? row.SafeStock ?? null;

      // Upsert product/material by code
      const request = pool
        .request()
        .input("code", sql.NVarChar, code)
        .input("name", sql.NVarChar, name)
        .input("imageUrl", sql.NVarChar(sql.MAX), imageUrl);
      let mergeQuery;
      if (itemType === "P") {
        mergeQuery = `
            MERGE Products AS target
            USING (SELECT @code AS ProductCode) AS src
            ON target.ProductCode = src.ProductCode
            WHEN MATCHED THEN
              UPDATE SET ProductName=@name, ImageUrl=@imageUrl, UpdatedAt=SYSDATETIME()
            WHEN NOT MATCHED THEN
              INSERT (ProductCode, ProductName, ImageUrl)
              VALUES (@code, @name, @imageUrl)
            OUTPUT INSERTED.ProductId AS id;
          `;
      } else {
        request.input("safetyStockQty", sql.Decimal(18, 3), safetyStockQty != null ? Number(safetyStockQty) : 0);
        mergeQuery = `
            MERGE Materials AS target
            USING (SELECT @code AS MaterialCode) AS src
            ON target.MaterialCode = src.MaterialCode
            WHEN MATCHED THEN
              UPDATE SET MaterialName=@name, ImageUrl=@imageUrl, SafetyStockQty=@safetyStockQty, UpdatedAt=SYSDATETIME()
            WHEN NOT MATCHED THEN
              INSERT (MaterialCode, MaterialName, ImageUrl, SafetyStockQty)
              VALUES (@code, @name, @imageUrl, @safetyStockQty)
            OUTPUT INSERTED.MaterialId AS id;
          `;
      }
      const mergeResult = await request.query(mergeQuery);
      const newId = mergeResult.recordset[0].id;

      if (openingYear && openingWeek && openingBalance !== undefined) {
        await pool
          .request()
          .input("itemType", sql.Char(1), itemType)
          .input("itemId", sql.Int, newId)
          .input("startYear", sql.SmallInt, openingYear)
          .input("startWeek", sql.TinyInt, openingWeek)
          .input("balanceQty", sql.Decimal(18, 3), openingBalance).query(`
              MERGE OpeningBalances AS target
              USING (SELECT @itemType AS ItemType, @itemId AS ItemId) AS src
              ON target.ItemType = src.ItemType AND target.ItemId = src.ItemId
              WHEN MATCHED THEN
                UPDATE SET StartYear=@startYear, StartWeek=@startWeek, BalanceQty=@balanceQty, UpdatedAt=SYSDATETIME()
              WHEN NOT MATCHED THEN
                INSERT (ItemType, ItemId, StartYear, StartWeek, BalanceQty)
                VALUES (@itemType, @itemId, @startYear, @startWeek, @balanceQty);
            `);
      }
    }

    res.json({ ok: true });
  } catch (err) {
    console.error("[Items Import Error]", err);
    res.status(500).json({ error: "Failed to import items" });
  }
});

// -------- Production Orders CRUD (for Production module) ----------
app.get("/api/production-orders", auth.requirePermission("production.view"), async (req, res) => {
  const productId = parseIntSafe(req.query.productId);
  const status = (req.query.status || "").toUpperCase(); // INITIAL, ACTIVE, COMPLETE, empty = all
  const fromYear = parseIntSafe(req.query.fromYear);
  const fromWeek = parseIntSafe(req.query.fromWeek);
  const toYear = parseIntSafe(req.query.toYear);
  const toWeek = parseIntSafe(req.query.toWeek);

  try {
    const pool = await getPool();
    const request = pool.request();
    if (productId) request.input("productId", sql.Int, productId);
    if (fromYear) request.input("fromYear", sql.Int, fromYear);
    if (fromWeek) request.input("fromWeek", sql.Int, fromWeek);
    if (toYear) request.input("toYear", sql.Int, toYear);
    if (toWeek) request.input("toWeek", sql.Int, toWeek);
    if (status) request.input("status", sql.NVarChar, status);

    const where = [];
    if (productId) where.push("o.ProductId = @productId");
    if (fromYear && fromWeek)
      where.push(
        "(o.PlanYear > @fromYear OR (o.PlanYear = @fromYear AND o.PlanWeek >= @fromWeek))"
      );
    if (toYear && toWeek)
      where.push(
        "(o.PlanYear < @toYear OR (o.PlanYear = @toYear AND o.PlanWeek <= @toWeek))"
      );
    if (status) where.push("UPPER(o.Status) = @status");

    const whereSql = where.length ? "WHERE " + where.join(" AND ") : "";

    const result = await request.query(`
      SELECT o.ProductionOrderId AS id,
             o.ProductId,
             p.ProductCode AS productCode,
             p.ProductName AS productName,
             o.Quantity,
             o.PlanYear,
             o.PlanWeek,
             o.Status,
             o.CreatedAt
      FROM ProductionOrders o
      JOIN Products p ON p.ProductId = o.ProductId
      ${whereSql}
      ORDER BY o.PlanYear DESC, o.PlanWeek DESC, o.ProductionOrderId DESC;
    `);
    res.json(result.recordset);
  } catch (err) {
    console.error("[ProductionOrders List Error]", err);
    res.status(500).json({ error: "Failed to fetch production orders" });
  }
});

app.post("/api/production-orders", auth.requirePermission("production.edit"), async (req, res) => {
  const { productId, quantity, planYear, planWeek, status } = req.body || {};
  if (!productId || !quantity || !planYear || !planWeek)
    return res
      .status(400)
      .json({ error: "productId, quantity, planYear, planWeek are required" });
  const normStatus = (status || "INITIAL").toUpperCase();
  if (!["INITIAL", "ACTIVE", "COMPLETE"].includes(normStatus))
    return res
      .status(400)
      .json({ error: "status must be INITIAL, ACTIVE or COMPLETE" });

  try {
    const pool = await getPool();
    const result = await pool
      .request()
      .input("productId", sql.Int, productId)
      .input("quantity", sql.Decimal(18, 3), quantity)
      .input("planYear", sql.Int, planYear)
      .input("planWeek", sql.Int, planWeek)
      .input("status", sql.NVarChar, normStatus).query(`
        INSERT INTO ProductionOrders (ProductId, Quantity, PlanYear, PlanWeek, Status)
        OUTPUT INSERTED.ProductionOrderId AS id
        VALUES (@productId, @quantity, @planYear, @planWeek, @status);
      `);
    const newId = result.recordset[0].id;

    // Notify realtime clients (e.g. MPS) that production changed
    try {
      io.emit("production:changed", {
        type: "create",
        id: newId,
        productId,
        year: planYear,
        week: planWeek,
        status: normStatus,
      });
    } catch (notifyErr) {
      console.error("[Socket] Failed to emit production:changed (create)", notifyErr);
    }

    res.status(201).json({ id: newId });
  } catch (err) {
    console.error("[ProductionOrders Create Error]", err);
    res.status(500).json({ error: "Failed to create production order" });
  }
});

app.put("/api/production-orders/:id", auth.requirePermission("production.edit"), async (req, res) => {
  const id = parseIntSafe(req.params.id);
  if (!id) return res.status(400).json({ error: "Invalid id" });
  const { productId, quantity, planYear, planWeek, status, warehouseMaterialId, warehouseProductId } = req.body || {};
  const normStatus = status ? status.toUpperCase() : null;
  if (normStatus && !["INITIAL", "ACTIVE", "COMPLETE"].includes(normStatus))
    return res
      .status(400)
      .json({ error: "status must be INITIAL, ACTIVE or COMPLETE" });

  let transaction;
  try {
    const pool = await getPool();
    transaction = new sql.Transaction(pool);
    await transaction.begin();
    const request = new sql.Request(transaction).input("id", sql.Int, id);

    // Fetch current PO (WarehouseMaterialId/ProductId có thể chưa có nếu chưa chạy fix_inventory)
    let currentResult, hasWarehouseCols = true;
    try {
      currentResult = await request.query(`
        SELECT Status, ProductId, Quantity, WarehouseMaterialId, WarehouseProductId
        FROM ProductionOrders WHERE ProductionOrderId = @id
      `);
    } catch (colErr) {
      if (colErr.message && /WarehouseMaterialId|WarehouseProductId|Invalid column/i.test(colErr.message)) {
        hasWarehouseCols = false;
        currentResult = await new sql.Request(transaction).input("id", sql.Int, id).query(`
          SELECT Status, ProductId, Quantity FROM ProductionOrders WHERE ProductionOrderId = @id
        `);
        currentResult.recordset.forEach(r => { r.WarehouseMaterialId = 1; r.WarehouseProductId = 2; });
      } else throw colErr;
    }
    const current = currentResult.recordset[0];
    if (!current) {
      await transaction.rollback();
      return res.status(404).json({ error: "Production order not found" });
    }
    const oldStatus = current.Status || "";
    const prodId = productId || current.ProductId;
    const qty = quantity != null ? parseFloat(quantity) : parseFloat(current.Quantity);
    const whMaterial = warehouseMaterialId ? parseInt(warehouseMaterialId, 10) : (current.WarehouseMaterialId || 1);
    const whProduct = warehouseProductId ? parseInt(warehouseProductId, 10) : (current.WarehouseProductId || 2);

    const updates = [];
    if (productId) { request.input("productId", sql.Int, productId); updates.push("ProductId = @productId"); }
    if (quantity != null) { request.input("quantity", sql.Decimal(18, 3), quantity); updates.push("Quantity = @quantity"); }
    if (planYear) { request.input("planYear", sql.Int, planYear); updates.push("PlanYear = @planYear"); }
    if (planWeek) { request.input("planWeek", sql.Int, planWeek); updates.push("PlanWeek = @planWeek"); }
    if (normStatus) { request.input("status", sql.NVarChar, normStatus); updates.push("Status = @status"); }
    if (hasWarehouseCols && warehouseMaterialId != null) { request.input("warehouseMaterialId", sql.Int, whMaterial); updates.push("WarehouseMaterialId = @warehouseMaterialId"); }
    if (hasWarehouseCols && warehouseProductId != null) { request.input("warehouseProductId", sql.Int, whProduct); updates.push("WarehouseProductId = @warehouseProductId"); }

    if (updates.length) {
      updates.push("UpdatedAt = SYSDATETIME()");
      await request.query(`
        UPDATE ProductionOrders SET ${updates.join(", ")} WHERE ProductionOrderId = @id
      `);
    }

    // When status changes to COMPLETE: PRODUCTION_OUT (NVL), PRODUCTION_IN (TP)
    let stockWarning = null;
    if (normStatus === "COMPLETE" && oldStatus !== "COMPLETE") {
      const receiptDate = new Date().toISOString().slice(0, 10);
      const createdByUserId = req.user?.UserId || null;
      try {
        const bomResult = await new sql.Request(transaction).input("productId", sql.Int, prodId).query(`
          SELECT MaterialId, ConsumePerUnit FROM BomLines WHERE ProductId = @productId
        `);
        for (const bl of bomResult.recordset) {
          const consumeQty = (parseFloat(bl.ConsumePerUnit) || 0) * qty;
          if (consumeQty <= 0) continue;
          const tr1 = new sql.Request(transaction);
          await tr1.input("whId1", sql.Int, whMaterial).input("itemId1", sql.Int, bl.MaterialId)
            .input("qty1", sql.Decimal(18, 3), -consumeQty).input("date1", sql.Date, receiptDate)
            .input("refId1", sql.Int, id).input("createdBy1", sql.Int, createdByUserId)
            .query(`
              INSERT INTO StockTransactions (TransactionType, TransactionDate, WarehouseId, ItemType, ItemId, Quantity, ReferenceType, ReferenceId, CreatedBy)
              VALUES ('PRODUCTION_OUT', @date1, @whId1, 'M', @itemId1, @qty1, 'PRODUCTION_ORDER', @refId1, @createdBy1)
            `);
          const tr2 = new sql.Request(transaction);
          await tr2.input("whId2", sql.Int, whMaterial).input("itemType2", sql.Char(1), "M")
            .input("itemId2", sql.Int, bl.MaterialId).input("qty2", sql.Decimal(18, 3), -consumeQty)
            .query(`
              MERGE StockBalances AS t
              USING (SELECT @whId2 AS wh, @itemType2 AS it, @itemId2 AS iid) AS s
              ON t.WarehouseId=s.wh AND t.ItemType=s.it AND t.ItemId=s.iid
              WHEN MATCHED THEN UPDATE SET Quantity = Quantity + @qty2, LastUpdatedAt = SYSDATETIME()
              WHEN NOT MATCHED THEN INSERT (WarehouseId, ItemType, ItemId, Quantity) VALUES (@whId2, @itemType2, @itemId2, @qty2);
            `);
        }
        const tr3 = new sql.Request(transaction);
        await tr3.input("whId3", sql.Int, whProduct).input("itemId3", sql.Int, prodId)
          .input("qty3", sql.Decimal(18, 3), qty).input("date3", sql.Date, receiptDate)
          .input("refId3", sql.Int, id).input("createdBy3", sql.Int, createdByUserId)
          .query(`
            INSERT INTO StockTransactions (TransactionType, TransactionDate, WarehouseId, ItemType, ItemId, Quantity, ReferenceType, ReferenceId, CreatedBy)
            VALUES ('PRODUCTION_IN', @date3, @whId3, 'P', @itemId3, @qty3, 'PRODUCTION_ORDER', @refId3, @createdBy3)
          `);
        const tr4 = new sql.Request(transaction);
        await tr4.input("whId4", sql.Int, whProduct).input("itemType4", sql.Char(1), "P")
          .input("itemId4", sql.Int, prodId).input("qty4", sql.Decimal(18, 3), qty)
          .query(`
            MERGE StockBalances AS t
            USING (SELECT @whId4 AS wh, @itemType4 AS it, @itemId4 AS iid) AS s
            ON t.WarehouseId=s.wh AND t.ItemType=s.it AND t.ItemId=s.iid
            WHEN MATCHED THEN UPDATE SET Quantity = Quantity + @qty4, LastUpdatedAt = SYSDATETIME()
            WHEN NOT MATCHED THEN INSERT (WarehouseId, ItemType, ItemId, Quantity) VALUES (@whId4, @itemType4, @itemId4, @qty4);
          `);
      } catch (invErr) {
        stockWarning = invErr?.message || String(invErr);
        console.warn("[Production] Stock integration skipped:", stockWarning);
        console.warn("[Production] Full error:", invErr);
        // Không throw - vẫn cho phép cập nhật trạng thái COMPLETE thành công
      }
    }

    await transaction.commit();
    try {
      io.emit("production:changed", {
        type: "update",
        id,
        productId: productId ?? prodId,
        year: planYear ?? current?.PlanYear ?? null,
        week: planWeek ?? current?.PlanWeek ?? null,
        status: normStatus || null,
      });
    } catch (notifyErr) {
      console.error("[Socket] Failed to emit production:changed (update)", notifyErr);
    }
    const response = { ok: true };
    if (stockWarning) response.stockWarning = stockWarning;
    res.json(response);
  } catch (err) {
    console.error("[ProductionOrders Update Error]", err);
    try {
      if (transaction) await transaction.rollback();
    } catch (_) {}
    res.status(500).json({
      error: "Failed to update production order: " + (err.message || String(err)),
    });
  }
});

app.delete("/api/production-orders/:id", auth.requirePermission("production.edit"), async (req, res) => {
  const id = parseIntSafe(req.params.id);
  if (!id) return res.status(400).json({ error: "Invalid id" });
  try {
    const pool = await getPool();
    await pool
      .request()
      .input("id", sql.Int, id)
      .query(`DELETE FROM ProductionOrders WHERE ProductionOrderId = @id;`);
    try {
      io.emit("production:changed", {
        type: "delete",
        id,
      });
    } catch (notifyErr) {
      console.error("[Socket] Failed to emit production:changed (delete)", notifyErr);
    }

    res.json({ ok: true });
  } catch (err) {
    console.error("[ProductionOrders Delete Error]", err);
    res.status(500).json({ error: "Failed to delete production order" });
  }
});

// -------- Purchase Orders CRUD (for Purchase module) ----------
app.get("/api/purchase-orders", auth.requirePermission("purchase.view"), async (req, res) => {
  const status = (req.query.status || "").toUpperCase(); // INITIAL, CONFIRM, RECEIVED, CANCELLED, empty = all
  const supplierName = req.query.supplierName || "";
  const poNumber = req.query.poNumber || "";

  try {
    const pool = await getPool();
    const request = pool.request();
    const where = [];
    if (status) {
      request.input("status", sql.NVarChar, status);
      where.push("UPPER(po.Status) = @status");
    }
    if (supplierName) {
      request.input("supplierName", sql.NVarChar, `%${supplierName}%`);
      where.push("po.SupplierName LIKE @supplierName");
    }
    if (poNumber) {
      request.input("poNumber", sql.NVarChar, `%${poNumber}%`);
      where.push("po.PONumber LIKE @poNumber");
    }

    const whereSql = where.length ? "WHERE " + where.join(" AND ") : "";

    const result = await request.query(`
      SELECT po.PurchaseOrderId AS id,
             po.PONumber,
             po.InvoiceNumber,
             po.SupplierName,
             po.CustomerCode,
             po.WarehouseCode,
             po.Currency,
             po.InvoiceDate,
             po.TotalAmount,
             po.Status,
             po.CreatedBy,
             po.AssignedTo,
             po.CreatedAt,
             po.UpdatedAt,
             (SELECT COUNT(*) FROM PurchaseOrderLines pol WHERE pol.PurchaseOrderId = po.PurchaseOrderId) AS lineCount
      FROM PurchaseOrders po
      ${whereSql}
      ORDER BY po.CreatedAt DESC, po.PurchaseOrderId DESC;
    `);
    res.json(result.recordset);
  } catch (err) {
    console.error("[PurchaseOrders List Error]", err);
    res.status(500).json({ error: "Failed to fetch purchase orders" });
  }
});

app.get("/api/purchase-orders/:id", auth.requirePermission("purchase.view"), async (req, res) => {
  const id = parseIntSafe(req.params.id);
  if (!id) return res.status(400).json({ error: "Invalid id" });
  try {
    const pool = await getPool();
    const result = await pool.request().input("id", sql.Int, id).query(`
        SELECT po.PurchaseOrderId AS id,
               po.PONumber,
               po.InvoiceNumber,
               po.SupplierName,
               po.CustomerCode,
               po.WarehouseCode,
               po.Currency,
               po.InvoiceDate,
               po.TotalAmount,
               po.Status,
               po.CreatedBy,
               po.AssignedTo,
               po.CreatedAt,
               po.UpdatedAt
        FROM PurchaseOrders po
        WHERE po.PurchaseOrderId = @id;
      `);
    if (!result.recordset.length)
      return res.status(404).json({ error: "Purchase order not found" });
    res.json(result.recordset[0]);
  } catch (err) {
    console.error("[PurchaseOrder Detail Error]", err);
    res.status(500).json({ error: "Failed to fetch purchase order" });
  }
});

app.get("/api/purchase-orders/:id/lines", auth.requirePermission("purchase.view"), async (req, res) => {
  const id = parseIntSafe(req.params.id);
  if (!id) return res.status(400).json({ error: "Invalid id" });
  try {
    const pool = await getPool();
    const result = await pool.request().input("id", sql.Int, id).query(`
        SELECT pol.PurchaseOrderLineId AS id,
               pol.PurchaseOrderId,
               pol.MaterialId,
               m.MaterialCode,
               m.MaterialName,
               pol.Quantity,
               pol.Unit,
               pol.UnitPrice,
               pol.TotalAmount,
               pol.EtaDate,
               pol.EtaYear,
               pol.EtaWeek
        FROM PurchaseOrderLines pol
        JOIN Materials m ON m.MaterialId = pol.MaterialId
        WHERE pol.PurchaseOrderId = @id
        ORDER BY pol.PurchaseOrderLineId;
      `);
    res.json(result.recordset);
  } catch (err) {
    console.error("[PurchaseOrderLines Error]", err);
    if (err.message && /Invalid column name 'EtaDate'/i.test(err.message)) {
      return res.status(503).json({ error: "Run fix_eta_date.sql first" });
    }
    res.status(500).json({ error: "Failed to fetch purchase order lines" });
  }
});

app.post("/api/purchase-orders", auth.requirePermission("purchase.add"), async (req, res) => {
  const {
    poNumber,
    invoiceNumber,
    supplierName,
    customerCode,
    warehouseCode,
    warehouseId,
    currency,
    invoiceDate,
    status,
    createdBy,
    assignedTo,
    lines,
  } = req.body || {};
  const normStatus = (status || "INITIAL").toUpperCase();
  if (!["INITIAL", "CONFIRM", "RECEIVED", "CANCELLED"].includes(normStatus))
    return res
      .status(400)
      .json({
        error: "status must be INITIAL, CONFIRM, RECEIVED or CANCELLED",
      });
  if (!Array.isArray(lines) || !lines.length)
    return res.status(400).json({ error: "lines array is required" });

  let transaction;
  try {
    const pool = await getPool();
    transaction = new sql.Transaction(pool);
    await transaction.begin();
    const request = new sql.Request(transaction);

    // Calculate total amount from lines
    const totalAmount = lines.reduce(
      (sum, line) => sum + (parseFloat(line.totalAmount) || 0),
      0
    );

    const whCode = warehouseCode || "WH-NVL";
    // Insert PurchaseOrder
    request
      .input("poNumber", sql.NVarChar, poNumber || null)
      .input("invoiceNumber", sql.NVarChar, invoiceNumber || null)
      .input("supplierName", sql.NVarChar, supplierName || null)
      .input("customerCode", sql.NVarChar, customerCode || null)
      .input("warehouseCode", sql.NVarChar, whCode)
      .input("currency", sql.NVarChar, currency || "VND")
      .input("invoiceDate", sql.Date, invoiceDate || null)
      .input("totalAmount", sql.Decimal(18, 2), totalAmount)
      .input("status", sql.NVarChar, normStatus)
      .input("createdBy", sql.NVarChar, createdBy || null)
      .input("assignedTo", sql.NVarChar, assignedTo || null);

    const poResult = await request.query(`
      INSERT INTO PurchaseOrders (PONumber, InvoiceNumber, SupplierName, CustomerCode, WarehouseCode, Currency, InvoiceDate, TotalAmount, Status, CreatedBy, AssignedTo)
      OUTPUT INSERTED.PurchaseOrderId AS id
      VALUES (@poNumber, @invoiceNumber, @supplierName, @customerCode, @warehouseCode, @currency, @invoiceDate, @totalAmount, @status, @createdBy, @assignedTo);
    `);
    const poId = poResult.recordset[0].id;

    // Insert PurchaseOrderLines (etaDate ưu tiên, tự tính etaYear/etaWeek)
    for (const line of lines) {
      const { etaDate, etaYear, etaWeek } = parseEtaFromLine(line);
      const lineRequest = new sql.Request(transaction);
      lineRequest
        .input("purchaseOrderId", sql.Int, poId)
        .input("materialId", sql.Int, line.materialId)
        .input("quantity", sql.Decimal(18, 3), line.quantity)
        .input("unit", sql.NVarChar, line.unit || "PCS")
        .input("unitPrice", sql.Decimal(18, 2), line.unitPrice || 0)
        .input("totalAmount", sql.Decimal(18, 2), line.totalAmount || 0)
        .input("etaDate", sql.Date, etaDate)
        .input("etaYear", sql.Int, etaYear)
        .input("etaWeek", sql.Int, etaWeek);
      await lineRequest.query(`
        INSERT INTO PurchaseOrderLines (PurchaseOrderId, MaterialId, Quantity, Unit, UnitPrice, TotalAmount, EtaDate, EtaYear, EtaWeek)
        VALUES (@purchaseOrderId, @materialId, @quantity, @unit, @unitPrice, @totalAmount, @etaDate, @etaYear, @etaWeek);
      `);
    }

    // Khi tạo PO với status CONFIRM: tự động tạo phiếu nhập kho (DRAFT) - nhân viên kho xác nhận khi hàng đến
    if (normStatus === "CONFIRM") {
      try {
        let effectiveWhId = 1;
        const whLookup = await new sql.Request(transaction).input("code", sql.NVarChar, whCode).query(`
          SELECT WarehouseId FROM Warehouses WHERE WarehouseCode = @code
        `);
        if (whLookup.recordset?.length) effectiveWhId = whLookup.recordset[0].WarehouseId;
        const linesResult = await new sql.Request(transaction).input("id", sql.Int, poId).query(`
          SELECT MaterialId, Quantity FROM PurchaseOrderLines WHERE PurchaseOrderId = @id
        `);
        const receiptDate = invoiceDate ? toDateString(invoiceDate) || String(invoiceDate).slice(0, 10) : new Date().toISOString().slice(0, 10);
        const nextNum = await new sql.Request(transaction).query(`
          SELECT 'RCP-' + FORMAT(GETDATE(),'yyyy') + '-' + RIGHT('000' + CAST(ISNULL(MAX(CAST(SUBSTRING(ReceiptNumber,10,4) AS INT)),0)+1 AS VARCHAR),4) AS num
          FROM StockReceipts WHERE YEAR(ReceiptDate) = YEAR(GETDATE())
        `);
        const receiptNumber = nextNum.recordset[0]?.num || "RCP-" + new Date().getFullYear() + "-0001";
        const receiptResult = await new sql.Request(transaction)
          .input("number", sql.NVarChar, receiptNumber)
          .input("warehouseId", sql.Int, effectiveWhId)
          .input("purchaseOrderId", sql.Int, poId)
          .input("date", sql.Date, receiptDate)
          .input("createdBy", sql.Int, req.user?.UserId || null)
          .query(`
            INSERT INTO StockReceipts (ReceiptNumber, WarehouseId, PurchaseOrderId, ReceiptDate, Status, Notes, CreatedBy)
            OUTPUT INSERTED.StockReceiptId AS id
            VALUES (@number, @warehouseId, @purchaseOrderId, @date, 'DRAFT', N'Tự động từ phiếu mua hàng', @createdBy)
          `);
        const receiptId = receiptResult.recordset?.[0]?.id;
        if (receiptId && linesResult.recordset?.length) {
          for (const line of linesResult.recordset) {
            const qty = parseFloat(line.Quantity) || 0;
            if (qty <= 0) continue;
            const lineReq = new sql.Request(transaction);
            await lineReq.input("receiptId", sql.Int, receiptId).input("materialId", sql.Int, line.MaterialId).input("qty", sql.Decimal(18, 3), qty)
              .query(`INSERT INTO StockReceiptLines (StockReceiptId, MaterialId, Quantity) VALUES (@receiptId, @materialId, @qty)`);
          }
        }
      } catch (stockErr) {
        if (stockErr.message && /Invalid object name|StockReceipts|StockReceiptLines/i.test(stockErr.message)) {
          console.warn("[Purchase] Stock receipt creation skipped (run fix_stock_receipt.sql):", stockErr.message);
        } else throw stockErr;
      }
    }

    await transaction.commit();

    try {
      io.emit("purchase:changed", {
        type: "create",
        id: poId,
        status: normStatus,
      });
    } catch (notifyErr) {
      console.error("[Socket] Failed to emit purchase:changed (create)", notifyErr);
    }

    await logActivity(pool, req, { menuCode: "purchase", action: "CREATE", entityType: "PurchaseOrder", entityId: poId, entitySummary: poNumber ? `PO ${poNumber}` : `Phiếu mua #${poId}` });
    res.status(201).json({ id: poId });
  } catch (err) {
    console.error("[PurchaseOrders Create Error]", err);
    try {
      if (transaction) await transaction.rollback();
    } catch (_) {}
    if (err.message && /Invalid column name 'EtaDate'/i.test(err.message)) {
      return res.status(503).json({ error: "Run fix_eta_date.sql first" });
    }
    res.status(500).json({ error: "Failed to create purchase order" });
  }
});

app.put("/api/purchase-orders/:id", auth.requirePermission("purchase.edit"), async (req, res) => {
  const id = parseIntSafe(req.params.id);
  if (!id) return res.status(400).json({ error: "Invalid id" });
  const {
    poNumber,
    invoiceNumber,
    supplierName,
    customerCode,
    warehouseCode,
    warehouseId,
    currency,
    invoiceDate,
    status,
    createdBy,
    assignedTo,
    lines,
  } = req.body || {};
  const normStatus = status ? status.toUpperCase() : null;
  if (
    normStatus &&
    !["INITIAL", "CONFIRM", "RECEIVED", "CANCELLED"].includes(normStatus)
  )
    return res
      .status(400)
      .json({
        error: "status must be INITIAL, CONFIRM, RECEIVED or CANCELLED",
      });

  let transaction;
  try {
    const pool = await getPool();
    transaction = new sql.Transaction(pool);
    await transaction.begin();
    const request = new sql.Request(transaction).input("id", sql.Int, id);

    // Fetch current PO for status/warehouse (before update)
    const currentPo = await request.query(`
      SELECT Status, WarehouseCode FROM PurchaseOrders WHERE PurchaseOrderId = @id
    `);
    const oldStatus = currentPo.recordset[0]?.Status || "";
    const oldWarehouseCode = currentPo.recordset[0]?.WarehouseCode;
    const effectiveWhCode = warehouseCode !== undefined ? (warehouseCode || "WH-NVL") : (oldWarehouseCode || "WH-NVL");

    // Update PurchaseOrder
    const updates = [];
    if (poNumber !== undefined) {
      request.input("poNumber", sql.NVarChar, poNumber || null);
      updates.push("PONumber = @poNumber");
    }
    if (invoiceNumber !== undefined) {
      request.input("invoiceNumber", sql.NVarChar, invoiceNumber || null);
      updates.push("InvoiceNumber = @invoiceNumber");
    }
    if (supplierName !== undefined) {
      request.input("supplierName", sql.NVarChar, supplierName || null);
      updates.push("SupplierName = @supplierName");
    }
    if (customerCode !== undefined) {
      request.input("customerCode", sql.NVarChar, customerCode || null);
      updates.push("CustomerCode = @customerCode");
    }
    if (warehouseCode !== undefined) {
      request.input("warehouseCode", sql.NVarChar, warehouseCode || null);
      updates.push("WarehouseCode = @warehouseCode");
    }
    if (currency !== undefined) {
      request.input("currency", sql.NVarChar, currency || "VND");
      updates.push("Currency = @currency");
    }
    if (invoiceDate !== undefined) {
      request.input("invoiceDate", sql.Date, invoiceDate || null);
      updates.push("InvoiceDate = @invoiceDate");
    }
    if (status !== undefined) {
      request.input("status", sql.NVarChar, normStatus);
      updates.push("Status = @status");
    }
    if (createdBy !== undefined) {
      request.input("createdBy", sql.NVarChar, createdBy || null);
      updates.push("CreatedBy = @createdBy");
    }
    if (assignedTo !== undefined) {
      request.input("assignedTo", sql.NVarChar, assignedTo || null);
      updates.push("AssignedTo = @assignedTo");
    }

    if (updates.length) {
      updates.push("UpdatedAt = SYSDATETIME()");
      await request.query(`
        UPDATE PurchaseOrders
        SET ${updates.join(", ")}
        WHERE PurchaseOrderId = @id;
      `);
    }

    // Update lines if provided
    if (lines && Array.isArray(lines)) {
      // Delete existing lines
      await request.query(`
        DELETE FROM PurchaseOrderLines WHERE PurchaseOrderId = @id;
      `);

      // Insert new lines (etaDate ưu tiên, tự tính etaYear/etaWeek)
      for (const line of lines) {
        const { etaDate, etaYear, etaWeek } = parseEtaFromLine(line);
        const lineRequest = new sql.Request(transaction);
        lineRequest
          .input("purchaseOrderId", sql.Int, id)
          .input("materialId", sql.Int, line.materialId)
          .input("quantity", sql.Decimal(18, 3), line.quantity)
          .input("unit", sql.NVarChar, line.unit || "PCS")
          .input("unitPrice", sql.Decimal(18, 2), line.unitPrice || 0)
          .input("totalAmount", sql.Decimal(18, 2), line.totalAmount || 0)
          .input("etaDate", sql.Date, etaDate)
          .input("etaYear", sql.Int, etaYear)
          .input("etaWeek", sql.Int, etaWeek);
        await lineRequest.query(`
          INSERT INTO PurchaseOrderLines (PurchaseOrderId, MaterialId, Quantity, Unit, UnitPrice, TotalAmount, EtaDate, EtaYear, EtaWeek)
          VALUES (@purchaseOrderId, @materialId, @quantity, @unit, @unitPrice, @totalAmount, @etaDate, @etaYear, @etaWeek);
        `);
      }

      // Recalculate total amount
      const totalResult = await request.query(`
        SELECT SUM(TotalAmount) AS total
        FROM PurchaseOrderLines
        WHERE PurchaseOrderId = @id;
      `);
      const totalAmount = totalResult.recordset[0].total || 0;
      request.input("totalAmount", sql.Decimal(18, 2), totalAmount);
      await request.query(`
        UPDATE PurchaseOrders
        SET TotalAmount = @totalAmount
        WHERE PurchaseOrderId = @id;
      `);
    }

    // Khi status chuyển sang CONFIRM: tự động tạo phiếu nhập kho (DRAFT) - nhân viên kho xác nhận khi hàng đến
    if (normStatus === "CONFIRM" && oldStatus !== "CONFIRM") {
      try {
        const existingReceipt = await new sql.Request(transaction).input("purchaseOrderId", sql.Int, id).query(`
          SELECT StockReceiptId FROM StockReceipts WHERE PurchaseOrderId = @purchaseOrderId
        `);
        if (!existingReceipt.recordset?.length) {
          let effectiveWhId = 1;
          const whLookup = await new sql.Request(transaction).input("code", sql.NVarChar, effectiveWhCode).query(`
            SELECT WarehouseId FROM Warehouses WHERE WarehouseCode = @code
          `);
          if (whLookup.recordset?.length) effectiveWhId = whLookup.recordset[0].WarehouseId;
          const linesResult = await new sql.Request(transaction).input("id", sql.Int, id).query(`
            SELECT MaterialId, Quantity FROM PurchaseOrderLines WHERE PurchaseOrderId = @id
          `);
          const receiptDate = invoiceDate ? toDateString(invoiceDate) : new Date().toISOString().slice(0, 10);
          const nextNum = await new sql.Request(transaction).query(`
            SELECT 'RCP-' + FORMAT(GETDATE(),'yyyy') + '-' + RIGHT('000' + CAST(ISNULL(MAX(CAST(SUBSTRING(ReceiptNumber,10,4) AS INT)),0)+1 AS VARCHAR),4) AS num
            FROM StockReceipts WHERE YEAR(ReceiptDate) = YEAR(GETDATE())
          `);
          const receiptNumber = nextNum.recordset[0]?.num || "RCP-" + new Date().getFullYear() + "-0001";
          const receiptResult = await new sql.Request(transaction)
            .input("number", sql.NVarChar, receiptNumber)
            .input("warehouseId", sql.Int, effectiveWhId)
            .input("purchaseOrderId", sql.Int, id)
            .input("date", sql.Date, receiptDate)
            .input("createdBy", sql.Int, req.user?.UserId || null)
            .query(`
              INSERT INTO StockReceipts (ReceiptNumber, WarehouseId, PurchaseOrderId, ReceiptDate, Status, Notes, CreatedBy)
              OUTPUT INSERTED.StockReceiptId AS id
              VALUES (@number, @warehouseId, @purchaseOrderId, @date, 'DRAFT', N'Tự động từ phiếu mua hàng', @createdBy)
            `);
          const receiptId = receiptResult.recordset?.[0]?.id;
          if (receiptId && linesResult.recordset?.length) {
            for (const line of linesResult.recordset) {
              const qty = parseFloat(line.Quantity) || 0;
              if (qty <= 0) continue;
              const lineReq = new sql.Request(transaction);
              await lineReq.input("receiptId", sql.Int, receiptId).input("materialId", sql.Int, line.MaterialId).input("qty", sql.Decimal(18, 3), qty)
                .query(`INSERT INTO StockReceiptLines (StockReceiptId, MaterialId, Quantity) VALUES (@receiptId, @materialId, @qty)`);
            }
          }
        }
      } catch (stockErr) {
        if (stockErr.message && /Invalid object name|StockReceipts|StockReceiptLines/i.test(stockErr.message)) {
          console.warn("[Purchase] Stock receipt creation skipped (run fix_stock_receipt.sql):", stockErr.message);
        } else throw stockErr;
      }
    }

    await transaction.commit();

    try {
      io.emit("purchase:changed", {
        type: "update",
        id,
        status: normStatus || null,
      });
    } catch (notifyErr) {
      console.error("[Socket] Failed to emit purchase:changed (update)", notifyErr);
    }

    await logActivity(pool, req, { menuCode: "purchase", action: "UPDATE", entityType: "PurchaseOrder", entityId: id, entitySummary: `Phiếu mua #${id}` });
    res.json({ ok: true });
  } catch (err) {
    console.error("[PurchaseOrders Update Error]", err);
    try {
      if (transaction) await transaction.rollback();
    } catch (_) {}
    if (err.message && /Invalid column name 'EtaDate'/i.test(err.message)) {
      return res.status(503).json({ error: "Run fix_eta_date.sql first" });
    }
    res.status(500).json({ error: "Failed to update purchase order" });
  }
});

app.delete("/api/purchase-orders/:id", auth.requirePermission("purchase.delete"), async (req, res) => {
  const id = parseIntSafe(req.params.id);
  if (!id) return res.status(400).json({ error: "Invalid id" });
  try {
    const pool = await getPool();
    await pool
      .request()
      .input("id", sql.Int, id)
      .query(`DELETE FROM PurchaseOrders WHERE PurchaseOrderId = @id;`);
    try {
      io.emit("purchase:changed", {
        type: "delete",
        id,
      });
    } catch (notifyErr) {
      console.error("[Socket] Failed to emit purchase:changed (delete)", notifyErr);
    }

    await logActivity(pool, req, { menuCode: "purchase", action: "DELETE", entityType: "PurchaseOrder", entityId: id, entitySummary: `Phiếu mua #${id}` });
    res.json({ ok: true });
  } catch (err) {
    console.error("[PurchaseOrders Delete Error]", err);
    res.status(500).json({ error: "Failed to delete purchase order" });
  }
});

// -------- Sales Orders CRUD (for Sales module) ----------
app.get("/api/sales-orders", auth.requirePermission("sales.view"), async (req, res) => {
  const status = (req.query.status || "").toUpperCase();
  const search = (req.query.search || "").trim();

  try {
    const pool = await getPool();
    const request = pool.request();
    const where = [];
    if (status) {
      request.input("status", sql.NVarChar, status);
      where.push("UPPER(so.Status) = @status");
    }
    if (search) {
      request.input("search", sql.NVarChar, `%${search}%`);
      where.push("(so.CustomerName LIKE @search OR so.InvoiceNumber LIKE @search OR so.CustomerCode LIKE @search)");
    }

    const whereSql = where.length ? "WHERE " + where.join(" AND ") : "";

    const result = await request.query(`
      SELECT so.SalesOrderId AS id,
             so.InvoiceNumber,
             so.CustomerName,
             so.CustomerCode,
             so.DeliveryDate,
             so.Status,
             so.Currency,
             so.TotalAmount,
             so.CreatedBy,
             so.AssignedTo,
             so.CreatedAt,
             (SELECT COUNT(*) FROM SalesOrderLines sol WHERE sol.SalesOrderId = so.SalesOrderId) AS lineCount
      FROM SalesOrders so
      ${whereSql}
      ORDER BY so.CreatedAt DESC, so.SalesOrderId DESC;
    `);
    res.json(result.recordset);
  } catch (err) {
    console.error("[SalesOrders List Error]", err);
    res.status(500).json({ error: "Failed to fetch sales orders" });
  }
});

app.get("/api/sales-orders/:id", auth.requirePermission("sales.view"), async (req, res) => {
  const id = parseIntSafe(req.params.id);
  if (!id) return res.status(400).json({ error: "Invalid id" });
  try {
    const pool = await getPool();
    const result = await pool.request().input("id", sql.Int, id).query(`
        SELECT so.SalesOrderId AS id,
               so.InvoiceNumber,
               so.CustomerName,
               so.CustomerCode,
               so.DeliveryDate,
               so.Status,
               so.Currency,
               so.TotalAmount,
               so.CreatedBy,
               so.AssignedTo,
               so.WarehouseId,
               so.CreatedAt,
               so.UpdatedAt
        FROM SalesOrders so
        WHERE so.SalesOrderId = @id;
      `);
    if (!result.recordset.length)
      return res.status(404).json({ error: "Sales order not found" });
    res.json(result.recordset[0]);
  } catch (err) {
    console.error("[SalesOrder Detail Error]", err);
    res.status(500).json({ error: "Failed to fetch sales order" });
  }
});

app.get("/api/sales-orders/:id/lines", auth.requirePermission("sales.view"), async (req, res) => {
  const id = parseIntSafe(req.params.id);
  if (!id) return res.status(400).json({ error: "Invalid id" });
  try {
    const pool = await getPool();
    const result = await pool.request().input("id", sql.Int, id).query(`
        SELECT sol.SalesOrderLineId AS id,
               sol.SalesOrderId,
               sol.ProductId,
               p.ProductCode,
               p.ProductName,
               sol.Quantity,
               sol.Unit,
               sol.UnitPrice,
               sol.TotalAmount
        FROM SalesOrderLines sol
        JOIN Products p ON p.ProductId = sol.ProductId
        WHERE sol.SalesOrderId = @id
        ORDER BY sol.SalesOrderLineId;
      `);
    res.json(result.recordset);
  } catch (err) {
    console.error("[SalesOrderLines Error]", err);
    res.status(500).json({ error: "Failed to fetch sales order lines" });
  }
});

app.post("/api/sales-orders", auth.requirePermission("sales.add"), async (req, res) => {
  const {
    invoiceNumber,
    customerName,
    customerCode,
    deliveryDate,
    status,
    currency,
    createdBy,
    assignedTo,
    warehouseId,
    lines,
  } = req.body || {};
  const normStatus = (status || "INITIAL").toUpperCase();
  if (!["INITIAL", "CONFIRM", "CANCELLED"].includes(normStatus))
    return res.status(400).json({ error: "status must be INITIAL, CONFIRM or CANCELLED" });
  if (!Array.isArray(lines) || !lines.length)
    return res.status(400).json({ error: "lines array is required" });

  let transaction;
  try {
    const pool = await getPool();
    transaction = new sql.Transaction(pool);
    await transaction.begin();
    const request = new sql.Request(transaction);

    const totalAmount = lines.reduce(
      (sum, line) => sum + (parseFloat(line.totalAmount) || 0),
      0
    );
    const warehouseIdVal = warehouseId ? parseInt(warehouseId, 10) : 2;

    request
      .input("invoiceNumber", sql.NVarChar, invoiceNumber || null)
      .input("customerName", sql.NVarChar, customerName || null)
      .input("customerCode", sql.NVarChar, customerCode || null)
      .input("deliveryDate", sql.Date, deliveryDate || null)
      .input("totalAmount", sql.Decimal(18, 2), totalAmount)
      .input("status", sql.NVarChar, normStatus)
      .input("currency", sql.NVarChar, currency || "VND")
      .input("createdBy", sql.NVarChar, createdBy || null)
      .input("assignedTo", sql.NVarChar, assignedTo || null)
      .input("warehouseId", sql.Int, warehouseIdVal);

    let soResult;
    try {
      soResult = await request.query(`
        INSERT INTO SalesOrders (InvoiceNumber, CustomerName, CustomerCode, DeliveryDate, TotalAmount, Status, Currency, CreatedBy, AssignedTo, WarehouseId)
        OUTPUT INSERTED.SalesOrderId AS id
        VALUES (@invoiceNumber, @customerName, @customerCode, @deliveryDate, @totalAmount, @status, @currency, @createdBy, @assignedTo, @warehouseId);
      `);
    } catch (colErr) {
      if (colErr.message && /Invalid column name 'WarehouseId'/i.test(colErr.message)) {
        soResult = await request.query(`
          INSERT INTO SalesOrders (InvoiceNumber, CustomerName, CustomerCode, DeliveryDate, TotalAmount, Status, Currency, CreatedBy, AssignedTo)
          OUTPUT INSERTED.SalesOrderId AS id
          VALUES (@invoiceNumber, @customerName, @customerCode, @deliveryDate, @totalAmount, @status, @currency, @createdBy, @assignedTo);
        `);
      } else throw colErr;
    }
    const soId = soResult.recordset[0].id;

    for (const line of lines) {
      const lineRequest = new sql.Request(transaction);
      lineRequest
        .input("salesOrderId", sql.Int, soId)
        .input("productId", sql.Int, line.productId)
        .input("quantity", sql.Decimal(18, 3), line.quantity)
        .input("unit", sql.NVarChar, line.unit || "PCS")
        .input("unitPrice", sql.Decimal(18, 2), line.unitPrice || 0)
        .input("totalAmount", sql.Decimal(18, 2), line.totalAmount || 0);
      await lineRequest.query(`
        INSERT INTO SalesOrderLines (SalesOrderId, ProductId, Quantity, Unit, UnitPrice, TotalAmount)
        VALUES (@salesOrderId, @productId, @quantity, @unit, @unitPrice, @totalAmount);
      `);
    }

    if (normStatus === "CONFIRM") {
      try {
        const nextNum = await new sql.Request(transaction).query(`
          SELECT 'ISS-' + FORMAT(GETDATE(),'yyyy') + '-' + RIGHT('000' + CAST(ISNULL(MAX(CAST(SUBSTRING(IssueNumber,10,4) AS INT)),0)+1 AS VARCHAR),4) AS num
          FROM StockIssues WHERE YEAR(IssueDate) = YEAR(GETDATE())
        `);
        const issueNumber = nextNum.recordset[0]?.num || "ISS-" + new Date().getFullYear() + "-0001";
        const issueDate = toDateString(deliveryDate) || new Date().toISOString().slice(0, 10);
        const issueResult = await new sql.Request(transaction)
          .input("number", sql.NVarChar, issueNumber)
          .input("warehouseId", sql.Int, warehouseIdVal)
          .input("salesOrderId", sql.Int, soId)
          .input("date", sql.Date, issueDate)
          .input("createdBy", sql.Int, req.user?.UserId || null)
          .query(`
            INSERT INTO StockIssues (IssueNumber, WarehouseId, SalesOrderId, IssueDate, Status, Notes, CreatedBy)
            OUTPUT INSERTED.StockIssueId AS id
            VALUES (@number, @warehouseId, @salesOrderId, @date, 'DRAFT', N'Tự động từ phiếu bán hàng', @createdBy)
          `);
        const issueId = issueResult.recordset?.[0]?.id;
        if (issueId) {
          for (const line of lines) {
            const qty = parseFloat(line.quantity) || 0;
            if (qty <= 0) continue;
            const lineReq = new sql.Request(transaction);
            await lineReq.input("issueId", sql.Int, issueId).input("productId", sql.Int, line.productId).input("qty", sql.Decimal(18, 3), qty)
              .query(`INSERT INTO StockIssueLines (StockIssueId, ProductId, Quantity) VALUES (@issueId, @productId, @qty)`);
          }
        }
      } catch (stockErr) {
        if (stockErr.message && /Invalid object name|StockIssues|StockIssueLines/i.test(stockErr.message)) {
          console.warn("[Sales] Stock issue creation skipped (run fix_inventory.sql):", stockErr.message);
        } else throw stockErr;
      }
    }

    await transaction.commit();

    try {
      io.emit("sales:changed", { type: "create", id: soId, status: normStatus });
    } catch (notifyErr) {
      console.error("[Socket] Failed to emit sales:changed (create)", notifyErr);
    }

    const soSummary = req.body?.invoiceNumber ? `SO ${req.body.invoiceNumber}` : `Phiếu bán #${soId}`;
    await logActivity(pool, req, { menuCode: "sales", action: "CREATE", entityType: "SalesOrder", entityId: soId, entitySummary: soSummary });
    res.status(201).json({ id: soId });
  } catch (err) {
    console.error("[SalesOrders Create Error]", err);
    try {
      if (transaction) await transaction.rollback();
    } catch (_) {}
    res.status(500).json({ error: "Failed to create sales order" });
  }
});

app.put("/api/sales-orders/:id", auth.requirePermission("sales.edit"), async (req, res) => {
  const id = parseIntSafe(req.params.id);
  if (!id) return res.status(400).json({ error: "Invalid id" });
  const {
    invoiceNumber,
    customerName,
    customerCode,
    deliveryDate,
    status,
    currency,
    createdBy,
    assignedTo,
    warehouseId,
    lines,
  } = req.body || {};
  const normStatus = status ? status.toUpperCase() : null;
  if (normStatus && !["INITIAL", "CONFIRM", "CANCELLED"].includes(normStatus))
    return res.status(400).json({ error: "status must be INITIAL, CONFIRM or CANCELLED" });

  let transaction;
  try {
    const pool = await getPool();
    transaction = new sql.Transaction(pool);
    await transaction.begin();
    const request = new sql.Request(transaction).input("id", sql.Int, id);

    const currentOrder = await request.query(`SELECT Status, DeliveryDate, WarehouseId FROM SalesOrders WHERE SalesOrderId = @id`);
    const oldStatus = currentOrder.recordset[0]?.Status || "";
    const oldWarehouseId = currentOrder.recordset[0]?.WarehouseId;

    const updates = [];
    if (invoiceNumber !== undefined) {
      request.input("invoiceNumber", sql.NVarChar, invoiceNumber || null);
      updates.push("InvoiceNumber = @invoiceNumber");
    }
    if (customerName !== undefined) {
      request.input("customerName", sql.NVarChar, customerName || null);
      updates.push("CustomerName = @customerName");
    }
    if (customerCode !== undefined) {
      request.input("customerCode", sql.NVarChar, customerCode || null);
      updates.push("CustomerCode = @customerCode");
    }
    if (deliveryDate !== undefined) {
      request.input("deliveryDate", sql.Date, deliveryDate || null);
      updates.push("DeliveryDate = @deliveryDate");
    }
    if (normStatus) {
      request.input("status", sql.NVarChar, normStatus);
      updates.push("Status = @status");
    }
    if (currency !== undefined) {
      request.input("currency", sql.NVarChar, currency || "VND");
      updates.push("Currency = @currency");
    }
    if (createdBy !== undefined) {
      request.input("createdBy", sql.NVarChar, createdBy || null);
      updates.push("CreatedBy = @createdBy");
    }
    if (assignedTo !== undefined) {
      request.input("assignedTo", sql.NVarChar, assignedTo || null);
      updates.push("AssignedTo = @assignedTo");
    }
    if (warehouseId !== undefined) {
      request.input("warehouseId", sql.Int, warehouseId ? parseInt(warehouseId, 10) : 2);
      updates.push("WarehouseId = @warehouseId");
    }

    if (updates.length) {
      updates.push("UpdatedAt = SYSDATETIME()");
      try {
        await request.query(`UPDATE SalesOrders SET ${updates.join(", ")} WHERE SalesOrderId = @id;`);
      } catch (colErr) {
        if (colErr.message && /Invalid column name 'WarehouseId'/i.test(colErr.message) && warehouseId !== undefined) {
          updates = updates.filter(u => !u.includes("WarehouseId"));
          if (updates.length > 1) await request.query(`UPDATE SalesOrders SET ${updates.join(", ")} WHERE SalesOrderId = @id;`);
        } else throw colErr;
      }
    }

    if (lines && Array.isArray(lines)) {
      await request.query(`DELETE FROM SalesOrderLines WHERE SalesOrderId = @id;`);

      for (const line of lines) {
        const lineRequest = new sql.Request(transaction);
        lineRequest
          .input("salesOrderId", sql.Int, id)
          .input("productId", sql.Int, line.productId)
          .input("quantity", sql.Decimal(18, 3), line.quantity)
          .input("unit", sql.NVarChar, line.unit || "PCS")
          .input("unitPrice", sql.Decimal(18, 2), line.unitPrice || 0)
          .input("totalAmount", sql.Decimal(18, 2), line.totalAmount || 0);
        await lineRequest.query(`
          INSERT INTO SalesOrderLines (SalesOrderId, ProductId, Quantity, Unit, UnitPrice, TotalAmount)
          VALUES (@salesOrderId, @productId, @quantity, @unit, @unitPrice, @totalAmount);
        `);
      }

      const totalResult = await request.query(`
        SELECT SUM(TotalAmount) AS total FROM SalesOrderLines WHERE SalesOrderId = @id;
      `);
      const totalAmount = totalResult.recordset[0].total || 0;
      request.input("totalAmount", sql.Decimal(18, 2), totalAmount);
      await request.query(`
        UPDATE SalesOrders SET TotalAmount = @totalAmount WHERE SalesOrderId = @id;
      `);
    }

    if (normStatus === "CONFIRM" && oldStatus !== "CONFIRM") {
      try {
        const existingIssue = await new sql.Request(transaction).input("salesOrderId", sql.Int, id).query(`
          SELECT StockIssueId FROM StockIssues WHERE SalesOrderId = @salesOrderId
        `);
        if (!existingIssue.recordset?.length) {
          const soData = await new sql.Request(transaction).input("id", sql.Int, id).query(`
            SELECT DeliveryDate, WarehouseId FROM SalesOrders WHERE SalesOrderId = @id
          `);
          const so = soData.recordset[0];
          const whId = so?.WarehouseId || warehouseId ? parseInt(warehouseId, 10) : 2;
          const issueDate = toDateString(so?.DeliveryDate) || new Date().toISOString().slice(0, 10);
          const linesResult = await new sql.Request(transaction).input("id", sql.Int, id).query(`
            SELECT ProductId, Quantity FROM SalesOrderLines WHERE SalesOrderId = @id
          `);
          const nextNum = await new sql.Request(transaction).query(`
            SELECT 'ISS-' + FORMAT(GETDATE(),'yyyy') + '-' + RIGHT('000' + CAST(ISNULL(MAX(CAST(SUBSTRING(IssueNumber,10,4) AS INT)),0)+1 AS VARCHAR),4) AS num
            FROM StockIssues WHERE YEAR(IssueDate) = YEAR(GETDATE())
          `);
          const issueNumber = nextNum.recordset[0]?.num || "ISS-" + new Date().getFullYear() + "-0001";
          const issueResult = await new sql.Request(transaction)
            .input("number", sql.NVarChar, issueNumber)
            .input("warehouseId", sql.Int, whId)
            .input("salesOrderId", sql.Int, id)
            .input("date", sql.Date, issueDate)
            .input("createdBy", sql.Int, req.user?.UserId || null)
            .query(`
              INSERT INTO StockIssues (IssueNumber, WarehouseId, SalesOrderId, IssueDate, Status, Notes, CreatedBy)
              OUTPUT INSERTED.StockIssueId AS id
              VALUES (@number, @warehouseId, @salesOrderId, @date, 'DRAFT', N'Tự động từ phiếu bán hàng', @createdBy)
            `);
          const issueId = issueResult.recordset?.[0]?.id;
          if (issueId && linesResult.recordset?.length) {
            for (const line of linesResult.recordset) {
              const qty = parseFloat(line.Quantity) || 0;
              if (qty <= 0) continue;
              const lineReq = new sql.Request(transaction);
              await lineReq.input("issueId", sql.Int, issueId).input("productId", sql.Int, line.ProductId).input("qty", sql.Decimal(18, 3), qty)
                .query(`INSERT INTO StockIssueLines (StockIssueId, ProductId, Quantity) VALUES (@issueId, @productId, @qty)`);
            }
          }
        }
      } catch (stockErr) {
        if (stockErr.message && /Invalid object name|StockIssues|StockIssueLines|Invalid column/i.test(stockErr.message)) {
          console.warn("[Sales] Stock issue creation skipped (run fix_inventory.sql):", stockErr.message);
        } else throw stockErr;
      }
    }

    await transaction.commit();

    try {
      io.emit("sales:changed", { type: "update", id, status: normStatus });
    } catch (notifyErr) {
      console.error("[Socket] Failed to emit sales:changed (update)", notifyErr);
    }

    await logActivity(pool, req, { menuCode: "sales", action: "UPDATE", entityType: "SalesOrder", entityId: id, entitySummary: `Phiếu bán #${id}` });
    res.json({ ok: true });
  } catch (err) {
    console.error("[SalesOrders Update Error]", err);
    try {
      if (transaction) await transaction.rollback();
    } catch (_) {}
    res.status(500).json({ error: "Failed to update sales order" });
  }
});

app.delete("/api/sales-orders/:id", auth.requirePermission("sales.delete"), async (req, res) => {
  const id = parseIntSafe(req.params.id);
  if (!id) return res.status(400).json({ error: "Invalid id" });
  try {
    const pool = await getPool();
    await pool
      .request()
      .input("id", sql.Int, id)
      .query(`DELETE FROM SalesOrders WHERE SalesOrderId = @id;`);
    try {
      io.emit("sales:changed", { type: "delete", id });
    } catch (notifyErr) {
      console.error("[Socket] Failed to emit sales:changed (delete)", notifyErr);
    }
    await logActivity(pool, req, { menuCode: "sales", action: "DELETE", entityType: "SalesOrder", entityId: id, entitySummary: `Phiếu bán #${id}` });
    res.json({ ok: true });
  } catch (err) {
    console.error("[SalesOrders Delete Error]", err);
    res.status(500).json({ error: "Failed to delete sales order" });
  }
});

// -------- Sales actual - SHIP_QTY từ phiếu xuất kho CONFIRM (có nguồn gốc từ phiếu bán hàng) ----------
app.get("/api/sales-actual", auth.requirePermission("mps.view"), async (req, res) => {
  const productId = parseIntSafe(req.query.productId);
  const fromYear = parseIntSafe(req.query.fromYear);
  const fromWeek = parseIntSafe(req.query.fromWeek);
  const toYear = parseIntSafe(req.query.toYear);
  const toWeek = parseIntSafe(req.query.toWeek);
  if (!fromYear || !fromWeek || !toYear || !toWeek)
    return res.status(400).json({ error: "fromYear/fromWeek/toYear/toWeek required" });
  try {
    const pool = await getPool();
    const request = pool.request();
    if (productId) request.input("productId", sql.Int, productId);
    request
      .input("fromYear", sql.Int, fromYear)
      .input("fromWeek", sql.Int, fromWeek)
      .input("toYear", sql.Int, toYear)
      .input("toWeek", sql.Int, toWeek);

    const result = await request.query(`
      SELECT sil.ProductId AS productId,
             DATEPART(YEAR, si.IssueDate) AS year,
             DATEPART(ISO_WEEK, si.IssueDate) AS week,
             SUM(sil.Quantity) AS qty
      FROM StockIssueLines sil
      JOIN StockIssues si ON si.StockIssueId = sil.StockIssueId
      WHERE si.Status = 'CONFIRM'
        AND si.SalesOrderId IS NOT NULL
        AND (DATEPART(YEAR, si.IssueDate) > @fromYear OR (DATEPART(YEAR, si.IssueDate) = @fromYear AND DATEPART(ISO_WEEK, si.IssueDate) >= @fromWeek))
        AND (DATEPART(YEAR, si.IssueDate) < @toYear OR (DATEPART(YEAR, si.IssueDate) = @toYear AND DATEPART(ISO_WEEK, si.IssueDate) <= @toWeek))
        AND (@productId IS NULL OR sil.ProductId = @productId)
      GROUP BY sil.ProductId, DATEPART(YEAR, si.IssueDate), DATEPART(ISO_WEEK, si.IssueDate)
      ORDER BY year, week
    `);
    res.json(result.recordset);
  } catch (err) {
    if (err.message && /Invalid object name|StockIssues|StockIssueLines/i.test(err.message)) {
      return res.json([]);
    }
    console.error("[Sales Actual Error]", err);
    res.status(500).json({ error: "Failed to fetch sales actual" });
  }
});

// -------- Sales plan (SHIP_QTY forecast) ----------
app.get("/api/sales-plan", auth.requirePermission("mps.view"), async (req, res) => {
  const productId = parseIntSafe(req.query.productId);
  const fromYear = parseIntSafe(req.query.fromYear);
  const fromWeek = parseIntSafe(req.query.fromWeek);
  const toYear = parseIntSafe(req.query.toYear);
  const toWeek = parseIntSafe(req.query.toWeek);
  if (!productId || !fromYear || !fromWeek || !toYear || !toWeek)
    return res.status(400).json({ error: "productId/from/to required" });
  try {
    const pool = await getPool();
    const result = await pool
      .request()
      .input("productId", sql.Int, productId)
      .input("fromYear", sql.Int, fromYear)
      .input("fromWeek", sql.Int, fromWeek)
      .input("toYear", sql.Int, toYear)
      .input("toWeek", sql.Int, toWeek).query(`
        SELECT PlanYear AS year, PlanWeek AS week, ShipQty AS qty
        FROM SalesPlans
        WHERE ProductId = @productId
          AND (PlanYear > @fromYear OR (PlanYear = @fromYear AND PlanWeek >= @fromWeek))
          AND (PlanYear < @toYear OR (PlanYear = @toYear AND PlanWeek <= @toWeek))
      `);
    res.json(result.recordset);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch sales plan" });
  }
});

// Upsert sales plan for a list of weeks
app.put("/api/sales-plan", auth.requirePermission("mps.edit"), async (req, res) => {
  const { productId, plans } = req.body; // plans: [{year, week, qty}]
  if (!productId || !Array.isArray(plans))
    return res.status(400).json({ error: "productId and plans[] required" });
  let transaction;
  try {
    const pool = await getPool();
    transaction = new sql.Transaction(pool);
    await transaction.begin();
    const request = new sql.Request(transaction);

    for (const p of plans) {
      request.input("productId", sql.Int, productId);
      request.input("year", sql.Int, p.year);
      request.input("week", sql.Int, p.week);
      request.input("qty", sql.Decimal(18, 3), p.qty || 0);
      await request.query(`
        MERGE SalesPlans AS target
        USING (SELECT @productId AS ProductId, @year AS PlanYear, @week AS PlanWeek) AS src
        ON target.ProductId = src.ProductId AND target.PlanYear = src.PlanYear AND target.PlanWeek = src.PlanWeek
        WHEN MATCHED THEN
          UPDATE SET ShipQty=@qty, UpdatedAt=SYSDATETIME()
        WHEN NOT MATCHED THEN
          INSERT (ProductId, PlanYear, PlanWeek, ShipQty) VALUES (@productId, @year, @week, @qty);
      `);
      request.parameters = {}; // reset params
    }
    await transaction.commit();
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    try {
      if (transaction) await transaction.rollback();
    } catch (_) {}
    res.status(500).json({ error: "Failed to upsert sales plan" });
  }
});

// -------- Partners (Khách hàng + Nhà cung cấp) ----------
app.get("/api/partners", auth.requirePermission("partners.view"), async (req, res) => {
  const type = (req.query.type || "").toUpperCase(); // 'C' | 'S' | ''
  const search = (req.query.search || "").trim();
  const page = Math.max(1, parseIntSafe(req.query.page) || 1);
  const limit = Math.min(100, Math.max(5, parseIntSafe(req.query.limit) || 20));
  const offset = (page - 1) * limit;

  try {
    const pool = await getPool();
    const conditions = [];
    if (type === "C" || type === "S") conditions.push("PartnerType = @type");
    if (search) conditions.push("(PartnerCode LIKE @search OR PartnerName LIKE @search OR TaxCode LIKE @search OR Representative LIKE @search OR Phone LIKE @search OR Email LIKE @search OR Address LIKE @search)");
    const whereSql = conditions.length ? "WHERE " + conditions.join(" AND ") : "";

    const makeRequest = () => {
      const r = pool.request();
      r.input("limit", sql.Int, limit);
      r.input("offset", sql.Int, offset);
      if (type === "C" || type === "S") r.input("type", sql.Char(1), type);
      if (search) r.input("search", sql.NVarChar, `%${search}%`);
      return r;
    };

    const countResult = await makeRequest().query(`
      SELECT COUNT(*) AS total FROM Partners ${whereSql};
    `);
    const total = countResult.recordset[0].total;

    const result = await makeRequest().query(`
      SELECT PartnerId AS id, PartnerCode AS code, PartnerName AS name, PartnerType AS type,
             TaxCode AS taxCode, Representative AS representative, Phone AS phone, Email AS email, Address AS address,
             CreatedBy AS createdBy, CreatedAt AS createdAt, UpdatedBy AS updatedBy, UpdatedAt AS updatedAt
      FROM Partners
      ${whereSql}
      ORDER BY PartnerType, PartnerCode
      OFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY;
    `);

    res.json({
      items: result.recordset,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    });
  } catch (err) {
    console.error("[Partners API Error]", err);
    res.status(500).json({ error: "Failed to fetch partners" });
  }
});

app.get("/api/partners/:id", auth.requirePermission("partners.view"), async (req, res) => {
  const id = parseIntSafe(req.params.id);
  if (!id) return res.status(400).json({ error: "Invalid id" });
  try {
    const pool = await getPool();
    const result = await pool.request().input("id", sql.Int, id).query(`
      SELECT PartnerId AS id, PartnerCode AS code, PartnerName AS name, PartnerType AS type,
             TaxCode AS taxCode, Representative AS representative, Phone AS phone, Email AS email, Address AS address,
             CreatedBy AS createdBy, CreatedAt AS createdAt, UpdatedBy AS updatedBy, UpdatedAt AS updatedAt
      FROM Partners WHERE PartnerId = @id;
    `);
    if (!result.recordset.length)
      return res.status(404).json({ error: "Partner not found" });
    res.json(result.recordset[0]);
  } catch (err) {
    console.error("[Partners API Error]", err);
    res.status(500).json({ error: "Failed to fetch partner" });
  }
});

app.post("/api/partners", auth.requirePermission("partners.add"), async (req, res) => {
  const { code, name, type, taxCode, representative, phone, email, address, createdBy } = req.body || {};
  const partnerType = (type || "C").toUpperCase();
  if (!["C", "S"].includes(partnerType))
    return res.status(400).json({ error: "type must be C (Customer) or S (Supplier)" });
  if (!code || !name)
    return res.status(400).json({ error: "code and name are required" });

  try {
    const pool = await getPool();
    const result = await pool
      .request()
      .input("code", sql.NVarChar, code)
      .input("name", sql.NVarChar, name)
      .input("type", sql.Char(1), partnerType)
      .input("taxCode", sql.NVarChar, taxCode || null)
      .input("representative", sql.NVarChar, representative || null)
      .input("phone", sql.NVarChar, phone || null)
      .input("email", sql.NVarChar, email || null)
      .input("address", sql.NVarChar, address || null)
      .input("createdBy", sql.NVarChar, createdBy || null).query(`
        INSERT INTO Partners (PartnerCode, PartnerName, PartnerType, TaxCode, Representative, Phone, Email, Address, CreatedBy)
        OUTPUT INSERTED.PartnerId AS id
        VALUES (@code, @name, @type, @taxCode, @representative, @phone, @email, @address, @createdBy);
      `);
    const partnerId = result.recordset[0].id;
    await logActivity(pool, req, { menuCode: "partners", action: "CREATE", entityType: "Partner", entityId: partnerId, entitySummary: name ? `${code} - ${name}` : `Partner #${partnerId}` });
    res.status(201).json({ id: partnerId });
  } catch (err) {
    if (err.message && /UNIQUE|duplicate/i.test(err.message))
      return res.status(400).json({ error: "Partner code already exists for this type" });
    console.error("[Partners API Error]", err);
    res.status(500).json({ error: "Failed to create partner" });
  }
});

app.put("/api/partners/:id", auth.requirePermission("partners.edit"), async (req, res) => {
  const id = parseIntSafe(req.params.id);
  const { code, name, type, taxCode, representative, phone, email, address, updatedBy } = req.body || {};
  if (!id) return res.status(400).json({ error: "Invalid id" });

  try {
    const pool = await getPool();
    const request = pool.request().input("id", sql.Int, id);
    if (code !== undefined) request.input("code", sql.NVarChar, code);
    if (name !== undefined) request.input("name", sql.NVarChar, name);
    if (type !== undefined) {
      const t = (type || "C").toUpperCase();
      if (!["C", "S"].includes(t)) return res.status(400).json({ error: "type must be C or S" });
      request.input("type", sql.Char(1), t);
    }
    if (taxCode !== undefined) request.input("taxCode", sql.NVarChar, taxCode || null);
    if (representative !== undefined) request.input("representative", sql.NVarChar, representative || null);
    if (phone !== undefined) request.input("phone", sql.NVarChar, phone || null);
    if (email !== undefined) request.input("email", sql.NVarChar, email || null);
    if (address !== undefined) request.input("address", sql.NVarChar, address || null);
    request.input("updatedBy", sql.NVarChar, updatedBy || null);

    await request.query(`
      UPDATE Partners
      SET PartnerCode = COALESCE(@code, PartnerCode),
          PartnerName = COALESCE(@name, PartnerName),
          PartnerType = COALESCE(@type, PartnerType),
          TaxCode = @taxCode,
          Representative = @representative,
          Phone = @phone,
          Email = @email,
          Address = @address,
          UpdatedBy = @updatedBy,
          UpdatedAt = SYSDATETIME()
      WHERE PartnerId = @id;
    `);
    await logActivity(pool, req, { menuCode: "partners", action: "UPDATE", entityType: "Partner", entityId: id, entitySummary: `Partner #${id}` });
    res.json({ ok: true });
  } catch (err) {
    if (err.message && /UNIQUE|duplicate/i.test(err.message))
      return res.status(400).json({ error: "Partner code already exists for this type" });
    console.error("[Partners API Error]", err);
    res.status(500).json({ error: "Failed to update partner" });
  }
});

app.delete("/api/partners/:id", auth.requirePermission("partners.delete"), async (req, res) => {
  const id = parseIntSafe(req.params.id);
  if (!id) return res.status(400).json({ error: "Invalid id" });
  try {
    const pool = await getPool();
    await pool.request().input("id", sql.Int, id).query(`DELETE FROM Partners WHERE PartnerId = @id;`);
    await logActivity(pool, req, { menuCode: "partners", action: "DELETE", entityType: "Partner", entityId: id, entitySummary: `Partner #${id}` });
    res.json({ ok: true });
  } catch (err) {
    console.error("[Partners API Error]", err);
    res.status(500).json({ error: "Failed to delete partner" });
  }
});

// -------- Users (protected) ----------
app.get("/api/users", auth.authMiddleware, auth.requirePermission("users.view"), async (req, res) => {
  const search = (req.query.search || "").trim();
  const deptId = parseIntSafe(req.query.deptId);
  const isActive = req.query.isActive;
  const page = Math.max(1, parseIntSafe(req.query.page) || 1);
  const limit = Math.min(100, Math.max(5, parseIntSafe(req.query.limit) || 20));
  const offset = (page - 1) * limit;
  try {
    const pool = await getPool();
    const conditions = [];
    if (search) conditions.push("(u.Username LIKE @search OR u.FullName LIKE @search OR u.Email LIKE @search OR u.Phone LIKE @search)");
    if (deptId) conditions.push("u.DeptId = @deptId");
    if (isActive === "1" || isActive === "true") conditions.push("u.IsActive = 1");
    else if (isActive === "0" || isActive === "false") conditions.push("u.IsActive = 0");
    const whereSql = conditions.length ? "WHERE " + conditions.join(" AND ") : "";
    const makeReq = () => {
      const req = pool.request();
      req.input("limit", sql.Int, limit);
      req.input("offset", sql.Int, offset);
      if (search) req.input("search", sql.NVarChar, `%${search}%`);
      if (deptId) req.input("deptId", sql.Int, deptId);
      return req;
    };
    const countResult = await makeReq().query(`SELECT COUNT(*) AS total FROM Users u ${whereSql}`);
    const total = countResult.recordset[0].total;
    const result = await makeReq().query(`
      SELECT u.UserId AS id, u.Username AS username, u.FullName AS fullName, u.Email AS email, u.Phone AS phone,
             u.DeptId AS deptId, d.DeptName AS deptName, u.IsActive AS isActive,
             u.CreatedAt AS createdAt, u.LastUpdateAt AS lastUpdateAt
      FROM Users u
      LEFT JOIN Department d ON d.DeptId = u.DeptId
      ${whereSql}
      ORDER BY u.Username
      OFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY
    `);
    res.json({ items: result.recordset, total, page, limit, totalPages: Math.ceil(total / limit) });
  } catch (err) {
    console.error("[Users API]", err);
    res.status(500).json({ error: "Failed to fetch users" });
  }
});

app.get("/api/users/list", auth.authMiddleware, async (req, res) => {
  const deptId = parseIntSafe(req.query.deptId);
  try {
    const pool = await getPool();
    const request = pool.request();
    let query = `
      SELECT UserId AS id, Username AS username, FullName AS fullName, DeptId AS deptId
      FROM Users WHERE IsActive = 1
    `;
    if (deptId) {
      request.input("deptId", sql.Int, deptId);
      query += " AND DeptId = @deptId";
    }
    query += " ORDER BY FullName";
    const result = await request.query(query);
    res.json(result.recordset);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch users" });
  }
});

app.get("/api/users/:id", auth.authMiddleware, auth.requirePermission("users.view"), async (req, res) => {
  const id = parseIntSafe(req.params.id);
  if (!id) return res.status(400).json({ error: "Invalid id" });
  try {
    const pool = await getPool();
    const result = await pool.request().input("id", sql.Int, id).query(`
      SELECT u.UserId AS id, u.Username, u.FullName, u.Email, u.Phone, u.DeptId, u.IsActive,
             u.CreatedAt, u.CreatedBy, u.LastUpdateAt, u.LastUpdateBy,
             d.DeptName
      FROM Users u LEFT JOIN Department d ON d.DeptId = u.DeptId
      WHERE u.UserId = @id
    `);
    if (!result.recordset.length) return res.status(404).json({ error: "User not found" });
    const user = result.recordset[0];
    const roles = await pool.request().input("userId", sql.Int, id).query(`
      SELECT r.RoleId, r.RoleCode, r.RoleName FROM UserRoles ur
      JOIN Roles r ON r.RoleId = ur.RoleId WHERE ur.UserId = @userId
    `);
    user.roles = roles.recordset;
    res.json(user);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch user" });
  }
});

app.post("/api/users", auth.authMiddleware, auth.requirePermission("users.add"), async (req, res) => {
  const { username, password, fullName, email, phone, deptId, isActive, roleIds } = req.body || {};
  if (!username || !password || !fullName) {
    return res.status(400).json({ error: "Username, password and fullName required" });
  }
  try {
    const pool = await getPool();
    const hash = await auth.hashPassword(password);
    const result = await pool
      .request()
      .input("username", sql.NVarChar, username)
      .input("hash", sql.NVarChar, hash)
      .input("fullName", sql.NVarChar, fullName)
      .input("email", sql.NVarChar, email || null)
      .input("phone", sql.NVarChar, phone || null)
      .input("deptId", sql.Int, deptId || null)
      .input("isActive", sql.Bit, isActive !== false)
      .input("createdBy", sql.Int, req.user?.UserId || null)
      .query(`
        INSERT INTO Users (Username, PasswordHash, FullName, Email, Phone, DeptId, IsActive, CreatedBy)
        OUTPUT INSERTED.UserId AS id
        VALUES (@username, @hash, @fullName, @email, @phone, @deptId, @isActive, @createdBy)
      `);
    const newId = result.recordset[0].id;
    if (roleIds && Array.isArray(roleIds) && roleIds.length) {
      for (const roleId of roleIds) {
        await pool.request().input("userId", sql.Int, newId).input("roleId", sql.Int, roleId).query(`
          INSERT INTO UserRoles (UserId, RoleId) VALUES (@userId, @roleId)
        `);
      }
    } else {
      await pool.request().input("userId", sql.Int, newId).input("roleId", sql.Int, 4).query(`
        INSERT INTO UserRoles (UserId, RoleId) VALUES (@userId, @roleId)
      `);
    }
    res.status(201).json({ id: newId });
  } catch (err) {
    if (err.message && /UNIQUE|duplicate/i.test(err.message)) {
      return res.status(400).json({ error: "Username already exists" });
    }
    console.error("[Users API]", err);
    res.status(500).json({ error: "Failed to create user" });
  }
});

app.put("/api/users/:id", auth.authMiddleware, auth.requirePermission("users.edit"), async (req, res) => {
  const id = parseIntSafe(req.params.id);
  const { username, fullName, email, phone, deptId, isActive, password, roleIds } = req.body || {};
  if (!id) return res.status(400).json({ error: "Invalid id" });
  try {
    const pool = await getPool();
    const r = pool.request().input("id", sql.Int, id);
    if (username !== undefined) r.input("username", sql.NVarChar, username);
    if (fullName !== undefined) r.input("fullName", sql.NVarChar, fullName);
    if (email !== undefined) r.input("email", sql.NVarChar, email || null);
    if (phone !== undefined) r.input("phone", sql.NVarChar, phone || null);
    if (deptId !== undefined) r.input("deptId", sql.Int, deptId || null);
    if (isActive !== undefined) r.input("isActive", sql.Bit, isActive);
    r.input("updatedBy", sql.Int, req.user?.UserId || null);
    let setClause = "LastUpdateAt = SYSDATETIME(), LastUpdateBy = @updatedBy";
    if (username !== undefined) setClause += ", Username = @username";
    if (fullName !== undefined) setClause += ", FullName = @fullName";
    if (email !== undefined) setClause += ", Email = @email";
    if (phone !== undefined) setClause += ", Phone = @phone";
    if (deptId !== undefined) setClause += ", DeptId = @deptId";
    if (isActive !== undefined) setClause += ", IsActive = @isActive";
    if (password) {
      const hash = await auth.hashPassword(password);
      r.input("hash", sql.NVarChar, hash);
      setClause += ", PasswordHash = @hash";
    }
    await r.query(`UPDATE Users SET ${setClause} WHERE UserId = @id`);
    if (roleIds !== undefined && Array.isArray(roleIds)) {
      await pool.request().input("userId", sql.Int, id).query("DELETE FROM UserRoles WHERE UserId = @userId");
      for (const roleId of roleIds) {
        await pool.request().input("userId", sql.Int, id).input("roleId", sql.Int, roleId).query(`
          INSERT INTO UserRoles (UserId, RoleId) VALUES (@userId, @roleId)
        `);
      }
    }
    res.json({ ok: true });
  } catch (err) {
    if (err.message && /UNIQUE|duplicate/i.test(err.message)) {
      return res.status(400).json({ error: "Username already exists" });
    }
    res.status(500).json({ error: "Failed to update user" });
  }
});

app.delete("/api/users/:id", auth.authMiddleware, auth.requirePermission("users.delete"), async (req, res) => {
  const id = parseIntSafe(req.params.id);
  if (!id) return res.status(400).json({ error: "Invalid id" });
  if (id === req.user.UserId) return res.status(400).json({ error: "Cannot delete yourself" });
  try {
    const pool = await getPool();
    await pool.request().input("id", sql.Int, id).query("DELETE FROM Users WHERE UserId = @id");
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: "Failed to delete user" });
  }
});

app.get("/api/departments", auth.authMiddleware, async (req, res) => {
  try {
    const pool = await getPool();
    const result = await pool.request().query("SELECT DeptId AS id, DeptName AS name FROM Department ORDER BY DeptName");
    res.json(result.recordset);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch departments" });
  }
});

app.get("/api/roles", auth.authMiddleware, async (req, res) => {
  try {
    const pool = await getPool();
    const result = await pool.request().query("SELECT RoleId AS id, RoleCode AS code, RoleName AS name FROM Roles ORDER BY RoleCode");
    res.json(result.recordset);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch roles" });
  }
});

// -------- Inventory: Warehouses ----------
app.get("/api/warehouses", auth.authMiddleware, async (req, res) => {
  try {
    const pool = await getPool();
    const result = await pool.request().query(`
      SELECT WarehouseId AS id, WarehouseCode AS code, WarehouseName AS name, WarehouseType AS type, Address AS address, IsActive AS isActive
      FROM Warehouses ORDER BY WarehouseCode
    `);
    res.json(result.recordset);
  } catch (err) {
    if (err.message && /Invalid object name 'Warehouses'/i.test(err.message)) {
      return res.status(503).json({ error: "Run fix_inventory.sql first" });
    }
    res.status(500).json({ error: "Failed to fetch warehouses" });
  }
});

app.get("/api/warehouses/list", auth.authMiddleware, async (req, res) => {
  try {
    const pool = await getPool();
    const type = (req.query.type || "").toUpperCase();
    let query = "SELECT WarehouseId AS id, WarehouseCode AS code, WarehouseName AS name, WarehouseType AS type FROM Warehouses WHERE IsActive = 1 ORDER BY WarehouseCode";
    if (type) {
      const result = await pool.request().input("type", sql.NVarChar, type).query(`
        SELECT WarehouseId AS id, WarehouseCode AS code, WarehouseName AS name, WarehouseType AS type
        FROM Warehouses WHERE IsActive = 1 AND WarehouseType = @type ORDER BY WarehouseCode
      `);
      return res.json(result.recordset);
    }
    const result = await pool.request().query(query);
    res.json(result.recordset);
  } catch (err) {
    if (err.message && /Invalid object name 'Warehouses'/i.test(err.message)) {
      return res.json([]);
    }
    res.status(500).json({ error: "Failed to fetch warehouses" });
  }
});

app.post("/api/warehouses", auth.authMiddleware, async (req, res) => {
  const { code, name, type, address, isActive } = req.body || {};
  if (!code || !name) return res.status(400).json({ error: "code and name required" });
  try {
    const pool = await getPool();
    const result = await pool.request()
      .input("code", sql.NVarChar, code)
      .input("name", sql.NVarChar, name)
      .input("type", sql.NVarChar, type || null)
      .input("address", sql.NVarChar, address || null)
      .input("isActive", sql.Bit, isActive !== false)
      .query(`
        INSERT INTO Warehouses (WarehouseCode, WarehouseName, WarehouseType, Address, IsActive)
        OUTPUT INSERTED.WarehouseId AS id
        VALUES (@code, @name, @type, @address, @isActive)
      `);
    res.status(201).json({ id: result.recordset[0].id });
  } catch (err) {
    if (err.message && /UNIQUE|duplicate/i.test(err.message)) {
      return res.status(400).json({ error: "Warehouse code already exists" });
    }
    res.status(500).json({ error: "Failed to create warehouse" });
  }
});

app.get("/api/warehouses/:id", auth.authMiddleware, async (req, res) => {
  const id = parseIntSafe(req.params.id);
  if (!id) return res.status(400).json({ error: "Invalid id" });
  try {
    const pool = await getPool();
    const result = await pool.request().input("id", sql.Int, id).query(`
      SELECT WarehouseId AS id, WarehouseCode AS code, WarehouseName AS name, WarehouseType AS type, Address AS address, IsActive AS isActive
      FROM Warehouses WHERE WarehouseId = @id
    `);
    if (!result.recordset.length) return res.status(404).json({ error: "Warehouse not found" });
    res.json(result.recordset[0]);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch warehouse" });
  }
});

app.put("/api/warehouses/:id", auth.authMiddleware, async (req, res) => {
  const id = parseIntSafe(req.params.id);
  const { code, name, type, address, isActive } = req.body || {};
  if (!id) return res.status(400).json({ error: "Invalid id" });
  try {
    const pool = await getPool();
    await pool.request()
      .input("id", sql.Int, id)
      .input("code", sql.NVarChar, code)
      .input("name", sql.NVarChar, name)
      .input("type", sql.NVarChar, type || null)
      .input("address", sql.NVarChar, address || null)
      .input("isActive", sql.Bit, isActive)
      .query(`
        UPDATE Warehouses SET WarehouseCode=@code, WarehouseName=@name, WarehouseType=@type, Address=@address, IsActive=@isActive, UpdatedAt=SYSDATETIME()
        WHERE WarehouseId=@id
      `);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: "Failed to update warehouse" });
  }
});

app.delete("/api/warehouses/:id", auth.authMiddleware, async (req, res) => {
  const id = parseIntSafe(req.params.id);
  if (!id) return res.status(400).json({ error: "Invalid id" });
  try {
    const pool = await getPool();
    await pool.request().input("id", sql.Int, id).query("DELETE FROM Warehouses WHERE WarehouseId=@id");
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: "Failed to delete warehouse" });
  }
});

// -------- Inventory: Stock Transactions (lịch sử phiếu nhập/xuất) ----------
app.get("/api/stock-transactions", auth.authMiddleware, auth.requirePermission("inventory.view"), async (req, res) => {
  const warehouseId = parseIntSafe(req.query.warehouseId);
  const itemCode = (req.query.itemCode || "").trim();
  const transactionType = (req.query.transactionType || "").trim().toUpperCase();
  const fromDate = (req.query.fromDate || "").trim();
  const toDate = (req.query.toDate || "").trim();
  const limit = Math.min(parseInt(req.query.limit, 10) || 500, 2000);
  try {
    const pool = await getPool();
    const request = pool.request().input("limit", sql.Int, limit);
    const conditions = ["1=1"];
    if (warehouseId) { request.input("warehouseId", sql.Int, warehouseId); conditions.push("st.WarehouseId = @warehouseId"); }
    if (itemCode) { request.input("itemCode", sql.NVarChar, itemCode); conditions.push("((st.ItemType='P' AND p.ProductCode = @itemCode) OR (st.ItemType='M' AND m.MaterialCode = @itemCode))"); }
    if (transactionType) { request.input("transactionType", sql.NVarChar, transactionType); conditions.push("st.TransactionType = @transactionType"); }
    if (fromDate) { request.input("fromDate", sql.Date, fromDate); conditions.push("st.TransactionDate >= @fromDate"); }
    if (toDate) { request.input("toDate", sql.Date, toDate); conditions.push("st.TransactionDate <= @toDate"); }
    const whereSql = conditions.join(" AND ");
    const result = await request.query(`
      SELECT st.StockTransactionId AS id, st.TransactionType AS transactionType, st.TransactionDate AS transactionDate,
             st.WarehouseId, w.WarehouseCode AS warehouseCode, w.WarehouseName AS warehouseName,
             st.ItemType AS itemType, st.ItemId AS itemId,
             CASE WHEN st.ItemType='P' THEN p.ProductCode ELSE m.MaterialCode END AS itemCode,
             CASE WHEN st.ItemType='P' THEN p.ProductName ELSE m.MaterialName END AS itemName,
             st.Quantity AS quantity, st.ReferenceType AS referenceType, st.ReferenceId AS referenceId,
             st.Notes AS notes, st.CreatedBy AS createdBy,
             u.FullName AS createdByName, u.Username AS createdByUsername,
             st.CreatedAt AS createdAt
      FROM StockTransactions st
      JOIN Warehouses w ON w.WarehouseId = st.WarehouseId
      LEFT JOIN Products p ON st.ItemType='P' AND p.ProductId=st.ItemId
      LEFT JOIN Materials m ON st.ItemType='M' AND m.MaterialId=st.ItemId
      LEFT JOIN Users u ON u.UserId = st.CreatedBy
      WHERE ${whereSql}
      ORDER BY st.CreatedAt DESC, st.StockTransactionId DESC
      OFFSET 0 ROWS FETCH NEXT @limit ROWS ONLY
    `);
    res.json(result.recordset);
  } catch (err) {
    if (err.message && /Invalid object name/i.test(err.message)) {
      return res.status(503).json({ error: "Run fix_inventory.sql first" });
    }
    res.status(500).json({ error: "Failed to fetch stock transactions" });
  }
});

// -------- Inventory: Stock Balances Debug (chi tiết giao dịch để kiểm tra) ----------
app.get("/api/stock-balances/debug", auth.authMiddleware, async (req, res) => {
  const warehouseId = parseIntSafe(req.query.warehouseId);
  const itemCode = (req.query.itemCode || "").trim();
  const dateStr = (req.query.date || "").trim();
  const today = new Date().toISOString().slice(0, 10);
  const asOfDate = dateStr || today;
  if (!itemCode) return res.status(400).json({ error: "itemCode required" });
  try {
    const pool = await getPool();
    const request = pool.request()
      .input("date", sql.Date, asOfDate)
      .input("itemCode", sql.NVarChar, itemCode);
    if (warehouseId) request.input("warehouseId", sql.Int, warehouseId);
    const whCond = warehouseId ? "AND st.WarehouseId = @warehouseId" : "";
    const rows = await request.query(`
      SELECT st.StockTransactionId, st.TransactionType, st.TransactionDate, st.Quantity,
             w.WarehouseCode, CASE WHEN st.ItemType='P' THEN p.ProductCode ELSE m.MaterialCode END AS itemCode
      FROM StockTransactions st
      JOIN Warehouses w ON w.WarehouseId = st.WarehouseId
      LEFT JOIN Products p ON st.ItemType='P' AND p.ProductId=st.ItemId
      LEFT JOIN Materials m ON st.ItemType='M' AND m.MaterialId=st.ItemId
      WHERE st.TransactionDate <= @date AND ((st.ItemType='P' AND p.ProductCode = @itemCode) OR (st.ItemType='M' AND m.MaterialCode = @itemCode))
      ${whCond}
      ORDER BY st.TransactionDate, st.StockTransactionId
    `);
    const list = rows.recordset || [];
    const sum = list.reduce((a, r) => a + parseFloat(r.Quantity || 0), 0);
    res.json({ asOfDate, transactions: list, sum });
  } catch (err) {
    res.status(500).json({ error: err.message || String(err) });
  }
});

// -------- Inventory: Đồng bộ StockBalances từ StockTransactions + OpeningBalances ----------
app.post("/api/stock-balances/sync-from-transactions", auth.authMiddleware, auth.requirePermission("inventory.edit"), async (req, res) => {
  try {
    const pool = await getPool();
    const today = new Date().toISOString().slice(0, 10);
    await pool.request().input("date", sql.Date, today).query(`
      WITH TxSum AS (
        SELECT st.WarehouseId, st.ItemType, st.ItemId, SUM(st.Quantity) AS txQty
        FROM StockTransactions st
        LEFT JOIN OpeningBalances ob ON ob.ItemType = st.ItemType AND ob.ItemId = st.ItemId
        WHERE st.TransactionDate <= @date
          AND (ob.ItemType IS NULL OR (YEAR(st.TransactionDate) > ob.StartYear OR (YEAR(st.TransactionDate) = ob.StartYear AND DATEPART(ISO_WEEK, st.TransactionDate) >= ob.StartWeek)))
        GROUP BY st.WarehouseId, st.ItemType, st.ItemId
      ),
      Ranked AS (
        SELECT tx.*, ROW_NUMBER() OVER (PARTITION BY tx.ItemType, tx.ItemId ORDER BY tx.WarehouseId) AS rn
        FROM TxSum tx
      ),
      WithOb AS (
        SELECT r.WarehouseId, r.ItemType, r.ItemId,
               r.txQty + ISNULL(CASE WHEN r.rn = 1 THEN ob.BalanceQty ELSE 0 END, 0) AS qty
        FROM Ranked r
        LEFT JOIN OpeningBalances ob ON ob.ItemType = r.ItemType AND ob.ItemId = r.ItemId
      )
      MERGE StockBalances AS t
      USING (SELECT WarehouseId, ItemType, ItemId, qty FROM WithOb) AS s ON t.WarehouseId = s.WarehouseId AND t.ItemType = s.ItemType AND t.ItemId = s.ItemId
      WHEN MATCHED THEN UPDATE SET Quantity = s.qty, LastUpdatedAt = SYSDATETIME()
      WHEN NOT MATCHED BY TARGET THEN INSERT (WarehouseId, ItemType, ItemId, Quantity) VALUES (s.WarehouseId, s.ItemType, s.ItemId, s.qty)
      WHEN NOT MATCHED BY SOURCE THEN DELETE;
    `);
    res.json({ ok: true });
  } catch (err) {
    console.error("[StockBalances Sync Error]", err);
    res.status(500).json({ error: err.message || String(err) });
  }
});

// -------- Inventory: Stock Balances (số dư tại thời điểm) ----------
// Tham số: warehouseId, itemCode (mã SP/NVL), date (YYYY-MM-DD). Không nhập = tất cả, thời điểm hiện tại
// Công thức: OpeningBalance + SUM(StockTransactions từ tuần opening đến ngày asOf) - khớp MPS (opening + stock_in + stock_out)
// Khi có itemCode: trả về TỔNG số dư (gộp tất cả kho) để khớp MPS. Khi không có itemCode: trả về theo từng kho.
app.get("/api/stock-balances", auth.authMiddleware, async (req, res) => {
  const warehouseId = parseIntSafe(req.query.warehouseId);
  const itemCode = (req.query.itemCode || "").trim();
  const dateStr = (req.query.date || "").trim();
  const today = new Date().toISOString().slice(0, 10);
  const asOfDate = dateStr || today;
  try {
    const pool = await getPool();
    const request = pool.request().input("date", sql.Date, asOfDate);
    if (warehouseId) request.input("warehouseId", sql.Int, warehouseId);
    if (itemCode) request.input("itemCode", sql.NVarChar, itemCode);
    const whCond = warehouseId ? "AND st.WarehouseId = @warehouseId" : "";
    const codeCond = itemCode ? "AND ((st.ItemType='P' AND p.ProductCode = @itemCode) OR (st.ItemType='M' AND m.MaterialCode = @itemCode))" : "";

    // Khi có itemCode: trả về TỔNG số dư (opening + tất cả giao dịch) để khớp MPS
    if (itemCode) {
      const totalResult = await request.query(`
        WITH Items AS (
          SELECT 'P' AS ItemType, ProductId AS ItemId, ProductCode AS code, ProductName AS name FROM Products WHERE ProductCode = @itemCode
          UNION ALL
          SELECT 'M', MaterialId, MaterialCode, MaterialName FROM Materials WHERE MaterialCode = @itemCode
        ),
        TxSum AS (
          SELECT st.ItemType, st.ItemId, SUM(st.Quantity) AS txQty
          FROM StockTransactions st
          LEFT JOIN Products p ON st.ItemType='P' AND p.ProductId=st.ItemId
          LEFT JOIN Materials m ON st.ItemType='M' AND m.MaterialId=st.ItemId
          LEFT JOIN OpeningBalances ob ON ob.ItemType = st.ItemType AND ob.ItemId = st.ItemId
          WHERE st.TransactionDate <= @date
            AND (ob.ItemType IS NULL OR (YEAR(st.TransactionDate) > ob.StartYear OR (YEAR(st.TransactionDate) = ob.StartYear AND DATEPART(ISO_WEEK, st.TransactionDate) >= ob.StartWeek)))
            ${codeCond}
          GROUP BY st.ItemType, st.ItemId
        )
        SELECT i.ItemType AS itemType, i.ItemId AS itemId, i.code AS itemCode, i.name AS itemName,
               ISNULL(ob.BalanceQty, 0) + ISNULL(tx.txQty, 0) AS quantity,
               @date AS balanceDate,
               N'Tổng' AS warehouseCode,
               N'Tổng' AS warehouseName
        FROM Items i
        LEFT JOIN TxSum tx ON tx.ItemType = i.ItemType AND tx.ItemId = i.ItemId
        LEFT JOIN OpeningBalances ob ON ob.ItemType = i.ItemType AND ob.ItemId = i.ItemId
        WHERE ISNULL(ob.BalanceQty, 0) + ISNULL(tx.txQty, 0) <> 0
      `);
      return res.json(totalResult.recordset || []);
    }

    // Không có itemCode: trả về theo từng kho (opening cộng vào kho có rn=1)
    const result = await request.query(`
      WITH TxSum AS (
        SELECT st.WarehouseId, st.ItemType, st.ItemId, SUM(st.Quantity) AS txQty
        FROM StockTransactions st
        JOIN Warehouses w ON w.WarehouseId = st.WarehouseId
        LEFT JOIN Products p ON st.ItemType='P' AND p.ProductId=st.ItemId
        LEFT JOIN Materials m ON st.ItemType='M' AND m.MaterialId=st.ItemId
        LEFT JOIN OpeningBalances ob ON ob.ItemType = st.ItemType AND ob.ItemId = st.ItemId
        WHERE st.TransactionDate <= @date
          AND (ob.ItemType IS NULL OR (YEAR(st.TransactionDate) > ob.StartYear OR (YEAR(st.TransactionDate) = ob.StartYear AND DATEPART(ISO_WEEK, st.TransactionDate) >= ob.StartWeek)))
          ${whCond} ${codeCond}
        GROUP BY st.WarehouseId, st.ItemType, st.ItemId
      ),
      Ranked AS (
        SELECT tx.WarehouseId, tx.ItemType, tx.ItemId, tx.txQty, ob.BalanceQty AS openingQty,
               ROW_NUMBER() OVER (PARTITION BY tx.ItemType, tx.ItemId ORDER BY tx.WarehouseId) AS rn
        FROM TxSum tx
        LEFT JOIN OpeningBalances ob ON ob.ItemType = tx.ItemType AND ob.ItemId = tx.ItemId
      ),
      WithOpening AS (
        SELECT WarehouseId, ItemType, ItemId, txQty + ISNULL(CASE WHEN rn = 1 THEN openingQty ELSE 0 END, 0) AS quantity
        FROM Ranked
      )
      SELECT w.WarehouseId, w.WarehouseCode AS warehouseCode, w.WarehouseName AS warehouseName,
             wo.ItemType AS itemType, wo.ItemId AS itemId,
             CASE WHEN wo.ItemType='P' THEN p.ProductCode ELSE m.MaterialCode END AS itemCode,
             CASE WHEN wo.ItemType='P' THEN p.ProductName ELSE m.MaterialName END AS itemName,
             wo.quantity,
             @date AS balanceDate
      FROM WithOpening wo
      JOIN Warehouses w ON w.WarehouseId = wo.WarehouseId
      LEFT JOIN Products p ON wo.ItemType='P' AND p.ProductId=wo.ItemId
      LEFT JOIN Materials m ON wo.ItemType='M' AND m.MaterialId=wo.ItemId
      WHERE wo.quantity <> 0
      ORDER BY wo.ItemType, itemCode
    `);
    res.json(result.recordset);
  } catch (err) {
    if (err.message && /Invalid object name/i.test(err.message)) {
      return res.status(503).json({ error: "Run fix_inventory.sql first" });
    }
    res.status(500).json({ error: "Failed to fetch stock balances" });
  }
});

// -------- Inventory: Stock Report by Week ----------
app.get("/api/stock-report-by-week", auth.authMiddleware, auth.requirePermission("inventory.view"), async (req, res) => {
  const year = parseIntSafe(req.query.year) || new Date().getFullYear();
  const fromWeek = parseIntSafe(req.query.fromWeek) || 1;
  const toWeek = parseIntSafe(req.query.toWeek) || 52;
  const warehouseId = parseIntSafe(req.query.warehouseId);
  try {
    const pool = await getPool();
    const request = pool.request()
      .input("year", sql.Int, year)
      .input("fromWeek", sql.Int, fromWeek)
      .input("toWeek", sql.Int, toWeek);
    let whFilter = "";
    if (warehouseId) {
      request.input("warehouseId", sql.Int, warehouseId);
      whFilter = "AND st.WarehouseId = @warehouseId";
    }
    const result = await request.query(`
      WITH Items AS (
        SELECT 'P' AS ItemType, ProductId AS ItemId, ProductCode AS code, ProductName AS name FROM Products
        UNION ALL
        SELECT 'M', MaterialId, MaterialCode, MaterialName FROM Materials
      ),
      WeeklyMovements AS (
        SELECT st.ItemType, st.ItemId, DATEPART(ISO_WEEK, st.TransactionDate) AS wk, DATEPART(YEAR, st.TransactionDate) AS yr,
               SUM(st.Quantity) AS netQty
        FROM StockTransactions st
        LEFT JOIN OpeningBalances ob ON ob.ItemType = st.ItemType AND ob.ItemId = st.ItemId
        WHERE DATEPART(YEAR, st.TransactionDate) = @year AND DATEPART(ISO_WEEK, st.TransactionDate) >= @fromWeek AND DATEPART(ISO_WEEK, st.TransactionDate) <= @toWeek
          AND (ob.ItemType IS NULL OR (DATEPART(YEAR, st.TransactionDate) > ob.StartYear OR (DATEPART(YEAR, st.TransactionDate) = ob.StartYear AND DATEPART(ISO_WEEK, st.TransactionDate) >= ob.StartWeek)))
        ${whFilter}
        GROUP BY st.ItemType, st.ItemId, DATEPART(ISO_WEEK, st.TransactionDate), DATEPART(YEAR, st.TransactionDate)
      )
      SELECT i.ItemType, i.ItemId, i.code, i.name, wm.wk, wm.netQty
      FROM Items i
      LEFT JOIN WeeklyMovements wm ON i.ItemType = wm.ItemType AND i.ItemId = wm.ItemId
      ORDER BY i.ItemType, i.code, wm.wk
    `);
    const itemsResult = await pool.request().query(`
      SELECT 'P' AS ItemType, ProductId AS ItemId, ProductCode AS code, ProductName AS name FROM Products
      UNION ALL
      SELECT 'M', MaterialId, MaterialCode, MaterialName FROM Materials
      ORDER BY ItemType, code
    `);
    const items = itemsResult.recordset;
    const movements = result.recordset || [];
    const obResult = await pool.request().query(`SELECT ItemType, ItemId, StartYear, StartWeek, BalanceQty FROM OpeningBalances`);
    const openingMap = {};
    (obResult.recordset || []).forEach(r => {
      openingMap[`${r.ItemType}_${r.ItemId}`] = {
        balance: parseFloat(r.BalanceQty) || 0,
        year: r.StartYear,
        week: r.StartWeek
      };
    });
    const stockByWeek = {};
    items.forEach(it => {
      const key = `${it.ItemType}_${it.ItemId}`;
      stockByWeek[key] = {};
      const ob = openingMap[key];
      const openingWeek = ob ? ob.week : 1;
      const openingYear = ob ? ob.year : year;
      let running = 0;
      // Khi fromWeek > openingWeek: cộng dồn từ tuần mở đầu đến trước fromWeek
      if (ob && year === openingYear && fromWeek > openingWeek) {
        running = ob.balance;
        for (let ww = openingWeek; ww < fromWeek; ww++) {
          const mov = movements.find(m => m.ItemType === it.ItemType && m.ItemId === it.ItemId && m.wk === ww);
          if (mov) running += parseFloat(mov.netQty) || 0;
        }
      }
      for (let w = fromWeek; w <= toWeek; w++) {
        const isAtOrAfterOpening = !ob || (year > openingYear || (year === openingYear && w >= openingWeek));
        if (isAtOrAfterOpening) {
          if (ob && year === openingYear && w === openingWeek) running = ob.balance;
          const mov = movements.find(m => m.ItemType === it.ItemType && m.ItemId === it.ItemId && m.wk === w);
          if (mov) running += parseFloat(mov.netQty) || 0;
        }
        stockByWeek[key][w] = running;
      }
    });
    const weekColumns = [];
    for (let w = fromWeek; w <= toWeek; w++) weekColumns.push(w);
    res.json({ items, weekColumns, year, fromWeek, toWeek, warehouseId, stockByWeek });
  } catch (err) {
    if (err.message && /Invalid object name/i.test(err.message)) {
      return res.status(503).json({ error: "Run fix_inventory.sql first" });
    }
    res.status(500).json({ error: "Failed to fetch stock report" });
  }
});

// -------- Inventory: Stock Adjustments ----------
app.get("/api/stock-adjustments", auth.authMiddleware, auth.requirePermission("inventory.view"), async (req, res) => {
  const warehouseId = parseIntSafe(req.query.warehouseId);
  const status = (req.query.status || "").toUpperCase();
  try {
    const pool = await getPool();
    const request = pool.request();
    const conditions = ["1=1"];
    if (warehouseId) { request.input("warehouseId", sql.Int, warehouseId); conditions.push("sa.WarehouseId = @warehouseId"); }
    if (status) { request.input("status", sql.NVarChar, status); conditions.push("sa.Status = @status"); }
    const result = await request.query(`
      SELECT sa.StockAdjustmentId AS id, sa.AdjustmentNumber, sa.WarehouseId, w.WarehouseCode, w.WarehouseName,
             sa.AdjustmentDate, sa.Reason, sa.Status, sa.CreatedAt, sa.ConfirmedAt,
             u1.FullName AS createdByName, u2.FullName AS confirmedByName
      FROM StockAdjustments sa
      JOIN Warehouses w ON w.WarehouseId = sa.WarehouseId
      LEFT JOIN Users u1 ON u1.UserId = sa.CreatedBy
      LEFT JOIN Users u2 ON u2.UserId = sa.ConfirmedBy
      WHERE ${conditions.join(" AND ")}
      ORDER BY sa.CreatedAt DESC
    `);
    res.json(result.recordset);
  } catch (err) {
    if (err.message && /Invalid object name/i.test(err.message)) {
      return res.status(503).json({ error: "Run fix_inventory.sql first" });
    }
    res.status(500).json({ error: "Failed to fetch adjustments" });
  }
});

app.get("/api/stock-adjustments/:id", auth.authMiddleware, auth.requirePermission("inventory.view"), async (req, res) => {
  const id = parseIntSafe(req.params.id);
  if (!id) return res.status(400).json({ error: "Invalid id" });
  try {
    const pool = await getPool();
    const header = await pool.request().input("id", sql.Int, id).query(`
      SELECT sa.*, w.WarehouseCode, w.WarehouseName,
             u1.FullName AS createdByName, u2.FullName AS confirmedByName
      FROM StockAdjustments sa
      JOIN Warehouses w ON w.WarehouseId = sa.WarehouseId
      LEFT JOIN Users u1 ON u1.UserId = sa.CreatedBy
      LEFT JOIN Users u2 ON u2.UserId = sa.ConfirmedBy
      WHERE sa.StockAdjustmentId = @id
    `);
    if (!header.recordset.length) return res.status(404).json({ error: "Not found" });
    const lines = await pool.request().input("id", sql.Int, id).query(`
      SELECT sal.*, CASE WHEN sal.ItemType='P' THEN p.ProductCode ELSE m.MaterialCode END AS itemCode,
             CASE WHEN sal.ItemType='P' THEN p.ProductName ELSE m.MaterialName END AS itemName
      FROM StockAdjustmentLines sal
      LEFT JOIN Products p ON sal.ItemType='P' AND p.ProductId=sal.ItemId
      LEFT JOIN Materials m ON sal.ItemType='M' AND m.MaterialId=sal.ItemId
      WHERE sal.StockAdjustmentId = @id
    `);
    const adj = header.recordset[0];
    adj.lines = lines.recordset;
    res.json(adj);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch adjustment" });
  }
});

app.post("/api/stock-adjustments", auth.authMiddleware, auth.requirePermission("inventory.adjust"), async (req, res) => {
  const { warehouseId, adjustmentDate, reason, lines } = req.body || {};
  if (!warehouseId || !adjustmentDate || !Array.isArray(lines) || !lines.length) {
    return res.status(400).json({ error: "warehouseId, adjustmentDate and lines required" });
  }
  try {
    const pool = await getPool();
    const nextNum = await pool.request().query(`
      SELECT 'ADJ-' + FORMAT(GETDATE(),'yyyy') + '-' + RIGHT('000' + CAST(ISNULL(MAX(CAST(SUBSTRING(AdjustmentNumber,10,4) AS INT)),0)+1 AS VARCHAR),4) AS num
      FROM StockAdjustments WHERE YEAR(AdjustmentDate) = YEAR(GETDATE())
    `);
    const adjNumber = nextNum.recordset[0]?.num || "ADJ-" + new Date().getFullYear() + "-0001";
    const adjResult = await pool.request()
      .input("number", sql.NVarChar, adjNumber)
      .input("warehouseId", sql.Int, warehouseId)
      .input("date", sql.Date, adjustmentDate)
      .input("reason", sql.NVarChar, reason || null)
      .input("createdBy", sql.Int, req.user?.UserId || null)
      .query(`
        INSERT INTO StockAdjustments (AdjustmentNumber, WarehouseId, AdjustmentDate, Reason, Status, CreatedBy)
        OUTPUT INSERTED.StockAdjustmentId AS id
        VALUES (@number, @warehouseId, @date, @reason, 'DRAFT', @createdBy)
      `);
    const adjId = adjResult.recordset[0].id;
    for (const line of lines) {
      const qtyBefore = parseFloat(line.quantityBefore) || 0;
      const qtyAdjust = parseFloat(line.quantityAdjust) || 0;
      const qtyAfter = qtyBefore + qtyAdjust;
      await pool.request()
        .input("adjId", sql.Int, adjId)
        .input("itemType", sql.Char(1), line.itemType)
        .input("itemId", sql.Int, line.itemId)
        .input("qtyBefore", sql.Decimal(18, 3), qtyBefore)
        .input("qtyAdjust", sql.Decimal(18, 3), qtyAdjust)
        .input("qtyAfter", sql.Decimal(18, 3), qtyAfter)
        .input("notes", sql.NVarChar, line.notes || null)
        .query(`
          INSERT INTO StockAdjustmentLines (StockAdjustmentId, ItemType, ItemId, QuantityBefore, QuantityAdjust, QuantityAfter, Notes)
          VALUES (@adjId, @itemType, @itemId, @qtyBefore, @qtyAdjust, @qtyAfter, @notes)
        `);
    }
    await logActivity(pool, req, { menuCode: "stock-adjustment", action: "CREATE", entityType: "StockAdjustment", entityId: adjId, entitySummary: adjNumber });
    res.status(201).json({ id: adjId, adjustmentNumber: adjNumber });
  } catch (err) {
    res.status(500).json({ error: "Failed to create adjustment" });
  }
});

app.post("/api/stock-adjustments/:id/confirm", auth.authMiddleware, auth.requirePermission("inventory.confirm"), async (req, res) => {
  const id = parseIntSafe(req.params.id);
  if (!id) return res.status(400).json({ error: "Invalid id" });
  try {
    const pool = await getPool();
    const adj = await pool.request().input("id", sql.Int, id).query(`
      SELECT * FROM StockAdjustments WHERE StockAdjustmentId=@id AND Status='DRAFT'
    `);
    if (!adj.recordset.length) return res.status(400).json({ error: "Adjustment not found or already confirmed" });
    const header = adj.recordset[0];
    const whId = header.WarehouseId;
    const adjDate = header.AdjustmentDate;
    const lines = await pool.request().input("id", sql.Int, id).query(`
      SELECT * FROM StockAdjustmentLines WHERE StockAdjustmentId=@id
    `);
    const trans = new sql.Transaction(pool);
    await trans.begin();
    try {
      const tr = new sql.Request(trans);
      for (const line of lines.recordset) {
        const qtyAdjust = parseFloat(line.QuantityAdjust) || 0;
        if (qtyAdjust === 0) continue;
        await tr.input("warehouseId", sql.Int, whId)
          .input("itemType", sql.Char(1), line.ItemType)
          .input("itemId", sql.Int, line.ItemId)
          .input("qty", sql.Decimal(18, 3), qtyAdjust)
          .input("date", sql.Date, adjDate)
          .input("refId", sql.Int, id)
          .input("createdBy", sql.Int, req.user?.UserId || null)
          .query(`
            INSERT INTO StockTransactions (TransactionType, TransactionDate, WarehouseId, ItemType, ItemId, Quantity, ReferenceType, ReferenceId, CreatedBy)
            VALUES ('ADJUSTMENT', @date, @warehouseId, @itemType, @itemId, @qty, 'ADJUSTMENT', @refId, @createdBy)
          `);
        await tr.input("warehouseId", sql.Int, whId)
          .input("itemType", sql.Char(1), line.ItemType)
          .input("itemId", sql.Int, line.ItemId)
          .input("qty", sql.Decimal(18, 3), qtyAdjust)
          .query(`
            MERGE StockBalances AS t
            USING (SELECT @warehouseId AS wh, @itemType AS it, @itemId AS iid) AS s
            ON t.WarehouseId=s.wh AND t.ItemType=s.it AND t.ItemId=s.iid
            WHEN MATCHED THEN UPDATE SET Quantity = Quantity + @qty, LastUpdatedAt = SYSDATETIME()
            WHEN NOT MATCHED THEN INSERT (WarehouseId, ItemType, ItemId, Quantity) VALUES (@warehouseId, @itemType, @itemId, @qty);
          `);
      }
      await tr.input("id", sql.Int, id).input("userId", sql.Int, req.user?.UserId || null).query(`
        UPDATE StockAdjustments SET Status='CONFIRM', ConfirmedBy=@userId, ConfirmedAt=SYSDATETIME() WHERE StockAdjustmentId=@id
      `);
      await trans.commit();
    } catch (e) {
      await trans.rollback();
      throw e;
    }
    await logActivity(pool, req, { menuCode: "stock-adjustment", action: "UPDATE", entityType: "StockAdjustment", entityId: id, entitySummary: `Phiếu điều chỉnh #${id} (xác nhận)` });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: "Failed to confirm adjustment" });
  }
});

// -------- Inventory: Stock Transfers ----------
app.get("/api/stock-transfers", auth.authMiddleware, auth.requirePermission("inventory.view"), async (req, res) => {
  const status = (req.query.status || "").toUpperCase();
  try {
    const pool = await getPool();
    const request = pool.request();
    let where = "1=1";
    if (status) { request.input("status", sql.NVarChar, status); where += " AND st.Status = @status"; }
    const result = await request.query(`
      SELECT st.StockTransferId AS id, st.TransferNumber, st.FromWarehouseId, st.ToWarehouseId, st.TransferDate, st.Status, st.CreatedAt, st.ConfirmedAt,
             w1.WarehouseCode AS fromCode, w1.WarehouseName AS fromName, w2.WarehouseCode AS toCode, w2.WarehouseName AS toName,
             u1.FullName AS createdByName, u2.FullName AS confirmedByName
      FROM StockTransfers st
      JOIN Warehouses w1 ON w1.WarehouseId = st.FromWarehouseId
      JOIN Warehouses w2 ON w2.WarehouseId = st.ToWarehouseId
      LEFT JOIN Users u1 ON u1.UserId = st.CreatedBy
      LEFT JOIN Users u2 ON u2.UserId = st.ConfirmedBy
      WHERE ${where}
      ORDER BY st.CreatedAt DESC
    `);
    res.json(result.recordset);
  } catch (err) {
    if (err.message && /Invalid object name/i.test(err.message)) return res.status(503).json({ error: "Run fix_inventory.sql first" });
    res.status(500).json({ error: "Failed to fetch transfers" });
  }
});

app.get("/api/stock-transfers/:id", auth.authMiddleware, auth.requirePermission("inventory.view"), async (req, res) => {
  const id = parseIntSafe(req.params.id);
  if (!id) return res.status(400).json({ error: "Invalid id" });
  try {
    const pool = await getPool();
    const header = await pool.request().input("id", sql.Int, id).query(`
      SELECT st.*, w1.WarehouseCode AS fromCode, w1.WarehouseName AS fromName, w2.WarehouseCode AS toCode, w2.WarehouseName AS toName,
             u1.FullName AS createdByName, u2.FullName AS confirmedByName
      FROM StockTransfers st
      JOIN Warehouses w1 ON w1.WarehouseId = st.FromWarehouseId
      JOIN Warehouses w2 ON w2.WarehouseId = st.ToWarehouseId
      LEFT JOIN Users u1 ON u1.UserId = st.CreatedBy
      LEFT JOIN Users u2 ON u2.UserId = st.ConfirmedBy
      WHERE st.StockTransferId = @id
    `);
    if (!header.recordset.length) return res.status(404).json({ error: "Not found" });
    const lines = await pool.request().input("id", sql.Int, id).query(`
      SELECT stl.*, CASE WHEN stl.ItemType='P' THEN p.ProductCode ELSE m.MaterialCode END AS itemCode,
             CASE WHEN stl.ItemType='P' THEN p.ProductName ELSE m.MaterialName END AS itemName
      FROM StockTransferLines stl
      LEFT JOIN Products p ON stl.ItemType='P' AND p.ProductId=stl.ItemId
      LEFT JOIN Materials m ON stl.ItemType='M' AND m.MaterialId=stl.ItemId
      WHERE stl.StockTransferId = @id
    `);
    const tr = header.recordset[0];
    tr.lines = lines.recordset;
    res.json(tr);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch transfer" });
  }
});

app.post("/api/stock-transfers", auth.authMiddleware, auth.requirePermission("inventory.edit"), async (req, res) => {
  const { fromWarehouseId, toWarehouseId, transferDate, notes, lines } = req.body || {};
  if (!fromWarehouseId || !toWarehouseId || fromWarehouseId === toWarehouseId || !transferDate || !Array.isArray(lines) || !lines.length) {
    return res.status(400).json({ error: "fromWarehouseId, toWarehouseId (different), transferDate and lines required" });
  }
  try {
    const pool = await getPool();
    const nextNum = await pool.request().query(`
      SELECT 'TRF-' + FORMAT(GETDATE(),'yyyy') + '-' + RIGHT('000' + CAST(ISNULL(MAX(CAST(SUBSTRING(TransferNumber,10,4) AS INT)),0)+1 AS VARCHAR),4) AS num
      FROM StockTransfers WHERE YEAR(TransferDate) = YEAR(GETDATE())
    `);
    const trfNumber = nextNum.recordset[0]?.num || "TRF-" + new Date().getFullYear() + "-0001";
    const trfResult = await pool.request()
      .input("number", sql.NVarChar, trfNumber)
      .input("fromWh", sql.Int, fromWarehouseId)
      .input("toWh", sql.Int, toWarehouseId)
      .input("date", sql.Date, transferDate)
      .input("notes", sql.NVarChar, notes || null)
      .input("createdBy", sql.Int, req.user?.UserId || null)
      .query(`
        INSERT INTO StockTransfers (TransferNumber, FromWarehouseId, ToWarehouseId, TransferDate, Status, Notes, CreatedBy)
        OUTPUT INSERTED.StockTransferId AS id
        VALUES (@number, @fromWh, @toWh, @date, 'DRAFT', @notes, @createdBy)
      `);
    const trfId = trfResult.recordset[0].id;
    for (const line of lines) {
      await pool.request()
        .input("trfId", sql.Int, trfId)
        .input("itemType", sql.Char(1), line.itemType)
        .input("itemId", sql.Int, line.itemId)
        .input("qty", sql.Decimal(18, 3), line.quantity || 0)
        .input("notes", sql.NVarChar, line.notes || null)
        .query(`
          INSERT INTO StockTransferLines (StockTransferId, ItemType, ItemId, Quantity, Notes)
          VALUES (@trfId, @itemType, @itemId, @qty, @notes)
        `);
    }
    await logActivity(pool, req, { menuCode: "stock-transfer", action: "CREATE", entityType: "StockTransfer", entityId: trfId, entitySummary: trfNumber });
    res.status(201).json({ id: trfId, transferNumber: trfNumber });
  } catch (err) {
    res.status(500).json({ error: "Failed to create transfer" });
  }
});

app.post("/api/stock-transfers/:id/confirm", auth.authMiddleware, auth.requirePermission("inventory.confirm"), async (req, res) => {
  const id = parseIntSafe(req.params.id);
  if (!id) return res.status(400).json({ error: "Invalid id" });
  try {
    const pool = await getPool();
    const trf = await pool.request().input("id", sql.Int, id).query(`
      SELECT * FROM StockTransfers WHERE StockTransferId=@id AND Status='DRAFT'
    `);
    if (!trf.recordset.length) return res.status(400).json({ error: "Transfer not found or already confirmed" });
    const header = trf.recordset[0];
    const lines = await pool.request().input("id", sql.Int, id).query(`SELECT * FROM StockTransferLines WHERE StockTransferId=@id`);
    const transaction = new sql.Transaction(pool);
    await transaction.begin();
    try {
      const tr = new sql.Request(transaction);
      for (const line of lines.recordset) {
        const qty = parseFloat(line.Quantity) || 0;
        if (qty <= 0) continue;
        await tr.input("fromWh", sql.Int, header.FromWarehouseId).input("toWh", sql.Int, header.ToWarehouseId)
          .input("itemType", sql.Char(1), line.ItemType).input("itemId", sql.Int, line.ItemId).input("qty", sql.Decimal(18, 3), -qty)
          .input("date", sql.Date, header.TransferDate).input("refId", sql.Int, id).input("createdBy", sql.Int, req.user?.UserId || null)
          .query(`INSERT INTO StockTransactions (TransactionType, TransactionDate, WarehouseId, ItemType, ItemId, Quantity, ReferenceType, ReferenceId, CreatedBy)
            VALUES ('TRANSFER_OUT', @date, @fromWh, @itemType, @itemId, @qty, 'TRANSFER', @refId, @createdBy)`);
        await tr.input("fromWh", sql.Int, header.FromWarehouseId).input("toWh", sql.Int, header.ToWarehouseId)
          .input("itemType", sql.Char(1), line.ItemType).input("itemId", sql.Int, line.ItemId).input("qty", sql.Decimal(18, 3), qty)
          .input("date", sql.Date, header.TransferDate).input("refId", sql.Int, id).input("createdBy", sql.Int, req.user?.UserId || null)
          .query(`INSERT INTO StockTransactions (TransactionType, TransactionDate, WarehouseId, ItemType, ItemId, Quantity, ReferenceType, ReferenceId, CreatedBy)
            VALUES ('TRANSFER_IN', @date, @toWh, @itemType, @itemId, @qty, 'TRANSFER', @refId, @createdBy)`);
        await tr.input("wh", sql.Int, header.FromWarehouseId).input("itemType", sql.Char(1), line.ItemType).input("itemId", sql.Int, line.ItemId).input("qty", sql.Decimal(18, 3), -qty)
          .query(`MERGE StockBalances AS t USING (SELECT @wh AS w, @itemType AS it, @itemId AS iid) AS s ON t.WarehouseId=s.w AND t.ItemType=s.it AND t.ItemId=s.iid
            WHEN MATCHED THEN UPDATE SET Quantity=Quantity+@qty, LastUpdatedAt=SYSDATETIME() WHEN NOT MATCHED THEN INSERT (WarehouseId,ItemType,ItemId,Quantity) VALUES (@wh,@itemType,@itemId,@qty)`);
        await tr.input("wh", sql.Int, header.ToWarehouseId).input("itemType", sql.Char(1), line.ItemType).input("itemId", sql.Int, line.ItemId).input("qty", sql.Decimal(18, 3), qty)
          .query(`MERGE StockBalances AS t USING (SELECT @wh AS w, @itemType AS it, @itemId AS iid) AS s ON t.WarehouseId=s.w AND t.ItemType=s.it AND t.ItemId=s.iid
            WHEN MATCHED THEN UPDATE SET Quantity=Quantity+@qty, LastUpdatedAt=SYSDATETIME() WHEN NOT MATCHED THEN INSERT (WarehouseId,ItemType,ItemId,Quantity) VALUES (@wh,@itemType,@itemId,@qty)`);
      }
      await tr.input("id", sql.Int, id).input("userId", sql.Int, req.user?.UserId || null)
        .query(`UPDATE StockTransfers SET Status='CONFIRM', ConfirmedBy=@userId, ConfirmedAt=SYSDATETIME() WHERE StockTransferId=@id`);
      await transaction.commit();
    } catch (e) {
      await transaction.rollback();
      throw e;
    }
    await logActivity(pool, req, { menuCode: "stock-transfer", action: "UPDATE", entityType: "StockTransfer", entityId: id, entitySummary: `Phiếu chuyển kho #${id} (xác nhận)` });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: "Failed to confirm transfer" });
  }
});

// -------- Inventory: Stock Receipts (Phiếu nhập kho NVL từ mua hàng) ----------
app.get("/api/stock-receipts", auth.authMiddleware, auth.requirePermission("inventory.view"), async (req, res) => {
  const warehouseId = parseIntSafe(req.query.warehouseId);
  const purchaseOrderId = parseIntSafe(req.query.purchaseOrderId);
  const status = (req.query.status || "").toUpperCase();
  try {
    const pool = await getPool();
    const request = pool.request();
    const conditions = ["1=1"];
    if (warehouseId) { request.input("warehouseId", sql.Int, warehouseId); conditions.push("sr.WarehouseId = @warehouseId"); }
    if (purchaseOrderId) { request.input("purchaseOrderId", sql.Int, purchaseOrderId); conditions.push("sr.PurchaseOrderId = @purchaseOrderId"); }
    if (status) { request.input("status", sql.NVarChar, status); conditions.push("sr.Status = @status"); }
    const result = await request.query(`
      SELECT sr.StockReceiptId AS id, sr.ReceiptNumber, sr.WarehouseId, w.WarehouseCode, w.WarehouseName, sr.PurchaseOrderId, po.PONumber, po.SupplierName,
             sr.ReceiptDate, sr.Status, sr.CreatedAt, sr.ConfirmedAt, u1.FullName AS createdByName, u2.FullName AS confirmedByName
      FROM StockReceipts sr
      JOIN Warehouses w ON w.WarehouseId = sr.WarehouseId
      LEFT JOIN PurchaseOrders po ON po.PurchaseOrderId = sr.PurchaseOrderId
      LEFT JOIN Users u1 ON u1.UserId = sr.CreatedBy
      LEFT JOIN Users u2 ON u2.UserId = sr.ConfirmedBy
      WHERE ${conditions.join(" AND ")}
      ORDER BY sr.CreatedAt DESC
    `);
    res.json(result.recordset);
  } catch (err) {
    if (err.message && /Invalid object name/i.test(err.message)) return res.status(503).json({ error: "Run fix_stock_receipt.sql first" });
    res.status(500).json({ error: "Failed to fetch stock receipts" });
  }
});

app.get("/api/stock-receipts/:id", auth.authMiddleware, auth.requirePermission("inventory.view"), async (req, res) => {
  const id = parseIntSafe(req.params.id);
  if (!id) return res.status(400).json({ error: "Invalid id" });
  try {
    const pool = await getPool();
    const header = await pool.request().input("id", sql.Int, id).query(`
      SELECT sr.*, w.WarehouseCode, w.WarehouseName, po.PONumber, po.SupplierName, po.InvoiceNumber,
             u1.FullName AS createdByName, u2.FullName AS confirmedByName
      FROM StockReceipts sr
      JOIN Warehouses w ON w.WarehouseId = sr.WarehouseId
      LEFT JOIN PurchaseOrders po ON po.PurchaseOrderId = sr.PurchaseOrderId
      LEFT JOIN Users u1 ON u1.UserId = sr.CreatedBy
      LEFT JOIN Users u2 ON u2.UserId = sr.ConfirmedBy
      WHERE sr.StockReceiptId = @id
    `);
    if (!header.recordset.length) return res.status(404).json({ error: "Not found" });
    const lines = await pool.request().input("id", sql.Int, id).query(`
      SELECT srl.*, m.MaterialCode, m.MaterialName FROM StockReceiptLines srl
      JOIN Materials m ON m.MaterialId = srl.MaterialId
      WHERE srl.StockReceiptId = @id
    `);
    const receipt = header.recordset[0];
    receipt.lines = lines.recordset;
    res.json(receipt);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch stock receipt" });
  }
});

app.post("/api/stock-receipts/:id/confirm", auth.authMiddleware, auth.requirePermission("inventory.confirm"), async (req, res) => {
  const id = parseIntSafe(req.params.id);
  if (!id) return res.status(400).json({ error: "Invalid id" });
  try {
    const pool = await getPool();
    const receipt = await pool.request().input("id", sql.Int, id).query(`
      SELECT * FROM StockReceipts WHERE StockReceiptId=@id AND Status='DRAFT'
    `);
    if (!receipt.recordset.length) return res.status(400).json({ error: "Phiếu nhập kho không tồn tại hoặc đã xác nhận" });
    const header = receipt.recordset[0];
    const lines = await pool.request().input("id", sql.Int, id).query(`SELECT * FROM StockReceiptLines WHERE StockReceiptId=@id`);
    if (!lines.recordset.length) return res.status(400).json({ error: "Phiếu nhập kho chưa có dòng chi tiết" });
    const receiptDate = toDateString(header.ReceiptDate) || new Date().toISOString().slice(0, 10);
    const transaction = new sql.Transaction(pool);
    await transaction.begin();
    try {
      for (const line of lines.recordset) {
        const qty = parseFloat(line.Quantity) || 0;
        if (qty <= 0) continue;
        const tr1 = new sql.Request(transaction);
        await tr1.input("wh1", sql.Int, header.WarehouseId).input("materialId1", sql.Int, line.MaterialId)
          .input("qty1", sql.Decimal(18, 3), qty).input("date1", sql.Date, receiptDate)
          .input("refId1", sql.Int, id).input("createdBy1", sql.Int, req.user?.UserId || null)
          .query(`INSERT INTO StockTransactions (TransactionType, TransactionDate, WarehouseId, ItemType, ItemId, Quantity, ReferenceType, ReferenceId, CreatedBy)
            VALUES ('RECEIPT', @date1, @wh1, 'M', @materialId1, @qty1, 'STOCK_RECEIPT', @refId1, @createdBy1)`);
        const tr2 = new sql.Request(transaction);
        await tr2.input("wh2", sql.Int, header.WarehouseId).input("itemType2", sql.Char(1), "M").input("itemId2", sql.Int, line.MaterialId).input("qty2", sql.Decimal(18, 3), qty)
          .query(`MERGE StockBalances AS t USING (SELECT @wh2 AS w, @itemType2 AS it, @itemId2 AS iid) AS s ON t.WarehouseId=s.w AND t.ItemType=s.it AND t.ItemId=s.iid
            WHEN MATCHED THEN UPDATE SET Quantity=Quantity+@qty2, LastUpdatedAt=SYSDATETIME() WHEN NOT MATCHED THEN INSERT (WarehouseId,ItemType,ItemId,Quantity) VALUES (@wh2,@itemType2,@itemId2,@qty2);`);
      }
      const tr3 = new sql.Request(transaction);
      await tr3.input("id3", sql.Int, id).input("userId3", sql.Int, req.user?.UserId || null)
        .query(`UPDATE StockReceipts SET Status='CONFIRM', ConfirmedBy=@userId3, ConfirmedAt=SYSDATETIME() WHERE StockReceiptId=@id3`);
      await transaction.commit();
    } catch (e) {
      await transaction.rollback();
      throw e;
    }
    try { io.emit("purchase:changed", { type: "stock_receipt_confirm", id: header.PurchaseOrderId || id }); } catch (notifyErr) { console.error("[Socket] Failed to emit purchase:changed", notifyErr); }
    await logActivity(pool, req, { menuCode: "stock-receipt", action: "UPDATE", entityType: "StockReceipt", entityId: id, entitySummary: `Phiếu nhập #${id} (xác nhận)` });
    res.json({ ok: true });
  } catch (err) {
    console.error("[StockReceipt Confirm Error]", err);
    res.status(500).json({ error: "Failed to confirm stock receipt: " + (err.message || String(err)) });
  }
});

// -------- Inventory: Stock Issues (Phiếu xuất kho bán hàng) ----------
app.get("/api/stock-issues", auth.authMiddleware, auth.requirePermission("inventory.view"), async (req, res) => {
  const warehouseId = parseIntSafe(req.query.warehouseId);
  const salesOrderId = parseIntSafe(req.query.salesOrderId);
  const status = (req.query.status || "").toUpperCase();
  try {
    const pool = await getPool();
    const request = pool.request();
    const conditions = ["1=1"];
    if (warehouseId) { request.input("warehouseId", sql.Int, warehouseId); conditions.push("si.WarehouseId = @warehouseId"); }
    if (salesOrderId) { request.input("salesOrderId", sql.Int, salesOrderId); conditions.push("si.SalesOrderId = @salesOrderId"); }
    if (status) { request.input("status", sql.NVarChar, status); conditions.push("si.Status = @status"); }
    const result = await request.query(`
      SELECT si.StockIssueId AS id, si.IssueNumber, si.WarehouseId, w.WarehouseCode, w.WarehouseName, si.SalesOrderId, so.InvoiceNumber, so.CustomerName,
             si.IssueDate, si.Status, si.CreatedAt, si.ConfirmedAt, u1.FullName AS createdByName, u2.FullName AS confirmedByName
      FROM StockIssues si
      JOIN Warehouses w ON w.WarehouseId = si.WarehouseId
      LEFT JOIN SalesOrders so ON so.SalesOrderId = si.SalesOrderId
      LEFT JOIN Users u1 ON u1.UserId = si.CreatedBy
      LEFT JOIN Users u2 ON u2.UserId = si.ConfirmedBy
      WHERE ${conditions.join(" AND ")}
      ORDER BY si.CreatedAt DESC
    `);
    res.json(result.recordset);
  } catch (err) {
    if (err.message && /Invalid object name/i.test(err.message)) return res.status(503).json({ error: "Run fix_inventory.sql first" });
    res.status(500).json({ error: "Failed to fetch stock issues" });
  }
});

app.get("/api/stock-issues/:id", auth.authMiddleware, auth.requirePermission("inventory.view"), async (req, res) => {
  const id = parseIntSafe(req.params.id);
  if (!id) return res.status(400).json({ error: "Invalid id" });
  try {
    const pool = await getPool();
    const header = await pool.request().input("id", sql.Int, id).query(`
      SELECT si.*, w.WarehouseCode, w.WarehouseName, so.InvoiceNumber, so.CustomerName, so.DeliveryDate,
             u1.FullName AS createdByName, u2.FullName AS confirmedByName
      FROM StockIssues si
      JOIN Warehouses w ON w.WarehouseId = si.WarehouseId
      LEFT JOIN SalesOrders so ON so.SalesOrderId = si.SalesOrderId
      LEFT JOIN Users u1 ON u1.UserId = si.CreatedBy
      LEFT JOIN Users u2 ON u2.UserId = si.ConfirmedBy
      WHERE si.StockIssueId = @id
    `);
    if (!header.recordset.length) return res.status(404).json({ error: "Not found" });
    const lines = await pool.request().input("id", sql.Int, id).query(`
      SELECT sil.*, p.ProductCode, p.ProductName FROM StockIssueLines sil
      JOIN Products p ON p.ProductId = sil.ProductId
      WHERE sil.StockIssueId = @id
    `);
    const issue = header.recordset[0];
    issue.lines = lines.recordset;
    res.json(issue);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch stock issue" });
  }
});

app.post("/api/stock-issues", auth.authMiddleware, auth.requirePermission("inventory.edit"), async (req, res) => {
  const { warehouseId, salesOrderId, issueDate, notes, lines } = req.body || {};
  if (!warehouseId || !issueDate || !Array.isArray(lines) || !lines.length) {
    return res.status(400).json({ error: "warehouseId, issueDate and lines required" });
  }
  try {
    const pool = await getPool();
    const nextNum = await pool.request().query(`
      SELECT 'ISS-' + FORMAT(GETDATE(),'yyyy') + '-' + RIGHT('000' + CAST(ISNULL(MAX(CAST(SUBSTRING(IssueNumber,10,4) AS INT)),0)+1 AS VARCHAR),4) AS num
      FROM StockIssues WHERE YEAR(IssueDate) = YEAR(GETDATE())
    `);
    const issueNumber = nextNum.recordset[0]?.num || "ISS-" + new Date().getFullYear() + "-0001";
    const issueResult = await pool.request()
      .input("number", sql.NVarChar, issueNumber)
      .input("warehouseId", sql.Int, warehouseId)
      .input("salesOrderId", sql.Int, salesOrderId || null)
      .input("date", sql.Date, issueDate)
      .input("notes", sql.NVarChar, notes || null)
      .input("createdBy", sql.Int, req.user?.UserId || null)
      .query(`
        INSERT INTO StockIssues (IssueNumber, WarehouseId, SalesOrderId, IssueDate, Status, Notes, CreatedBy)
        OUTPUT INSERTED.StockIssueId AS id
        VALUES (@number, @warehouseId, @salesOrderId, @date, 'DRAFT', @notes, @createdBy)
      `);
    const issueId = issueResult.recordset[0].id;
    for (const line of lines) {
      await pool.request()
        .input("issueId", sql.Int, issueId)
        .input("productId", sql.Int, line.productId)
        .input("qty", sql.Decimal(18, 3), line.quantity || 0)
        .input("notes", sql.NVarChar, line.notes || null)
        .query(`INSERT INTO StockIssueLines (StockIssueId, ProductId, Quantity, Notes) VALUES (@issueId, @productId, @qty, @notes)`);
    }
    await logActivity(pool, req, { menuCode: "stock-issue", action: "CREATE", entityType: "StockIssue", entityId: issueId, entitySummary: `${issueNumber}` });
    res.status(201).json({ id: issueId, issueNumber });
  } catch (err) {
    res.status(500).json({ error: "Failed to create stock issue" });
  }
});

app.put("/api/stock-issues/:id", auth.authMiddleware, auth.requirePermission("inventory.edit"), async (req, res) => {
  const id = parseIntSafe(req.params.id);
  if (!id) return res.status(400).json({ error: "Invalid id" });
  const { warehouseId, salesOrderId, issueDate, notes, lines } = req.body || {};
  try {
    const pool = await getPool();
    const existing = await pool.request().input("id", sql.Int, id).query(`SELECT Status FROM StockIssues WHERE StockIssueId=@id`);
    if (!existing.recordset.length) return res.status(404).json({ error: "Not found" });
    if ((existing.recordset[0].Status || "").toUpperCase() !== "DRAFT") return res.status(400).json({ error: "Chỉ sửa được phiếu DRAFT" });
    if (!warehouseId || !issueDate) return res.status(400).json({ error: "warehouseId và issueDate bắt buộc" });
    const soVal = (salesOrderId === "" || salesOrderId === null || salesOrderId === undefined) ? null : parseInt(salesOrderId, 10);
    const validLines = Array.isArray(lines) ? lines.filter(l => l.productId && (parseFloat(l.quantity) || 0) > 0) : [];
    const transaction = new sql.Transaction(pool);
    await transaction.begin();
    try {
      const updReq = new sql.Request(transaction);
      updReq.input("id", sql.Int, id).input("wh", sql.Int, parseInt(warehouseId, 10)).input("so", sql.Int, soVal)
        .input("date", sql.Date, issueDate).input("notes", sql.NVarChar, notes || null);
      await updReq.query(`UPDATE StockIssues SET WarehouseId=@wh, SalesOrderId=@so, IssueDate=@date, Notes=@notes WHERE StockIssueId=@id`);
      await new sql.Request(transaction).input("id", sql.Int, id).query(`DELETE FROM StockIssueLines WHERE StockIssueId=@id`);
      for (const line of validLines) {
        await new sql.Request(transaction).input("issueId", sql.Int, id).input("productId", sql.Int, line.productId)
          .input("qty", sql.Decimal(18, 3), line.quantity || 0)
          .query(`INSERT INTO StockIssueLines (StockIssueId, ProductId, Quantity) VALUES (@issueId, @productId, @qty)`);
      }
      await transaction.commit();
    } catch (e) {
      await transaction.rollback();
      throw e;
    }
    await logActivity(pool, req, { menuCode: "stock-issue", action: "UPDATE", entityType: "StockIssue", entityId: id, entitySummary: `Phiếu xuất #${id}` });
    res.json({ ok: true });
  } catch (err) {
    console.error("[StockIssue PUT Error]", err);
    res.status(500).json({ error: "Failed to update stock issue: " + (err.message || String(err)) });
  }
});

app.post("/api/stock-issues/:id/confirm", auth.authMiddleware, auth.requirePermission("inventory.confirm"), async (req, res) => {
  const id = parseIntSafe(req.params.id);
  if (!id) return res.status(400).json({ error: "Invalid id" });
  try {
    const pool = await getPool();
    const issue = await pool.request().input("id", sql.Int, id).query(`
      SELECT * FROM StockIssues WHERE StockIssueId=@id AND Status='DRAFT'
    `);
    if (!issue.recordset.length) return res.status(400).json({ error: "Stock issue not found or already confirmed" });
    const header = issue.recordset[0];
    const lines = await pool.request().input("id", sql.Int, id).query(`SELECT * FROM StockIssueLines WHERE StockIssueId=@id`);
    if (!lines.recordset.length) return res.status(400).json({ error: "Phiếu xuất kho chưa có dòng chi tiết" });
    const issueDate = toDateString(header.IssueDate) || new Date().toISOString().slice(0, 10);
    const transaction = new sql.Transaction(pool);
    await transaction.begin();
    try {
      for (const line of lines.recordset) {
        const qty = parseFloat(line.Quantity) || 0;
        if (qty <= 0) continue;
        const tr1 = new sql.Request(transaction);
        await tr1.input("wh1", sql.Int, header.WarehouseId).input("productId1", sql.Int, line.ProductId)
          .input("qty1", sql.Decimal(18, 3), -qty).input("date1", sql.Date, issueDate)
          .input("refId1", sql.Int, id).input("createdBy1", sql.Int, req.user?.UserId || null)
          .query(`INSERT INTO StockTransactions (TransactionType, TransactionDate, WarehouseId, ItemType, ItemId, Quantity, ReferenceType, ReferenceId, CreatedBy)
            VALUES ('ISSUE', @date1, @wh1, 'P', @productId1, @qty1, 'STOCK_ISSUE', @refId1, @createdBy1)`);
        const tr2 = new sql.Request(transaction);
        await tr2.input("wh2", sql.Int, header.WarehouseId).input("itemType2", sql.Char(1), "P").input("itemId2", sql.Int, line.ProductId).input("qty2", sql.Decimal(18, 3), -qty)
          .query(`MERGE StockBalances AS t USING (SELECT @wh2 AS w, @itemType2 AS it, @itemId2 AS iid) AS s ON t.WarehouseId=s.w AND t.ItemType=s.it AND t.ItemId=s.iid
            WHEN MATCHED THEN UPDATE SET Quantity=Quantity+@qty2, LastUpdatedAt=SYSDATETIME() WHEN NOT MATCHED THEN INSERT (WarehouseId,ItemType,ItemId,Quantity) VALUES (@wh2,@itemType2,@itemId2,@qty2);`);
      }
      const tr3 = new sql.Request(transaction);
      await tr3.input("id3", sql.Int, id).input("userId3", sql.Int, req.user?.UserId || null)
        .query(`UPDATE StockIssues SET Status='CONFIRM', ConfirmedBy=@userId3, ConfirmedAt=SYSDATETIME() WHERE StockIssueId=@id3`);
      await transaction.commit();
    } catch (e) {
      await transaction.rollback();
      throw e;
    }
    await logActivity(pool, req, { menuCode: "stock-issue", action: "UPDATE", entityType: "StockIssue", entityId: id, entitySummary: `Phiếu xuất #${id} (xác nhận)` });
    res.json({ ok: true });
  } catch (err) {
    console.error("[StockIssue Confirm Error]", err);
    res.status(500).json({ error: "Failed to confirm stock issue: " + (err.message || String(err)) });
  }
});

// Fallback to index.html for SPA-like refresh on nested paths
// Must be LAST to avoid catching static file requests
app.get("*", (req, res) => {
  // Don't serve HTML for asset requests (CSS, JS, images, etc.)
  if (
    req.path.match(/\.(css|js|png|jpg|jpeg|gif|ico|svg|woff|woff2|ttf|eot)$/)
  ) {
    return res.status(404).send("Not found");
  }
  // res.sendFile(path.join(__dirname, "/modules/MPS/index.html"));
  res.sendFile(path.join(__dirname, "index.html"));
});

const port = process.env.PORT || 3000;
server.listen(port, async () => {
  console.log(`Server running on http://localhost:${port}`);
  try {
    await auth.ensureAdminUser();
  } catch (err) {
    console.warn("[Auth] ensureAdminUser skipped (tables may not exist yet - run fix_auth.sql):", err.message);
  }
});
