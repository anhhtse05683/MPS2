-- =============================================
-- Dữ liệu mẫu cho màn hình Tồn kho
-- Chạy sau fix_purchase_warehouse.sql và fix_inventory.sql
-- (hoặc chạy fix_inventory.sql trước vì nó tạo StockBalances)
-- =============================================

USE MPS;
GO

-- 1. Đảm bảo Warehouses tồn tại
IF OBJECT_ID('Warehouses', 'U') IS NULL
BEGIN
    CREATE TABLE Warehouses (
        WarehouseId INT IDENTITY(1,1) PRIMARY KEY,
        WarehouseCode NVARCHAR(50) NOT NULL UNIQUE,
        WarehouseName NVARCHAR(200) NOT NULL,
        WarehouseType NVARCHAR(20) NULL,
        Address NVARCHAR(500) NULL,
        IsActive BIT NOT NULL DEFAULT 1,
        CreatedAt DATETIME2 DEFAULT SYSDATETIME(),
        UpdatedAt DATETIME2 DEFAULT SYSDATETIME()
    );
    INSERT INTO Warehouses (WarehouseCode, WarehouseName, WarehouseType, Address) VALUES
    ('WH-NVL', N'Kho Nguyên vật liệu', 'NVL', N'Kho nhập NVL từ mua hàng'),
    ('WH-TP', N'Kho Thành phẩm', 'TP', N'Kho xuất TP cho bán hàng'),
    ('WH-WIP', N'Kho Bán thành phẩm', 'WIP', NULL);
END
GO

-- 2. Thêm sản phẩm mẫu nếu chưa có
IF NOT EXISTS (SELECT 1 FROM Products)
BEGIN
    INSERT INTO Products (ProductCode, ProductName) VALUES
    (N'SP001', N'Sản phẩm A'),
    (N'SP002', N'Sản phẩm B'),
    (N'SP003', N'Sản phẩm C');
END
GO

-- 3. Thêm NVL mẫu nếu chưa có
IF NOT EXISTS (SELECT 1 FROM Materials)
BEGIN
    INSERT INTO Materials (MaterialCode, MaterialName) VALUES
    (N'NVL001', N'Thép tấm'),
    (N'NVL002', N'Ống thép'),
    (N'NVL003', N'Bulong'),
    (N'NVL004', N'Sơn phủ'),
    (N'NVL005', N'Điện trở');
END
GO

-- 4. Đảm bảo StockBalances tồn tại (cần fix_inventory.sql)
IF OBJECT_ID('StockBalances', 'U') IS NULL
BEGIN
    PRINT 'Chạy fix_inventory.sql trước để tạo bảng StockBalances.';
END
ELSE
BEGIN
    -- 5. Thêm tồn kho mẫu (chỉ insert nếu chưa có)
    -- Kho NVL: NVL với số lượng mẫu
    INSERT INTO StockBalances (WarehouseId, ItemType, ItemId, Quantity)
    SELECT w.WarehouseId, 'M', m.MaterialId, 100 + (m.MaterialId * 50) % 400
    FROM Warehouses w CROSS JOIN Materials m
    WHERE w.WarehouseCode = 'WH-NVL'
      AND NOT EXISTS (SELECT 1 FROM StockBalances sb WHERE sb.WarehouseId=w.WarehouseId AND sb.ItemType='M' AND sb.ItemId=m.MaterialId);

    -- Kho TP: Thành phẩm
    INSERT INTO StockBalances (WarehouseId, ItemType, ItemId, Quantity)
    SELECT w.WarehouseId, 'P', p.ProductId, 50 + (p.ProductId * 30) % 150
    FROM Warehouses w CROSS JOIN Products p
    WHERE w.WarehouseCode = 'WH-TP'
      AND NOT EXISTS (SELECT 1 FROM StockBalances sb WHERE sb.WarehouseId=w.WarehouseId AND sb.ItemType='P' AND sb.ItemId=p.ProductId);

    -- Kho WIP: Một số NVL và TP
    INSERT INTO StockBalances (WarehouseId, ItemType, ItemId, Quantity)
    SELECT w.WarehouseId, 'M', m.MaterialId, 25 + (m.MaterialId * 10) % 75
    FROM (SELECT WarehouseId FROM Warehouses WHERE WarehouseCode = 'WH-WIP') w
    CROSS JOIN (SELECT TOP 3 MaterialId FROM Materials ORDER BY MaterialId) m
    WHERE NOT EXISTS (SELECT 1 FROM StockBalances sb WHERE sb.WarehouseId=w.WarehouseId AND sb.ItemType='M' AND sb.ItemId=m.MaterialId);

    INSERT INTO StockBalances (WarehouseId, ItemType, ItemId, Quantity)
    SELECT w.WarehouseId, 'P', p.ProductId, 15 + (p.ProductId * 8) % 60
    FROM (SELECT WarehouseId FROM Warehouses WHERE WarehouseCode = 'WH-WIP') w
    CROSS JOIN (SELECT TOP 2 ProductId FROM Products ORDER BY ProductId) p
    WHERE NOT EXISTS (SELECT 1 FROM StockBalances sb WHERE sb.WarehouseId=w.WarehouseId AND sb.ItemType='P' AND sb.ItemId=p.ProductId);

    PRINT 'Đã thêm dữ liệu mẫu tồn kho.';
END
GO
