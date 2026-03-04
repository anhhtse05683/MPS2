-- =============================================
-- LoginLog: ghi lịch sử đăng nhập (IP, UserAgent, thành công/thất bại)
-- Chạy sau fix_auth.sql
-- =============================================

USE MPS;
GO

IF OBJECT_ID('LoginLog', 'U') IS NULL
BEGIN
    CREATE TABLE LoginLog (
        LogId BIGINT IDENTITY(1,1) PRIMARY KEY,
        LogAt DATETIME2 DEFAULT SYSDATETIME(),
        Username NVARCHAR(100) NOT NULL,
        UserId INT NULL,
        Success BIT NOT NULL,
        ClientIP NVARCHAR(45) NULL,
        UserAgent NVARCHAR(500) NULL,
        FailReason NVARCHAR(200) NULL
    );
    CREATE INDEX IX_LoginLog_LogAt ON LoginLog(LogAt);
    CREATE INDEX IX_LoginLog_Username ON LoginLog(Username);
    CREATE INDEX IX_LoginLog_ClientIP ON LoginLog(ClientIP);
    CREATE INDEX IX_LoginLog_Success ON LoginLog(Success);
    PRINT 'Created LoginLog table.';
END
ELSE
    PRINT 'LoginLog table already exists.';
GO
