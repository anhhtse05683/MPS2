-- =============================================
-- BOM: thêm CreatedBy, UpdatedBy cho audit log
-- Chạy sau schema
-- =============================================

USE MPS;
GO

IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('BomLines') AND name = 'CreatedBy') BEGIN
    ALTER TABLE BomLines ADD CreatedBy NVARCHAR(100) NULL;
    PRINT 'Added CreatedBy to BomLines.';
END
IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('BomLines') AND name = 'UpdatedBy') BEGIN
    ALTER TABLE BomLines ADD UpdatedBy NVARCHAR(100) NULL;
    PRINT 'Added UpdatedBy to BomLines.';
END
GO

-- Materials: thêm Unit nếu chưa có
IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('Materials') AND name = 'Unit') BEGIN
    ALTER TABLE Materials ADD Unit NVARCHAR(20) NULL DEFAULT 'PCS';
    PRINT 'Added Unit to Materials.';
END
GO

PRINT 'fix_bom_audit.sql completed.';
GO
