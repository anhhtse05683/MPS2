-- Fix ImageUrl column length to support base64 images
USE MPS;
GO

-- Increase ImageUrl column length to MAX to support base64 encoded images
ALTER TABLE Products ALTER COLUMN ImageUrl NVARCHAR(MAX) NULL;
GO

ALTER TABLE Materials ALTER COLUMN ImageUrl NVARCHAR(MAX) NULL;
GO

PRINT 'ImageUrl columns updated successfully!';
GO

