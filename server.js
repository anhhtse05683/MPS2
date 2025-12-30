require("dotenv").config();
const path = require("path");
const express = require("express");
const cors = require("cors");
const multer = require("multer");
const xlsx = require("xlsx");
const { getPool, sql } = require("./src/db");

const app = express();

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
    const result = await pool.request().input("productId", sql.Int, productId)
      .query(`
        SELECT m.MaterialId AS id, m.MaterialCode AS code, m.MaterialName AS name, b.ConsumePerUnit AS consume
        FROM BomLines b
        JOIN Materials m ON m.MaterialId = b.MaterialId
        WHERE b.ProductId = @productId
        ORDER BY m.MaterialCode
      `);
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
             ob.BalanceQty
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
             ob.BalanceQty
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
        .input("imageUrl", sql.NVarChar(sql.MAX), imageUrl || null);
      insertQuery = `
        INSERT INTO Materials (MaterialCode, MaterialName, ImageUrl)
        OUTPUT INSERTED.MaterialId AS id
        VALUES (@code, @name, @imageUrl);
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
  const { code, name, imageUrl, openingYear, openingWeek, openingBalance } =
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
      await request.query(`
        UPDATE Materials
        SET MaterialCode = COALESCE(@code, MaterialCode),
            MaterialName = COALESCE(@name, MaterialName),
            ImageUrl = @imageUrl,
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
app.post(
  "/api/items/import",
  upload.single("file"),
  async (req, res) => {
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
        mergeQuery = `
            MERGE Materials AS target
            USING (SELECT @code AS MaterialCode) AS src
            ON target.MaterialCode = src.MaterialCode
            WHEN MATCHED THEN
              UPDATE SET MaterialName=@name, ImageUrl=@imageUrl, UpdatedAt=SYSDATETIME()
            WHEN NOT MATCHED THEN
              INSERT (MaterialCode, MaterialName, ImageUrl)
              VALUES (@code, @name, @imageUrl)
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
    res.status(201).json({ id: result.recordset[0].id });
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
    const result = await pool
      .request()
      .input("id", sql.Int, id)
      .query(`
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
    const result = await pool
      .request()
      .input("id", sql.Int, id)
      .query(`
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
      .json({ error: "status must be INITIAL, CONFIRM, RECEIVED or CANCELLED" });
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
  if (normStatus && !["INITIAL", "CONFIRM", "RECEIVED", "CANCELLED"].includes(normStatus))
    return res
      .status(400)
      .json({ error: "status must be INITIAL, CONFIRM, RECEIVED or CANCELLED" });

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
    res.json({ ok: true });
  } catch (err) {
    console.error("[PurchaseOrders Delete Error]", err);
    res.status(500).json({ error: "Failed to delete purchase order" });
  }
});

// -------- Sales plan (SHIP_QTY) ----------
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
app.listen(port, () => {
  console.log(`Server running on http://localhost:${port}`);
});
