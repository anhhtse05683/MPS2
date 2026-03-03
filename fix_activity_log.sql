-- =============================================
-- Activity Log: Menus + ActivityLog tables
-- Quản lý menu và lịch sử thao tác người dùng
-- Chạy sau schema
-- =============================================

USE MPS;
GO

-- Menus: danh sách menu trong hệ thống
IF OBJECT_ID('Menus', 'U') IS NULL
BEGIN
    CREATE TABLE Menus (
        MenuId INT IDENTITY(1,1) PRIMARY KEY,
        MenuCode NVARCHAR(50) NOT NULL UNIQUE,
        MenuName NVARCHAR(200) NOT NULL,
        ParentId INT NULL,
        ModulePath NVARCHAR(500) NULL,
        EntityType NVARCHAR(50) NULL,  -- PurchaseOrder, SalesOrder, StockReceipt, etc.
        DetailUrlPattern NVARCHAR(500) NULL,  -- /modules/Purchase/detail.html?id=
        SortOrder INT DEFAULT 0,
        IsActive BIT DEFAULT 1,
        CreatedAt DATETIME2 DEFAULT SYSDATETIME(),
        FOREIGN KEY (ParentId) REFERENCES Menus(MenuId)
    );
    CREATE INDEX IX_Menus_ParentId ON Menus(ParentId);
    CREATE INDEX IX_Menus_EntityType ON Menus(EntityType);
    PRINT 'Created Menus table.';
END
GO

-- ActivityLog: log thao tác người dùng
IF OBJECT_ID('ActivityLog', 'U') IS NULL
BEGIN
    CREATE TABLE ActivityLog (
        LogId BIGINT IDENTITY(1,1) PRIMARY KEY,
        LogAt DATETIME2 DEFAULT SYSDATETIME(),
        UserId INT NULL,
        UserName NVARCHAR(100) NULL,
        MenuId INT NULL,
        Action NVARCHAR(20) NOT NULL,  -- CREATE, UPDATE, DELETE
        EntityType NVARCHAR(50) NULL,
        EntityId NVARCHAR(50) NULL,
        EntitySummary NVARCHAR(500) NULL,
        Details NVARCHAR(MAX) NULL,
        FOREIGN KEY (MenuId) REFERENCES Menus(MenuId)
    );
    CREATE INDEX IX_ActivityLog_LogAt ON ActivityLog(LogAt);
    CREATE INDEX IX_ActivityLog_UserId ON ActivityLog(UserId);
    CREATE INDEX IX_ActivityLog_MenuId ON ActivityLog(MenuId);
    CREATE INDEX IX_ActivityLog_EntityType ON ActivityLog(EntityType);
    CREATE INDEX IX_ActivityLog_Action ON ActivityLog(Action);
    PRINT 'Created ActivityLog table.';
END
GO

-- Seed Menus
IF NOT EXISTS (SELECT 1 FROM Menus WHERE MenuCode = 'dashboard')
BEGIN
    INSERT INTO Menus (MenuCode, MenuName, ParentId, ModulePath, EntityType, DetailUrlPattern, SortOrder) VALUES
    ('dashboard', N'Dashboard', NULL, 'erp_index.html', NULL, NULL, 10),
    ('production', N'Kế hoạch sản xuất', NULL, '/modules/Production/index.html', 'ProductionOrder', '/modules/Production/index.html', 20),
    ('mps', N'MRP - Hoạch định', NULL, '/modules/MPS/index.html', NULL, NULL, 25),
    ('bom-design', N'Thiết kế BOM', NULL, '/modules/BOM/design.html', 'BomLine', '/modules/BOM/design.html', 30),
    ('product', N'Danh mục sản phẩm', NULL, '/modules/Product/index.html', NULL, NULL, 40),
    ('inventory', N'Tồn kho', NULL, '/modules/Inventory/index.html', NULL, NULL, 50),
    ('warehouse', N'Kho hàng', NULL, '/modules/Inventory/warehouses.html', 'Warehouse', '/modules/Inventory/warehouses.html', 55),
    ('purchase', N'Mua hàng', NULL, '/modules/Purchase/index.html', 'PurchaseOrder', '/modules/Purchase/detail.html?id=', 60),
    ('sales', N'Bán hàng', NULL, '/modules/Sales/index.html', 'SalesOrder', '/modules/Sales/detail.html?id=', 70),
    ('partners', N'Quản lý khách hàng', NULL, '/modules/Partners/index.html', 'Partner', '/modules/Partners/detail.html?id=', 75),
    ('stock-receipt', N'Phiếu nhập kho', NULL, '/modules/Inventory/receipts.html', 'StockReceipt', '/modules/Inventory/receipt-detail.html?id=', 80),
    ('stock-issue', N'Phiếu xuất kho', NULL, '/modules/Inventory/issues.html', 'StockIssue', '/modules/Inventory/issue-detail.html?id=', 85),
    ('stock-adjustment', N'Phiếu điều chỉnh', NULL, '/modules/Inventory/adjustments.html', 'StockAdjustment', '/modules/Inventory/adjustment-detail.html?id=', 90),
    ('stock-transfer', N'Phiếu chuyển kho', NULL, '/modules/Inventory/transfers.html', 'StockTransfer', '/modules/Inventory/transfer-detail.html?id=', 95),
    ('items', N'Danh mục sản phẩm/NVL', NULL, '/modules/Product/index.html', 'Item', NULL, 100),
    ('users', N'Quản lý người dùng', NULL, '/modules/Users/index.html', 'User', '/modules/Users/detail.html?id=', 200),
    ('history', N'Lược sử', NULL, '/modules/Reports/history.html', NULL, NULL, 210);
    PRINT 'Seeded Menus.';
END
GO

PRINT 'fix_activity_log.sql completed.';
GO
