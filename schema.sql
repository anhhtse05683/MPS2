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
    SafetyStockQty DECIMAL(18,3) NULL DEFAULT 0,  -- Mức tồn kho an toàn
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

-- Sales Orders (Phiếu bán hàng)
IF OBJECT_ID('SalesOrderLines', 'U') IS NOT NULL DROP TABLE SalesOrderLines;
GO
IF OBJECT_ID('SalesOrders', 'U') IS NOT NULL DROP TABLE SalesOrders;
GO
CREATE TABLE SalesOrders (
    SalesOrderId INT IDENTITY(1,1) PRIMARY KEY,
    InvoiceNumber NVARCHAR(50) NULL, -- Số hóa đơn
    CustomerName NVARCHAR(200) NULL, -- Tên khách hàng
    CustomerCode NVARCHAR(50) NULL, -- Mã khách hàng
    DeliveryDate DATE NULL, -- Ngày giao hàng (dùng để suy ra tuần/năm)
    Status NVARCHAR(20) NOT NULL DEFAULT 'INITIAL', -- INITIAL, CONFIRM, CANCELLED
    Currency NVARCHAR(10) DEFAULT 'VND',
    TotalAmount DECIMAL(18,2) DEFAULT 0,
    CreatedBy NVARCHAR(100) NULL,
    AssignedTo NVARCHAR(100) NULL,
    CreatedAt DATETIME2 DEFAULT SYSDATETIME(),
    UpdatedAt DATETIME2 DEFAULT SYSDATETIME()
);
GO

CREATE TABLE SalesOrderLines (
    SalesOrderLineId INT IDENTITY(1,1) PRIMARY KEY,
    SalesOrderId INT NOT NULL,
    ProductId INT NOT NULL,
    Quantity DECIMAL(18,3) NOT NULL,
    Unit NVARCHAR(20) DEFAULT 'PCS',
    UnitPrice DECIMAL(18,2) DEFAULT 0,
    TotalAmount DECIMAL(18,2) DEFAULT 0,
    CreatedAt DATETIME2 DEFAULT SYSDATETIME(),
    UpdatedAt DATETIME2 DEFAULT SYSDATETIME(),
    FOREIGN KEY (SalesOrderId) REFERENCES SalesOrders(SalesOrderId) ON DELETE CASCADE,
    FOREIGN KEY (ProductId) REFERENCES Products(ProductId) ON DELETE CASCADE
);
GO

-- Purchase Orders (Phiếu mua hàng)
-- Drop child table first to avoid foreign key constraint error
IF OBJECT_ID('PurchaseOrderLines', 'U') IS NOT NULL DROP TABLE PurchaseOrderLines;
GO
IF OBJECT_ID('PurchaseOrders', 'U') IS NOT NULL DROP TABLE PurchaseOrders;
GO
CREATE TABLE PurchaseOrders (
    PurchaseOrderId INT IDENTITY(1,1) PRIMARY KEY,
    PONumber NVARCHAR(50) NULL, -- Số PO
    InvoiceNumber NVARCHAR(50) NULL, -- Số Invoice
    SupplierName NVARCHAR(200) NULL, -- Tên nhà cung cấp
    CustomerCode NVARCHAR(50) NULL, -- Mã khách hàng
    WarehouseCode NVARCHAR(50) NULL, -- Mã kho nhận
    Currency NVARCHAR(10) DEFAULT 'VND', -- Đơn vị tiền tệ
    InvoiceDate DATE NULL, -- Ngày khai invoice
    TotalAmount DECIMAL(18,2) DEFAULT 0, -- Tổng tiền
    Status NVARCHAR(20) NOT NULL DEFAULT 'INITIAL', -- INITIAL, CONFIRM, RECEIVED, CANCELLED
    CreatedBy NVARCHAR(100) NULL, -- Người thao tác
    AssignedTo NVARCHAR(100) NULL, -- Người phụ trách
    CreatedAt DATETIME2 DEFAULT SYSDATETIME(),
    UpdatedAt DATETIME2 DEFAULT SYSDATETIME()
);
GO

-- Purchase Order Lines (Chi tiết phiếu mua)
CREATE TABLE PurchaseOrderLines (
    PurchaseOrderLineId INT IDENTITY(1,1) PRIMARY KEY,
    PurchaseOrderId INT NOT NULL,
    MaterialId INT NOT NULL,
    Quantity DECIMAL(18,3) NOT NULL,
    Unit NVARCHAR(20) DEFAULT 'PCS', -- Đơn vị
    UnitPrice DECIMAL(18,2) DEFAULT 0, -- Đơn giá
    TotalAmount DECIMAL(18,2) DEFAULT 0, -- Thành tiền
    EtaDate DATE NULL, -- Ngày dự kiến nhận hàng (ưu tiên, MPS tự tính năm/tuần)
    EtaYear SMALLINT NOT NULL, -- Tự tính từ EtaDate khi lưu
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
CREATE INDEX IX_SalesOrders_Status ON SalesOrders(Status);
CREATE INDEX IX_SalesOrders_DeliveryDate ON SalesOrders(DeliveryDate);
CREATE INDEX IX_SalesOrderLines_ProductId ON SalesOrderLines(ProductId);
GO

-- Partners (Khách hàng + Nhà cung cấp)
IF OBJECT_ID('Partners', 'U') IS NOT NULL DROP TABLE Partners;
CREATE TABLE Partners (
    PartnerId INT IDENTITY(1,1) PRIMARY KEY,
    PartnerCode NVARCHAR(50) NOT NULL,
    PartnerName NVARCHAR(200) NOT NULL,
    PartnerType CHAR(1) NOT NULL DEFAULT 'C',  -- 'C' = Customer, 'S' = Supplier
    TaxCode NVARCHAR(50) NULL,
    Representative NVARCHAR(200) NULL,
    Phone NVARCHAR(50) NULL,
    Email NVARCHAR(200) NULL,
    Address NVARCHAR(500) NULL,
    CreatedBy NVARCHAR(100) NULL,
    CreatedAt DATETIME2 DEFAULT SYSDATETIME(),
    UpdatedBy NVARCHAR(100) NULL,
    UpdatedAt DATETIME2 DEFAULT SYSDATETIME(),
    UNIQUE(PartnerCode, PartnerType)
);
CREATE INDEX IX_Partners_PartnerType ON Partners(PartnerType);
CREATE INDEX IX_Partners_PartnerCode ON Partners(PartnerCode);
CREATE INDEX IX_Partners_PartnerName ON Partners(PartnerName);
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
INSERT INTO PurchaseOrders (PONumber, InvoiceNumber, SupplierName, CustomerCode, WarehouseCode, Currency, InvoiceDate, TotalAmount, Status, CreatedBy, AssignedTo) VALUES
('PO-2025-001', 'INV-2025-001', N'Công ty ABC', 'CUST001', 'WH001', 'VND', '2025-11-20', 5000000, 'CONFIRM', N'Nguyễn Văn A', N'Trần Thị B'),
('PO-2025-002', 'INV-2025-002', N'Công ty XYZ', 'CUST002', 'WH001', 'VND', '2025-11-21', 7500000, 'CONFIRM', N'Nguyễn Văn A', N'Lê Văn C'),
('PO-2025-003', NULL, N'Công ty DEF', 'CUST001', 'WH002', 'VND', NULL, 0, 'INITIAL', N'Nguyễn Văn A', NULL); -- INITIAL không ảnh hưởng MPS
GO

-- Purchase Order Lines
INSERT INTO PurchaseOrderLines (PurchaseOrderId, MaterialId, Quantity, Unit, UnitPrice, TotalAmount, EtaYear, EtaWeek) VALUES
(1, 1, 5, 'PCS', 1000000, 5000000, 2025, 49),  -- NVL3: 5 units @ 1,000,000 = 5,000,000 arriving week 49/2025
(2, 2, 5, 'PCS', 1000000, 5000000, 2025, 49),  -- NVL4: 5 units @ 1,000,000 = 5,000,000 arriving week 49/2025
(2, 3, 5, 'PCS', 500000, 2500000, 2025, 49);  -- NVL5: 5 units @ 500,000 = 2,500,000 arriving week 49/2025
GO

-- Sales Plans (SHIP_QTY forecast - dự báo do user nhập)
-- Không insert seed data, để user tự nhập

-- Sales Orders (seed mẫu)
INSERT INTO SalesOrders (InvoiceNumber, CustomerName, CustomerCode, DeliveryDate, Status, TotalAmount, CreatedBy) VALUES
('SO-2025-001', N'Công ty Alpha', 'CUST-A', '2025-12-02', 'CONFIRM', 5000000, N'Nguyễn Văn A'),
('SO-2025-002', N'Công ty Beta', 'CUST-B', '2025-12-09', 'CONFIRM', 4000000, N'Nguyễn Văn A'),
('SO-2025-003', N'Công ty Gamma', 'CUST-C', '2025-12-16', 'INITIAL', 0, N'Nguyễn Văn A');
GO

INSERT INTO SalesOrderLines (SalesOrderId, ProductId, Quantity, Unit, UnitPrice, TotalAmount) VALUES
(1, 1, 5, 'PCS', 1000000, 5000000),   -- Product 589: 5 units, week of 2025-12-02
(2, 1, 3, 'PCS', 1000000, 3000000),   -- Product 589: 3 units, week of 2025-12-09
(2, 2, 2, 'PCS', 500000, 1000000);    -- Product 990: 2 units
GO

-- Partners (Khách hàng + Nhà cung cấp)
INSERT INTO Partners (PartnerCode, PartnerName, PartnerType, TaxCode, Representative, Phone, Email, Address, CreatedBy) VALUES
('CUST001', N'Công ty Alpha', 'C', '0123456789', N'Nguyễn Văn A', '0901234567', 'alpha@example.com', N'123 Đường ABC, Quận 1, TP.HCM', N'System'),
('CUST002', N'Công ty Beta', 'C', '0987654321', N'Trần Thị B', '0912345678', 'beta@example.com', N'456 Đường XYZ, Quận 2, TP.HCM', N'System'),
('SUP001', N'Công ty ABC', 'S', '0111222333', N'Lê Văn C', '0923456789', 'abc@supplier.com', N'789 KCN A, Bình Dương', N'System'),
('SUP002', N'Công ty XYZ', 'S', '0444555666', N'Phạm Thị D', '0934567890', 'xyz@supplier.com', N'321 KCN B, Đồng Nai', N'System');
GO

PRINT 'Database schema and seed data created successfully!';
GO
