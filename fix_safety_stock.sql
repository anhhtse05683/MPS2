-- =============================================
-- Migration: Add SafetyStockQty to Materials
-- Chạy script này nếu DB đã tồn tại và chưa có cột SafetyStockQty
-- =============================================

USE MPS;
GO

IF NOT EXISTS (
    SELECT 1 FROM sys.columns
    WHERE object_id = OBJECT_ID('Materials') AND name = 'SafetyStockQty'
)
BEGIN
    ALTER TABLE Materials
    ADD SafetyStockQty DECIMAL(18,3) NULL DEFAULT 0;
    PRINT 'Added SafetyStockQty column to Materials table.';
END
ELSE
BEGIN
    PRINT 'SafetyStockQty column already exists.';
END
GO
