-- =============================================
-- ActivityLog: thêm cột ClientIP để ghi IP người dùng
-- Chạy sau fix_activity_log.sql
-- =============================================

USE MPS;
GO

IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('ActivityLog') AND name = 'ClientIP')
BEGIN
    ALTER TABLE ActivityLog ADD ClientIP NVARCHAR(45) NULL;
    CREATE INDEX IX_ActivityLog_ClientIP ON ActivityLog(ClientIP);
    PRINT 'Added ClientIP column to ActivityLog.';
END
ELSE
    PRINT 'ActivityLog.ClientIP already exists.';
GO
