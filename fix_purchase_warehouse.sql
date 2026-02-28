-- =============================================
-- Tạo bảng Warehouses (cho dropdown Kho trong form Mua hàng)
-- Không thay đổi PurchaseOrders - vẫn dùng WarehouseCode
-- =============================================

USE MPS;
GO

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
    PRINT 'Warehouses table created.';
END
ELSE
BEGIN
    PRINT 'Warehouses table already exists.';
END
GO
