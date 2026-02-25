-- =============================================
-- Migration: Add SalesOrders and SalesOrderLines
-- Chạy script này nếu DB đã tồn tại và chưa có bảng Sales
-- =============================================

USE MPS;
GO

IF OBJECT_ID('SalesOrders', 'U') IS NULL
BEGIN
CREATE TABLE SalesOrders (
    SalesOrderId INT IDENTITY(1,1) PRIMARY KEY,
    InvoiceNumber NVARCHAR(50) NULL,
    CustomerName NVARCHAR(200) NULL,
    CustomerCode NVARCHAR(50) NULL,
    DeliveryDate DATE NULL,
    Status NVARCHAR(20) NOT NULL DEFAULT 'INITIAL',
    Currency NVARCHAR(10) DEFAULT 'VND',
    TotalAmount DECIMAL(18,2) DEFAULT 0,
    CreatedBy NVARCHAR(100) NULL,
    AssignedTo NVARCHAR(100) NULL,
    CreatedAt DATETIME2 DEFAULT SYSDATETIME(),
    UpdatedAt DATETIME2 DEFAULT SYSDATETIME()
);

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

CREATE INDEX IX_SalesOrders_Status ON SalesOrders(Status);
CREATE INDEX IX_SalesOrders_DeliveryDate ON SalesOrders(DeliveryDate);
CREATE INDEX IX_SalesOrderLines_ProductId ON SalesOrderLines(ProductId);

PRINT 'SalesOrders and SalesOrderLines created successfully!';
END
ELSE
    PRINT 'SalesOrders already exists. Skipping.';
GO
