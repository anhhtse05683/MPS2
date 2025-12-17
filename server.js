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
    const result = await pool
      .request()
      .query(
        `SELECT ProductId AS id, ProductCode AS code, ProductName AS name, ImageUrl
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
    console.log(`[Production API] productId=${productId}, fromYear=${fromYear}, fromWeek=${fromWeek}, toYear=${toYear}, toWeek=${toWeek}, found ${result.recordset.length} records`);
    res.json(result.recordset);
  } catch (err) {
    console.error("[Production API Error]", err);
    res.status(500).json({ error: "Failed to fetch production" });
  }
});

// -------- Purchase (CONFIRM) ----------
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
        WHERE po.Status = 'CONFIRM'
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
  const { type, code, name, imageUrl, openingYear, openingWeek, openingBalance } =
    req.body || {};
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
      await pool.request()
        .input("itemType", sql.Char(1), itemType)
        .input("itemId", sql.Int, newId)
        .input("startYear", sql.SmallInt, openingYear)
        .input("startWeek", sql.TinyInt, openingWeek)
        .input("balanceQty", sql.Decimal(18, 3), openingBalance)
        .query(`
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
      await pool.request()
        .input("itemType", sql.Char(1), itemType)
        .input("itemId", sql.Int, itemId)
        .input("startYear", sql.SmallInt, openingYear)
        .input("startWeek", sql.TinyInt, openingWeek)
        .input("balanceQty", sql.Decimal(18, 3), openingBalance)
        .query(`
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
    await pool.request()
      .input("itemType", sql.Char(1), itemType)
      .input("itemId", sql.Int, itemId)
      .query(`
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
    if (!req.file) {
      return res.status(400).json({ error: "file is required" });
    }
    try {
      const workbook = xlsx.read(req.file.buffer, { type: "buffer" });
      const sheetName = workbook.SheetNames[0];
      const sheet = workbook.Sheets[sheetName];
      const rows = xlsx.utils.sheet_to_json(sheet, { defval: null });

      if (!Array.isArray(rows) || rows.length === 0) {
        return res.status(400).json({ error: "file has no data" });
      }

      if (rows.length > MAX_IMPORT_ROWS) {
        return res.status(400).json({
          error: `too many rows in file (max ${MAX_IMPORT_ROWS})`,
        });
      }
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
        const request = pool.request()
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
          await pool.request()
            .input("itemType", sql.Char(1), itemType)
            .input("itemId", sql.Int, newId)
            .input("startYear", sql.SmallInt, openingYear)
            .input("startWeek", sql.TinyInt, openingWeek)
            .input("balanceQty", sql.Decimal(18, 3), openingBalance)
            .query(`
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
  }
);

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
