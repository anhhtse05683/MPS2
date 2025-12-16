-- =============================================
-- Material Planning Schedule (MPS) Database Schema
-- SQL Server
-- =============================================

USE master;
GO

-- Create database if not exists
IF NOT EXISTS (SELECT * FROM sys.databases WHERE name = 'MPS')
BEGIN
    CREATE DATABASE MPS;
END
GO

USE MPS;
GO

-- =============================================
-- Tables
-- =============================================

-- Products (Thành phẩm)
IF OBJECT_ID('Products', 'U') IS NOT NULL DROP TABLE Products;
CREATE TABLE Products (
    ProductId INT IDENTITY(1,1) PRIMARY KEY,
    ProductCode NVARCHAR(50) NOT NULL UNIQUE,
    ProductName NVARCHAR(200) NOT NULL,
    ImageUrl NVARCHAR(MAX) NULL,
    CreatedAt DATETIME2 DEFAULT SYSDATETIME(),
    UpdatedAt DATETIME2 DEFAULT SYSDATETIME()
);
GO

-- Materials (Nguyên vật liệu)
IF OBJECT_ID('Materials', 'U') IS NOT NULL DROP TABLE Materials;
CREATE TABLE Materials (
    MaterialId INT IDENTITY(1,1) PRIMARY KEY,
    MaterialCode NVARCHAR(50) NOT NULL UNIQUE,
    MaterialName NVARCHAR(200) NOT NULL,
    ImageUrl NVARCHAR(MAX) NULL,
    CreatedAt DATETIME2 DEFAULT SYSDATETIME(),
    UpdatedAt DATETIME2 DEFAULT SYSDATETIME()
);
GO

-- BOM Lines (Bill of Materials - Định mức tiêu hao)
IF OBJECT_ID('BomLines', 'U') IS NOT NULL DROP TABLE BomLines;
CREATE TABLE BomLines (
    BomLineId INT IDENTITY(1,1) PRIMARY KEY,
    ProductId INT NOT NULL,
    MaterialId INT NOT NULL,
    ConsumePerUnit DECIMAL(18,3) NOT NULL DEFAULT 1,
    CreatedAt DATETIME2 DEFAULT SYSDATETIME(),
    UpdatedAt DATETIME2 DEFAULT SYSDATETIME(),
    FOREIGN KEY (ProductId) REFERENCES Products(ProductId) ON DELETE CASCADE,
    FOREIGN KEY (MaterialId) REFERENCES Materials(MaterialId) ON DELETE CASCADE,
    UNIQUE(ProductId, MaterialId)
);
GO

-- Opening Balances (Tồn kho ban đầu - mỗi item chỉ có 1)
IF OBJECT_ID('OpeningBalances', 'U') IS NOT NULL DROP TABLE OpeningBalances;
CREATE TABLE OpeningBalances (
    OpeningBalanceId INT IDENTITY(1,1) PRIMARY KEY,
    ItemType CHAR(1) NOT NULL, -- 'P' = Product, 'M' = Material
    ItemId INT NOT NULL,
    StartYear SMALLINT NOT NULL,
    StartWeek TINYINT NOT NULL CHECK (StartWeek >= 1 AND StartWeek <= 53),
    BalanceQty DECIMAL(18,3) NOT NULL DEFAULT 0,
    CreatedAt DATETIME2 DEFAULT SYSDATETIME(),
    UpdatedAt DATETIME2 DEFAULT SYSDATETIME(),
    UNIQUE(ItemType, ItemId) -- Ensure only one opening balance per item
);
GO

-- Sales Plans (Kế hoạch xuất hàng - SHIP_QTY)
IF OBJECT_ID('SalesPlans', 'U') IS NOT NULL DROP TABLE SalesPlans;
CREATE TABLE SalesPlans (
    SalesPlanId INT IDENTITY(1,1) PRIMARY KEY,
    ProductId INT NOT NULL,
    PlanYear SMALLINT NOT NULL,
    PlanWeek TINYINT NOT NULL CHECK (PlanWeek >= 1 AND PlanWeek <= 53),
    ShipQty DECIMAL(18,3) NOT NULL DEFAULT 0,
    CreatedAt DATETIME2 DEFAULT SYSDATETIME(),
    UpdatedAt DATETIME2 DEFAULT SYSDATETIME(),
    FOREIGN KEY (ProductId) REFERENCES Products(ProductId) ON DELETE CASCADE,
    UNIQUE(ProductId, PlanYear, PlanWeek)
);
GO

-- Production Orders (Đơn sản xuất)
IF OBJECT_ID('ProductionOrders', 'U') IS NOT NULL DROP TABLE ProductionOrders;
CREATE TABLE ProductionOrders (
    ProductionOrderId INT IDENTITY(1,1) PRIMARY KEY,
    ProductId INT NOT NULL,
    Quantity DECIMAL(18,3) NOT NULL,
    PlanYear SMALLINT NOT NULL,
    PlanWeek TINYINT NOT NULL CHECK (PlanWeek >= 1 AND PlanWeek <= 53),
    Status NVARCHAR(20) NOT NULL DEFAULT 'INITIAL', -- INITIAL, ACTIVE, COMPLETE
    CreatedAt DATETIME2 DEFAULT SYSDATETIME(),
    UpdatedAt DATETIME2 DEFAULT SYSDATETIME(),
    FOREIGN KEY (ProductId) REFERENCES Products(ProductId) ON DELETE CASCADE
);
GO

-- Purchase Orders (Phiếu mua hàng)
IF OBJECT_ID('PurchaseOrders', 'U') IS NOT NULL DROP TABLE PurchaseOrders;
CREATE TABLE PurchaseOrders (
    PurchaseOrderId INT IDENTITY(1,1) PRIMARY KEY,
    Status NVARCHAR(20) NOT NULL DEFAULT 'INITIAL', -- INITIAL, CONFIRM, RECEIVED, CANCELLED
    CreatedAt DATETIME2 DEFAULT SYSDATETIME(),
    UpdatedAt DATETIME2 DEFAULT SYSDATETIME()
);
GO

-- Purchase Order Lines (Chi tiết phiếu mua)
IF OBJECT_ID('PurchaseOrderLines', 'U') IS NOT NULL DROP TABLE PurchaseOrderLines;
CREATE TABLE PurchaseOrderLines (
    PurchaseOrderLineId INT IDENTITY(1,1) PRIMARY KEY,
    PurchaseOrderId INT NOT NULL,
    MaterialId INT NOT NULL,
    Quantity DECIMAL(18,3) NOT NULL,
    EtaYear SMALLINT NOT NULL, -- Expected Time of Arrival
    EtaWeek TINYINT NOT NULL CHECK (EtaWeek >= 1 AND EtaWeek <= 53),
    CreatedAt DATETIME2 DEFAULT SYSDATETIME(),
    UpdatedAt DATETIME2 DEFAULT SYSDATETIME(),
    FOREIGN KEY (PurchaseOrderId) REFERENCES PurchaseOrders(PurchaseOrderId) ON DELETE CASCADE,
    FOREIGN KEY (MaterialId) REFERENCES Materials(MaterialId) ON DELETE CASCADE
);
GO

-- =============================================
-- Indexes for performance
-- =============================================
CREATE INDEX IX_BomLines_ProductId ON BomLines(ProductId);
CREATE INDEX IX_BomLines_MaterialId ON BomLines(MaterialId);
CREATE INDEX IX_OpeningBalances_ItemType_ItemId ON OpeningBalances(ItemType, ItemId);
CREATE INDEX IX_SalesPlans_ProductId_Year_Week ON SalesPlans(ProductId, PlanYear, PlanWeek);
CREATE INDEX IX_ProductionOrders_ProductId_Year_Week ON ProductionOrders(ProductId, PlanYear, PlanWeek);
CREATE INDEX IX_ProductionOrders_Status ON ProductionOrders(Status);
CREATE INDEX IX_PurchaseOrders_Status ON PurchaseOrders(Status);
CREATE INDEX IX_PurchaseOrderLines_MaterialId ON PurchaseOrderLines(MaterialId);
CREATE INDEX IX_PurchaseOrderLines_EtaYear_EtaWeek ON PurchaseOrderLines(EtaYear, EtaWeek);
GO

-- =============================================
-- Seed Data
-- =============================================

-- Products
INSERT INTO Products (ProductCode, ProductName) VALUES
('589', N'Thành phẩm A'),
('990', N'Thành phẩm B'),
('P001', N'Sản phẩm mẫu 1');
GO

-- Materials
INSERT INTO Materials (MaterialCode, MaterialName) VALUES
('NVL3', N'Nguyên vật liệu 3'),
('NVL4', N'Nguyên vật liệu 4'),
('NVL5', N'Nguyên vật liệu 5'),
('M001', N'Vật liệu mẫu 1');
GO

-- BOM Lines
INSERT INTO BomLines (ProductId, MaterialId, ConsumePerUnit) VALUES
(1, 1, 1),  -- Product 589 uses NVL3 with rate 1
(1, 2, 1),  -- Product 589 uses NVL4 with rate 1
(1, 3, 1),  -- Product 589 uses NVL5 with rate 1
(2, 1, 2),  -- Product 990 uses NVL3 with rate 2
(2, 2, 1);  -- Product 990 uses NVL4 with rate 1
GO

-- Opening Balances (mỗi item chỉ có 1)
INSERT INTO OpeningBalances (ItemType, ItemId, StartYear, StartWeek, BalanceQty) VALUES
('P', 1, 2025, 47, 20),  -- Product 589: balance 20 at week 47/2025
('P', 2, 2025, 47, 50),  -- Product 990: balance 50 at week 47/2025
('M', 1, 2025, 47, 10),  -- Material NVL3: balance 10 at week 47/2025
('M', 2, 2025, 47, 10),  -- Material NVL4: balance 10 at week 47/2025
('M', 3, 2025, 47, 10);  -- Material NVL5: balance 10 at week 47/2025
GO

-- Production Orders (ACTIVE/COMPLETE affect MPS)
INSERT INTO ProductionOrders (ProductId, Quantity, PlanYear, PlanWeek, Status) VALUES
(1, 5, 2025, 48, 'ACTIVE'),
(1, 5, 2025, 49, 'ACTIVE'),
(2, 3, 2025, 49, 'COMPLETE'),
(1, 10, 2025, 50, 'INITIAL'); -- INITIAL không ảnh hưởng MPS
GO

-- Purchase Orders
INSERT INTO PurchaseOrders (Status) VALUES
('CONFIRM'),
('CONFIRM'),
('INITIAL'); -- INITIAL không ảnh hưởng MPS
GO

-- Purchase Order Lines
INSERT INTO PurchaseOrderLines (PurchaseOrderId, MaterialId, Quantity, EtaYear, EtaWeek) VALUES
(1, 1, 5, 2025, 49),  -- NVL3: 5 units arriving week 49/2025
(2, 2, 5, 2025, 49),  -- NVL4: 5 units arriving week 49/2025
(2, 3, 5, 2025, 49);  -- NVL5: 5 units arriving week 49/2025
GO

-- Sales Plans (SHIP_QTY - có thể để trống, user sẽ nhập trong UI)
-- Không insert seed data, để user tự nhập

PRINT 'Database schema and seed data created successfully!';
GO
