-- =============================================
-- Migration: Inventory - Warehouses, Stock, Adjustments, Transfers
-- Chạy script này sau fix_auth.sql
-- =============================================

USE MPS;
GO

-- Drop child tables first (FK dependencies)
IF OBJECT_ID('StockTransactionLines', 'U') IS NOT NULL DROP TABLE StockTransactionLines;
IF OBJECT_ID('StockTransactions', 'U') IS NOT NULL DROP TABLE StockTransactions;
IF OBJECT_ID('StockAdjustmentLines', 'U') IS NOT NULL DROP TABLE StockAdjustmentLines;
IF OBJECT_ID('StockAdjustments', 'U') IS NOT NULL DROP TABLE StockAdjustments;
IF OBJECT_ID('StockTransferLines', 'U') IS NOT NULL DROP TABLE StockTransferLines;
IF OBJECT_ID('StockTransfers', 'U') IS NOT NULL DROP TABLE StockTransfers;
IF OBJECT_ID('StockBalances', 'U') IS NOT NULL DROP TABLE StockBalances;
IF OBJECT_ID('Warehouses', 'U') IS NOT NULL DROP TABLE Warehouses;
GO

-- Warehouses (Kho hàng)
CREATE TABLE Warehouses (
    WarehouseId INT IDENTITY(1,1) PRIMARY KEY,
    WarehouseCode NVARCHAR(50) NOT NULL UNIQUE,
    WarehouseName NVARCHAR(200) NOT NULL,
    WarehouseType NVARCHAR(20) NULL,  -- 'NVL' = Nguyên vật liệu, 'TP' = Thành phẩm, 'WIP' = Bán thành phẩm
    Address NVARCHAR(500) NULL,
    IsActive BIT NOT NULL DEFAULT 1,
    CreatedAt DATETIME2 DEFAULT SYSDATETIME(),
    UpdatedAt DATETIME2 DEFAULT SYSDATETIME()
);
CREATE INDEX IX_Warehouses_Code ON Warehouses(WarehouseCode);
CREATE INDEX IX_Warehouses_Type ON Warehouses(WarehouseType);
GO

-- Seed warehouses: Kho NVL (default for purchase), Kho TP (default for production output)
INSERT INTO Warehouses (WarehouseCode, WarehouseName, WarehouseType, Address) VALUES
('WH-NVL', N'Kho Nguyên vật liệu', 'NVL', N'Kho nhập NVL từ mua hàng'),
('WH-TP', N'Kho Thành phẩm', 'TP', N'Kho xuất TP cho bán hàng'),
('WH-WIP', N'Kho Bán thành phẩm', 'WIP', NULL);
GO

-- StockBalances (Tồn kho theo kho)
CREATE TABLE StockBalances (
    StockBalanceId INT IDENTITY(1,1) PRIMARY KEY,
    WarehouseId INT NOT NULL,
    ItemType CHAR(1) NOT NULL,  -- 'P' = Product, 'M' = Material
    ItemId INT NOT NULL,
    Quantity DECIMAL(18,3) NOT NULL DEFAULT 0,
    LastUpdatedAt DATETIME2 DEFAULT SYSDATETIME(),
    FOREIGN KEY (WarehouseId) REFERENCES Warehouses(WarehouseId) ON DELETE CASCADE,
    UNIQUE(WarehouseId, ItemType, ItemId)
);
CREATE INDEX IX_StockBalances_Warehouse ON StockBalances(WarehouseId);
CREATE INDEX IX_StockBalances_Item ON StockBalances(ItemType, ItemId);
GO

-- StockTransactions (Phiếu nhập/xuất - từng dòng)
CREATE TABLE StockTransactions (
    StockTransactionId INT IDENTITY(1,1) PRIMARY KEY,
    TransactionType NVARCHAR(20) NOT NULL,  -- RECEIPT, ISSUE, ADJUSTMENT, TRANSFER_IN, TRANSFER_OUT, PRODUCTION_IN, PRODUCTION_OUT
    TransactionDate DATE NOT NULL,
    WarehouseId INT NOT NULL,
    ItemType CHAR(1) NOT NULL,
    ItemId INT NOT NULL,
    Quantity DECIMAL(18,3) NOT NULL,  -- + nhập, - xuất
    ReferenceType NVARCHAR(50) NULL,   -- PURCHASE_ORDER, SALES_ORDER, PRODUCTION_ORDER, ADJUSTMENT, TRANSFER
    ReferenceId INT NULL,
    Notes NVARCHAR(500) NULL,
    CreatedBy INT NULL,
    CreatedAt DATETIME2 DEFAULT SYSDATETIME(),
    FOREIGN KEY (WarehouseId) REFERENCES Warehouses(WarehouseId) ON DELETE CASCADE
);
CREATE INDEX IX_StockTransactions_Date ON StockTransactions(TransactionDate);
CREATE INDEX IX_StockTransactions_Warehouse ON StockTransactions(WarehouseId);
CREATE INDEX IX_StockTransactions_Ref ON StockTransactions(ReferenceType, ReferenceId);
GO

-- StockAdjustments (Phiếu điều chỉnh - DRAFT -> CONFIRM)
CREATE TABLE StockAdjustments (
    StockAdjustmentId INT IDENTITY(1,1) PRIMARY KEY,
    AdjustmentNumber NVARCHAR(50) NOT NULL UNIQUE,
    WarehouseId INT NOT NULL,
    AdjustmentDate DATE NOT NULL,
    Reason NVARCHAR(500) NULL,
    Status NVARCHAR(20) NOT NULL DEFAULT 'DRAFT',  -- DRAFT, CONFIRM
    CreatedBy INT NULL,
    CreatedAt DATETIME2 DEFAULT SYSDATETIME(),
    ConfirmedBy INT NULL,
    ConfirmedAt DATETIME2 NULL,
    FOREIGN KEY (WarehouseId) REFERENCES Warehouses(WarehouseId) ON DELETE CASCADE
);
CREATE INDEX IX_StockAdjustments_Status ON StockAdjustments(Status);
CREATE INDEX IX_StockAdjustments_Date ON StockAdjustments(AdjustmentDate);
GO

-- StockAdjustmentLines (Chi tiết điều chỉnh)
CREATE TABLE StockAdjustmentLines (
    StockAdjustmentLineId INT IDENTITY(1,1) PRIMARY KEY,
    StockAdjustmentId INT NOT NULL,
    ItemType CHAR(1) NOT NULL,
    ItemId INT NOT NULL,
    QuantityBefore DECIMAL(18,3) NOT NULL DEFAULT 0,
    QuantityAdjust DECIMAL(18,3) NOT NULL,  -- + tăng, - giảm
    QuantityAfter DECIMAL(18,3) NOT NULL,
    Notes NVARCHAR(200) NULL,
    FOREIGN KEY (StockAdjustmentId) REFERENCES StockAdjustments(StockAdjustmentId) ON DELETE CASCADE
);
GO

-- StockTransfers (Chuyển kho)
CREATE TABLE StockTransfers (
    StockTransferId INT IDENTITY(1,1) PRIMARY KEY,
    TransferNumber NVARCHAR(50) NOT NULL UNIQUE,
    FromWarehouseId INT NOT NULL,
    ToWarehouseId INT NOT NULL,
    TransferDate DATE NOT NULL,
    Status NVARCHAR(20) NOT NULL DEFAULT 'DRAFT',  -- DRAFT, CONFIRM
    Notes NVARCHAR(500) NULL,
    CreatedBy INT NULL,
    CreatedAt DATETIME2 DEFAULT SYSDATETIME(),
    ConfirmedBy INT NULL,
    ConfirmedAt DATETIME2 NULL,
    FOREIGN KEY (FromWarehouseId) REFERENCES Warehouses(WarehouseId) ON DELETE NO ACTION,
    FOREIGN KEY (ToWarehouseId) REFERENCES Warehouses(WarehouseId) ON DELETE NO ACTION,
    CHECK (FromWarehouseId <> ToWarehouseId)
);
CREATE INDEX IX_StockTransfers_Status ON StockTransfers(Status);
GO

-- StockTransferLines
CREATE TABLE StockTransferLines (
    StockTransferLineId INT IDENTITY(1,1) PRIMARY KEY,
    StockTransferId INT NOT NULL,
    ItemType CHAR(1) NOT NULL,
    ItemId INT NOT NULL,
    Quantity DECIMAL(18,3) NOT NULL,
    Notes NVARCHAR(200) NULL,
    FOREIGN KEY (StockTransferId) REFERENCES StockTransfers(StockTransferId) ON DELETE CASCADE
);
GO

-- StockIssues (Phiếu xuất kho bán hàng - tạo thủ công)
CREATE TABLE StockIssues (
    StockIssueId INT IDENTITY(1,1) PRIMARY KEY,
    IssueNumber NVARCHAR(50) NOT NULL UNIQUE,
    WarehouseId INT NOT NULL,
    SalesOrderId INT NULL,
    IssueDate DATE NOT NULL,
    Status NVARCHAR(20) NOT NULL DEFAULT 'DRAFT',  -- DRAFT, CONFIRM
    Notes NVARCHAR(500) NULL,
    CreatedBy INT NULL,
    CreatedAt DATETIME2 DEFAULT SYSDATETIME(),
    ConfirmedBy INT NULL,
    ConfirmedAt DATETIME2 NULL,
    FOREIGN KEY (WarehouseId) REFERENCES Warehouses(WarehouseId) ON DELETE CASCADE,
    FOREIGN KEY (SalesOrderId) REFERENCES SalesOrders(SalesOrderId) ON DELETE NO ACTION
);
CREATE INDEX IX_StockIssues_SalesOrder ON StockIssues(SalesOrderId);
CREATE INDEX IX_StockIssues_Date ON StockIssues(IssueDate);
GO

-- StockIssueLines
CREATE TABLE StockIssueLines (
    StockIssueLineId INT IDENTITY(1,1) PRIMARY KEY,
    StockIssueId INT NOT NULL,
    ProductId INT NOT NULL,
    Quantity DECIMAL(18,3) NOT NULL,
    Notes NVARCHAR(200) NULL,
    FOREIGN KEY (StockIssueId) REFERENCES StockIssues(StockIssueId) ON DELETE CASCADE,
    FOREIGN KEY (ProductId) REFERENCES Products(ProductId) ON DELETE CASCADE
);
GO

-- Add WarehouseId to PurchaseOrders (kho nhận NVL)
IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('PurchaseOrders') AND name = 'WarehouseId')
BEGIN
    ALTER TABLE PurchaseOrders ADD WarehouseId INT NULL;
    -- Default to WH-NVL (WarehouseId = 1)
    UPDATE PurchaseOrders SET WarehouseId = 1 WHERE WarehouseId IS NULL;
    ALTER TABLE PurchaseOrders ADD CONSTRAINT FK_PurchaseOrders_Warehouse FOREIGN KEY (WarehouseId) REFERENCES Warehouses(WarehouseId);
END
GO

-- Add WarehouseMaterialId, WarehouseProductId to ProductionOrders
IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('ProductionOrders') AND name = 'WarehouseMaterialId')
BEGIN
    ALTER TABLE ProductionOrders ADD WarehouseMaterialId INT NULL;
    ALTER TABLE ProductionOrders ADD CONSTRAINT FK_ProductionOrders_WarehouseMaterial FOREIGN KEY (WarehouseMaterialId) REFERENCES Warehouses(WarehouseId);
END
GO
IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('ProductionOrders') AND name = 'WarehouseProductId')
BEGIN
    ALTER TABLE ProductionOrders ADD WarehouseProductId INT NULL;
    ALTER TABLE ProductionOrders ADD CONSTRAINT FK_ProductionOrders_WarehouseProduct FOREIGN KEY (WarehouseProductId) REFERENCES Warehouses(WarehouseId);
END
GO
-- Set defaults: NVL warehouse=1, TP warehouse=2
UPDATE ProductionOrders SET WarehouseMaterialId = 1, WarehouseProductId = 2 WHERE WarehouseMaterialId IS NULL;
GO

-- Add WarehouseId to SalesOrders (kho xuất TP cho bán hàng)
IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('SalesOrders') AND name = 'WarehouseId')
BEGIN
    ALTER TABLE SalesOrders ADD WarehouseId INT NULL;
    -- Default to WH-TP (WarehouseId = 2)
    UPDATE SalesOrders SET WarehouseId = 2 WHERE WarehouseId IS NULL;
    ALTER TABLE SalesOrders ADD CONSTRAINT FK_SalesOrders_Warehouse FOREIGN KEY (WarehouseId) REFERENCES Warehouses(WarehouseId);
END
GO

-- Add inventory permissions (if Permissions table exists)
IF OBJECT_ID('Permissions', 'U') IS NOT NULL
BEGIN
    IF NOT EXISTS (SELECT 1 FROM Permissions WHERE PermissionCode = 'inventory.view')
    INSERT INTO Permissions (PermissionCode, PermissionName, ModuleCode, ActionCode) VALUES
    ('inventory.view', N'Inventory - Xem', 'inventory', 'view'),
    ('inventory.edit', N'Inventory - Sửa', 'inventory', 'edit'),
    ('inventory.adjust', N'Inventory - Điều chỉnh', 'inventory', 'adjust'),
    ('inventory.confirm', N'Inventory - Duyệt phiếu', 'inventory', 'confirm');

    -- Admin: full
    INSERT INTO RolePermissions (RoleId, PermissionId)
    SELECT 1, p.PermissionId FROM Permissions p WHERE p.ModuleCode = 'inventory'
    AND NOT EXISTS (SELECT 1 FROM RolePermissions rp WHERE rp.RoleId=1 AND rp.PermissionId=p.PermissionId);

    -- Guest: view only
    INSERT INTO RolePermissions (RoleId, PermissionId)
    SELECT 4, p.PermissionId FROM Permissions p WHERE p.PermissionCode = 'inventory.view'
    AND NOT EXISTS (SELECT 1 FROM RolePermissions rp WHERE rp.RoleId=4 AND rp.PermissionId=p.PermissionId);

    -- Staff: view + edit + adjust
    INSERT INTO RolePermissions (RoleId, PermissionId)
    SELECT 3, p.PermissionId FROM Permissions p WHERE p.PermissionCode IN ('inventory.view','inventory.edit','inventory.adjust')
    AND NOT EXISTS (SELECT 1 FROM RolePermissions rp WHERE rp.RoleId=3 AND rp.PermissionId=p.PermissionId);

    -- Manager: full inventory
    INSERT INTO RolePermissions (RoleId, PermissionId)
    SELECT 2, p.PermissionId FROM Permissions p WHERE p.ModuleCode = 'inventory'
    AND NOT EXISTS (SELECT 1 FROM RolePermissions rp WHERE rp.RoleId=2 AND rp.PermissionId=p.PermissionId);
END
GO

PRINT 'Inventory tables created. Warehouses: WH-NVL (NVL), WH-TP (TP), WH-WIP (WIP).';
GO
