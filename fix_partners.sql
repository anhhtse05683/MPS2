-- =============================================
-- Migration: Add Partners table (Khách hàng + Nhà cung cấp)
-- Chạy script này nếu DB đã tồn tại và chưa có bảng Partners
-- =============================================

USE MPS;
GO

IF OBJECT_ID('Partners', 'U') IS NULL
BEGIN
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

PRINT 'Partners table created successfully!';
END
ELSE
    PRINT 'Partners table already exists. Skipping.';
GO
