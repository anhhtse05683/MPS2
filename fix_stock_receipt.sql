-- =============================================
-- StockReceipts (Phiếu nhập kho) - tương tự StockIssues
-- Khi PO CONFIRM → tạo StockReceipt DRAFT
-- Nhân viên kho xác nhận khi hàng đến → CONFIRM → tạo StockTransactions (RECEIPT), cộng tồn kho
-- Chạy sau fix_inventory.sql
-- =============================================

USE MPS;
GO

IF OBJECT_ID('StockReceiptLines', 'U') IS NOT NULL DROP TABLE StockReceiptLines;
IF OBJECT_ID('StockReceipts', 'U') IS NOT NULL DROP TABLE StockReceipts;
GO

-- StockReceipts (Phiếu nhập kho NVL từ mua hàng)
CREATE TABLE StockReceipts (
    StockReceiptId INT IDENTITY(1,1) PRIMARY KEY,
    ReceiptNumber NVARCHAR(50) NOT NULL UNIQUE,
    WarehouseId INT NOT NULL,
    PurchaseOrderId INT NULL,
    ReceiptDate DATE NOT NULL,
    Status NVARCHAR(20) NOT NULL DEFAULT 'DRAFT',  -- DRAFT, CONFIRM
    Notes NVARCHAR(500) NULL,
    CreatedBy INT NULL,
    CreatedAt DATETIME2 DEFAULT SYSDATETIME(),
    ConfirmedBy INT NULL,
    ConfirmedAt DATETIME2 NULL,
    FOREIGN KEY (WarehouseId) REFERENCES Warehouses(WarehouseId) ON DELETE CASCADE,
    FOREIGN KEY (PurchaseOrderId) REFERENCES PurchaseOrders(PurchaseOrderId) ON DELETE NO ACTION
);
CREATE INDEX IX_StockReceipts_PurchaseOrder ON StockReceipts(PurchaseOrderId);
CREATE INDEX IX_StockReceipts_Date ON StockReceipts(ReceiptDate);
CREATE INDEX IX_StockReceipts_Status ON StockReceipts(Status);
GO

-- StockReceiptLines (Chi tiết phiếu nhập - NVL)
CREATE TABLE StockReceiptLines (
    StockReceiptLineId INT IDENTITY(1,1) PRIMARY KEY,
    StockReceiptId INT NOT NULL,
    MaterialId INT NOT NULL,
    Quantity DECIMAL(18,3) NOT NULL,
    Notes NVARCHAR(200) NULL,
    FOREIGN KEY (StockReceiptId) REFERENCES StockReceipts(StockReceiptId) ON DELETE CASCADE,
    FOREIGN KEY (MaterialId) REFERENCES Materials(MaterialId) ON DELETE CASCADE
);
GO

PRINT 'StockReceipts and StockReceiptLines tables created.';
GO
