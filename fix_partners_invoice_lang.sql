-- =============================================
-- Partners: Country + InvoiceLanguage cho invoice đa ngôn ngữ
-- Chạy sau schema
-- =============================================

USE MPS;
GO

IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('Partners') AND name = 'Country')
BEGIN
    ALTER TABLE Partners ADD Country NVARCHAR(2) NULL;
    PRINT 'Added Partners.Country';
END
GO

IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('Partners') AND name = 'InvoiceLanguage')
BEGIN
    ALTER TABLE Partners ADD InvoiceLanguage CHAR(2) NULL;
    PRINT 'Added Partners.InvoiceLanguage';
END
GO

PRINT 'fix_partners_invoice_lang.sql completed.';
GO
