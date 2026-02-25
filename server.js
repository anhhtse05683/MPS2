require("dotenv").config();
const path = require("path");
const express = require("express");
const cors = require("cors");
const multer = require("multer");
const xlsx = require("xlsx");
const http = require("http");
const { Server } = require("socket.io");
const { getPool, sql } = require("./src/db");

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
// Serve static assets from modules (CSS, JS, images, etc.)
app.use("/modules", express.static(path.join(__dirname, "modules")));

const parseIntSafe = (v) =>
  v === undefined || v === null || v === "" ? null : parseInt(v, 10);

// -------- Products ----------
app.get("/api/products", async (_req, res) => {
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
app.get("/api/materials", async (req, res) => {
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

// -------- Opening balance (get) ----------
app.get("/api/opening-balance/:type/:id", async (req, res) => {
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
app.put("/api/opening-balance", async (req, res) => {
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

// -------- Production (ACTIVE/COMPLETE) ----------
app.get("/api/production", async (req, res) => {
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

// -------- Purchase (CONFIRM) - for MPS module ----------
app.get("/api/purchase", async (req, res) => {
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
    const result = await pool
      .request()
      .input("materialId", sql.Int, materialId)
      .input("fromYear", sql.Int, fromYear)
      .input("fromWeek", sql.Int, fromWeek)
      .input("toYear", sql.Int, toYear)
      .input("toWeek", sql.Int, toWeek).query(`
        SELECT pol.MaterialId AS materialId, pol.EtaYear AS year, pol.EtaWeek AS week, SUM(pol.Quantity) AS qty
        FROM PurchaseOrderLines pol
        JOIN PurchaseOrders po ON po.PurchaseOrderId = pol.PurchaseOrderId
        WHERE UPPER(po.Status) = 'CONFIRM'
          AND (pol.EtaYear > @fromYear OR (pol.EtaYear = @fromYear AND pol.EtaWeek >= @fromWeek))
          AND (pol.EtaYear < @toYear OR (pol.EtaYear = @toYear AND pol.EtaWeek <= @toWeek))
          AND (@materialId IS NULL OR pol.MaterialId = @materialId)
        GROUP BY pol.MaterialId, pol.EtaYear, pol.EtaWeek
      `);
    res.json(result.recordset);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch purchase" });
  }
});

// -------- Item master (Products + Materials) ----------
app.get("/api/items", async (req, res) => {
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

app.post("/api/items", async (req, res) => {
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

    res.status(201).json({ id: newId });
  } catch (err) {
    console.error("[Items API Create Error]", err);
    res.status(500).json({ error: "Failed to create item" });
  }
});

app.put("/api/items/:type/:id", async (req, res) => {
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

    res.json({ ok: true });
  } catch (err) {
    console.error("[Items API Update Error]", err);
    res.status(500).json({ error: "Failed to update item" });
  }
});

app.delete("/api/items/:type/:id", async (req, res) => {
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
    res.json({ ok: true });
  } catch (err) {
    console.error("[Items API Delete Error]", err);
    res.status(500).json({ error: "Failed to delete item" });
  }
});

// Bulk import items from Excel
app.post("/api/items/import", upload.single("file"), async (req, res) => {
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
app.get("/api/production-orders", async (req, res) => {
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

app.post("/api/production-orders", async (req, res) => {
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

app.put("/api/production-orders/:id", async (req, res) => {
  const id = parseIntSafe(req.params.id);
  if (!id) return res.status(400).json({ error: "Invalid id" });
  const { productId, quantity, planYear, planWeek, status } = req.body || {};
  const normStatus = status ? status.toUpperCase() : null;
  if (normStatus && !["INITIAL", "ACTIVE", "COMPLETE"].includes(normStatus))
    return res
      .status(400)
      .json({ error: "status must be INITIAL, ACTIVE or COMPLETE" });

  try {
    const pool = await getPool();
    const request = pool.request().input("id", sql.Int, id);
    if (productId) request.input("productId", sql.Int, productId);
    if (quantity != null)
      request.input("quantity", sql.Decimal(18, 3), quantity);
    if (planYear) request.input("planYear", sql.Int, planYear);
    if (planWeek) request.input("planWeek", sql.Int, planWeek);
    if (normStatus) request.input("status", sql.NVarChar, normStatus);

    await request.query(`
      UPDATE ProductionOrders
      SET ProductId = COALESCE(@productId, ProductId),
          Quantity = COALESCE(@quantity, Quantity),
          PlanYear = COALESCE(@planYear, PlanYear),
          PlanWeek = COALESCE(@planWeek, PlanWeek),
          Status = COALESCE(@status, Status),
          UpdatedAt = SYSDATETIME()
      WHERE ProductionOrderId = @id;
    `);
    try {
      io.emit("production:changed", {
        type: "update",
        id,
        productId: productId || null,
        year: planYear || null,
        week: planWeek || null,
        status: normStatus || null,
      });
    } catch (notifyErr) {
      console.error("[Socket] Failed to emit production:changed (update)", notifyErr);
    }

    res.json({ ok: true });
  } catch (err) {
    console.error("[ProductionOrders Update Error]", err);
    res.status(500).json({ error: "Failed to update production order" });
  }
});

app.delete("/api/production-orders/:id", async (req, res) => {
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
app.get("/api/purchase-orders", async (req, res) => {
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

app.get("/api/purchase-orders/:id", async (req, res) => {
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

app.get("/api/purchase-orders/:id/lines", async (req, res) => {
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
    res.status(500).json({ error: "Failed to fetch purchase order lines" });
  }
});

app.post("/api/purchase-orders", async (req, res) => {
  const {
    poNumber,
    invoiceNumber,
    supplierName,
    customerCode,
    warehouseCode,
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

    // Insert PurchaseOrder
    request
      .input("poNumber", sql.NVarChar, poNumber || null)
      .input("invoiceNumber", sql.NVarChar, invoiceNumber || null)
      .input("supplierName", sql.NVarChar, supplierName || null)
      .input("customerCode", sql.NVarChar, customerCode || null)
      .input("warehouseCode", sql.NVarChar, warehouseCode || null)
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

    // Insert PurchaseOrderLines
    for (const line of lines) {
      const lineRequest = new sql.Request(transaction);
      lineRequest
        .input("purchaseOrderId", sql.Int, poId)
        .input("materialId", sql.Int, line.materialId)
        .input("quantity", sql.Decimal(18, 3), line.quantity)
        .input("unit", sql.NVarChar, line.unit || "PCS")
        .input("unitPrice", sql.Decimal(18, 2), line.unitPrice || 0)
        .input("totalAmount", sql.Decimal(18, 2), line.totalAmount || 0)
        .input("etaYear", sql.Int, line.etaYear)
        .input("etaWeek", sql.Int, line.etaWeek);
      await lineRequest.query(`
        INSERT INTO PurchaseOrderLines (PurchaseOrderId, MaterialId, Quantity, Unit, UnitPrice, TotalAmount, EtaYear, EtaWeek)
        VALUES (@purchaseOrderId, @materialId, @quantity, @unit, @unitPrice, @totalAmount, @etaYear, @etaWeek);
      `);
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

    res.status(201).json({ id: poId });
  } catch (err) {
    console.error("[PurchaseOrders Create Error]", err);
    try {
      if (transaction) await transaction.rollback();
    } catch (_) {}
    res.status(500).json({ error: "Failed to create purchase order" });
  }
});

app.put("/api/purchase-orders/:id", async (req, res) => {
  const id = parseIntSafe(req.params.id);
  if (!id) return res.status(400).json({ error: "Invalid id" });
  const {
    poNumber,
    invoiceNumber,
    supplierName,
    customerCode,
    warehouseCode,
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

      // Insert new lines
      for (const line of lines) {
        const lineRequest = new sql.Request(transaction);
        lineRequest
          .input("purchaseOrderId", sql.Int, id)
          .input("materialId", sql.Int, line.materialId)
          .input("quantity", sql.Decimal(18, 3), line.quantity)
          .input("unit", sql.NVarChar, line.unit || "PCS")
          .input("unitPrice", sql.Decimal(18, 2), line.unitPrice || 0)
          .input("totalAmount", sql.Decimal(18, 2), line.totalAmount || 0)
          .input("etaYear", sql.Int, line.etaYear)
          .input("etaWeek", sql.Int, line.etaWeek);
        await lineRequest.query(`
          INSERT INTO PurchaseOrderLines (PurchaseOrderId, MaterialId, Quantity, Unit, UnitPrice, TotalAmount, EtaYear, EtaWeek)
          VALUES (@purchaseOrderId, @materialId, @quantity, @unit, @unitPrice, @totalAmount, @etaYear, @etaWeek);
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

    res.json({ ok: true });
  } catch (err) {
    console.error("[PurchaseOrders Update Error]", err);
    try {
      if (transaction) await transaction.rollback();
    } catch (_) {}
    res.status(500).json({ error: "Failed to update purchase order" });
  }
});

app.delete("/api/purchase-orders/:id", async (req, res) => {
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

    res.json({ ok: true });
  } catch (err) {
    console.error("[PurchaseOrders Delete Error]", err);
    res.status(500).json({ error: "Failed to delete purchase order" });
  }
});

// -------- Sales Orders CRUD (for Sales module) ----------
app.get("/api/sales-orders", async (req, res) => {
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

app.get("/api/sales-orders/:id", async (req, res) => {
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

app.get("/api/sales-orders/:id/lines", async (req, res) => {
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

app.post("/api/sales-orders", async (req, res) => {
  const {
    invoiceNumber,
    customerName,
    customerCode,
    deliveryDate,
    status,
    currency,
    createdBy,
    assignedTo,
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

    request
      .input("invoiceNumber", sql.NVarChar, invoiceNumber || null)
      .input("customerName", sql.NVarChar, customerName || null)
      .input("customerCode", sql.NVarChar, customerCode || null)
      .input("deliveryDate", sql.Date, deliveryDate || null)
      .input("totalAmount", sql.Decimal(18, 2), totalAmount)
      .input("status", sql.NVarChar, normStatus)
      .input("currency", sql.NVarChar, currency || "VND")
      .input("createdBy", sql.NVarChar, createdBy || null)
      .input("assignedTo", sql.NVarChar, assignedTo || null);

    const soResult = await request.query(`
      INSERT INTO SalesOrders (InvoiceNumber, CustomerName, CustomerCode, DeliveryDate, TotalAmount, Status, Currency, CreatedBy, AssignedTo)
      OUTPUT INSERTED.SalesOrderId AS id
      VALUES (@invoiceNumber, @customerName, @customerCode, @deliveryDate, @totalAmount, @status, @currency, @createdBy, @assignedTo);
    `);
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

    await transaction.commit();

    try {
      io.emit("sales:changed", { type: "create", id: soId, status: normStatus });
    } catch (notifyErr) {
      console.error("[Socket] Failed to emit sales:changed (create)", notifyErr);
    }

    res.status(201).json({ id: soId });
  } catch (err) {
    console.error("[SalesOrders Create Error]", err);
    try {
      if (transaction) await transaction.rollback();
    } catch (_) {}
    res.status(500).json({ error: "Failed to create sales order" });
  }
});

app.put("/api/sales-orders/:id", async (req, res) => {
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

    if (updates.length) {
      updates.push("UpdatedAt = SYSDATETIME()");
      await request.query(`
        UPDATE SalesOrders SET ${updates.join(", ")} WHERE SalesOrderId = @id;
      `);
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

    await transaction.commit();

    try {
      io.emit("sales:changed", { type: "update", id, status: normStatus });
    } catch (notifyErr) {
      console.error("[Socket] Failed to emit sales:changed (update)", notifyErr);
    }

    res.json({ ok: true });
  } catch (err) {
    console.error("[SalesOrders Update Error]", err);
    try {
      if (transaction) await transaction.rollback();
    } catch (_) {}
    res.status(500).json({ error: "Failed to update sales order" });
  }
});

app.delete("/api/sales-orders/:id", async (req, res) => {
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
    res.json({ ok: true });
  } catch (err) {
    console.error("[SalesOrders Delete Error]", err);
    res.status(500).json({ error: "Failed to delete sales order" });
  }
});

// -------- Sales actual (CONFIRM) - SHIP_QTY từ hóa đơn bán hàng cho MPS ----------
app.get("/api/sales-actual", async (req, res) => {
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
      SELECT sol.ProductId AS productId,
             DATEPART(YEAR, so.DeliveryDate) AS year,
             DATEPART(ISO_WEEK, so.DeliveryDate) AS week,
             SUM(sol.Quantity) AS qty
      FROM SalesOrderLines sol
      JOIN SalesOrders so ON so.SalesOrderId = sol.SalesOrderId
      WHERE UPPER(so.Status) = 'CONFIRM'
        AND so.DeliveryDate IS NOT NULL
        AND (DATEPART(YEAR, so.DeliveryDate) > @fromYear OR (DATEPART(YEAR, so.DeliveryDate) = @fromYear AND DATEPART(ISO_WEEK, so.DeliveryDate) >= @fromWeek))
        AND (DATEPART(YEAR, so.DeliveryDate) < @toYear OR (DATEPART(YEAR, so.DeliveryDate) = @toYear AND DATEPART(ISO_WEEK, so.DeliveryDate) <= @toWeek))
        AND (@productId IS NULL OR sol.ProductId = @productId)
      GROUP BY sol.ProductId, DATEPART(YEAR, so.DeliveryDate), DATEPART(ISO_WEEK, so.DeliveryDate)
      ORDER BY year, week
    `);
    res.json(result.recordset);
  } catch (err) {
    console.error("[Sales Actual Error]", err);
    res.status(500).json({ error: "Failed to fetch sales actual" });
  }
});

// -------- Sales plan (SHIP_QTY forecast) ----------
app.get("/api/sales-plan", async (req, res) => {
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
app.put("/api/sales-plan", async (req, res) => {
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
app.get("/api/partners", async (req, res) => {
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

app.get("/api/partners/:id", async (req, res) => {
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

app.post("/api/partners", async (req, res) => {
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
    res.status(201).json({ id: result.recordset[0].id });
  } catch (err) {
    if (err.message && /UNIQUE|duplicate/i.test(err.message))
      return res.status(400).json({ error: "Partner code already exists for this type" });
    console.error("[Partners API Error]", err);
    res.status(500).json({ error: "Failed to create partner" });
  }
});

app.put("/api/partners/:id", async (req, res) => {
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
    res.json({ ok: true });
  } catch (err) {
    if (err.message && /UNIQUE|duplicate/i.test(err.message))
      return res.status(400).json({ error: "Partner code already exists for this type" });
    console.error("[Partners API Error]", err);
    res.status(500).json({ error: "Failed to update partner" });
  }
});

app.delete("/api/partners/:id", async (req, res) => {
  const id = parseIntSafe(req.params.id);
  if (!id) return res.status(400).json({ error: "Invalid id" });
  try {
    const pool = await getPool();
    await pool.request().input("id", sql.Int, id).query(`DELETE FROM Partners WHERE PartnerId = @id;`);
    res.json({ ok: true });
  } catch (err) {
    console.error("[Partners API Error]", err);
    res.status(500).json({ error: "Failed to delete partner" });
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
server.listen(port, () => {
  console.log(`Server running on http://localhost:${port}`);
});
