-- =============================================
-- ETA: chuyển từ EtaYear/EtaWeek sang EtaDate (ngày cụ thể)
-- MPS tự tính năm/tuần từ EtaDate để hiển thị
-- Chạy sau schema / fix_inventory
-- =============================================

USE MPS;
GO

-- Thêm cột EtaDate (ngày dự kiến nhận hàng)
IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('PurchaseOrderLines') AND name = 'EtaDate') BEGIN
    ALTER TABLE PurchaseOrderLines ADD EtaDate DATE NULL;
    PRINT 'Added EtaDate column to PurchaseOrderLines.';
END
GO

-- Migrate dữ liệu cũ: EtaYear/EtaWeek -> EtaDate (ngày thứ 4 của tuần - thường nằm trong tuần ISO)
UPDATE pol SET pol.EtaDate = DATEADD(DAY, (ISNULL(pol.EtaWeek, 1) - 1) * 7, DATEFROMPARTS(ISNULL(pol.EtaYear, YEAR(GETDATE())), 1, 4))
FROM PurchaseOrderLines pol
WHERE pol.EtaDate IS NULL AND pol.EtaYear IS NOT NULL AND pol.EtaWeek IS NOT NULL;
GO

PRINT 'fix_eta_date.sql completed.';
GO
