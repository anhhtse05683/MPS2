-- =============================================
-- Migration: Auth + User + RBAC (JWT + Refresh)
-- Chạy script này để thêm bảng User, Roles, Permissions, ...
-- =============================================

USE MPS;
GO

-- Drop Employee nếu tồn tại
IF OBJECT_ID('UserRoles', 'U') IS NOT NULL DROP TABLE UserRoles;
IF OBJECT_ID('RolePermissions', 'U') IS NOT NULL DROP TABLE RolePermissions;
IF OBJECT_ID('RefreshTokens', 'U') IS NOT NULL DROP TABLE RefreshTokens;
IF OBJECT_ID('Users', 'U') IS NOT NULL DROP TABLE Users;
IF OBJECT_ID('Permissions', 'U') IS NOT NULL DROP TABLE Permissions;
IF OBJECT_ID('Roles', 'U') IS NOT NULL DROP TABLE Roles;
IF OBJECT_ID('Employee', 'U') IS NOT NULL DROP TABLE Employee;
GO

-- Department (nếu chưa có)
IF OBJECT_ID('Department', 'U') IS NULL
BEGIN
CREATE TABLE Department (
    DeptId INT IDENTITY(1,1) PRIMARY KEY,
    DeptName NVARCHAR(200) NOT NULL,
    Manager NVARCHAR(200) NULL,
    CreateAt DATETIME2 DEFAULT SYSDATETIME(),
    CreateBy NVARCHAR(100) NULL,
    LastUpdateAt DATETIME2 DEFAULT SYSDATETIME(),
    LastUpdateBy NVARCHAR(100) NULL
);
INSERT INTO Department (DeptName, Manager) VALUES (N'Phòng Hành chính', NULL), (N'Phòng Kinh doanh', NULL), (N'Phòng Kỹ thuật', NULL);
PRINT 'Department table created.';
END
ELSE
BEGIN
-- Nếu bảng đã có nhưng trống, thêm data mẫu
IF NOT EXISTS (SELECT 1 FROM Department)
INSERT INTO Department (DeptName, Manager) VALUES (N'Phòng Hành chính', NULL), (N'Phòng Kinh doanh', NULL), (N'Phòng Kỹ thuật', NULL);
END
GO

-- Users
CREATE TABLE Users (
    UserId INT IDENTITY(1,1) PRIMARY KEY,
    Username NVARCHAR(50) NOT NULL UNIQUE,
    PasswordHash NVARCHAR(255) NOT NULL,
    FullName NVARCHAR(200) NOT NULL,
    Email NVARCHAR(200) NULL,
    Phone NVARCHAR(50) NULL,
    DeptId INT NULL,
    IsActive BIT NOT NULL DEFAULT 1,
    CreatedAt DATETIME2 DEFAULT SYSDATETIME(),
    CreatedBy INT NULL,
    LastUpdateAt DATETIME2 DEFAULT SYSDATETIME(),
    LastUpdateBy INT NULL,
    FOREIGN KEY (DeptId) REFERENCES Department(DeptId)
);
CREATE INDEX IX_Users_Username ON Users(Username);
CREATE INDEX IX_Users_IsActive ON Users(IsActive);
GO

-- Roles
CREATE TABLE Roles (
    RoleId INT IDENTITY(1,1) PRIMARY KEY,
    RoleCode NVARCHAR(50) NOT NULL UNIQUE,
    RoleName NVARCHAR(200) NOT NULL,
    Description NVARCHAR(500) NULL,
    CreatedAt DATETIME2 DEFAULT SYSDATETIME()
);
GO

-- Permissions (module.action: vd purchase.view, purchase.add, sales.edit, ...)
CREATE TABLE Permissions (
    PermissionId INT IDENTITY(1,1) PRIMARY KEY,
    PermissionCode NVARCHAR(100) NOT NULL UNIQUE,
    PermissionName NVARCHAR(200) NOT NULL,
    ModuleCode NVARCHAR(50) NOT NULL,
    ActionCode NVARCHAR(50) NOT NULL,
    CreatedAt DATETIME2 DEFAULT SYSDATETIME()
);
GO

-- UserRoles
CREATE TABLE UserRoles (
    UserRoleId INT IDENTITY(1,1) PRIMARY KEY,
    UserId INT NOT NULL,
    RoleId INT NOT NULL,
    CreatedAt DATETIME2 DEFAULT SYSDATETIME(),
    FOREIGN KEY (UserId) REFERENCES Users(UserId) ON DELETE CASCADE,
    FOREIGN KEY (RoleId) REFERENCES Roles(RoleId) ON DELETE CASCADE,
    UNIQUE(UserId, RoleId)
);
GO

-- RolePermissions
CREATE TABLE RolePermissions (
    RolePermissionId INT IDENTITY(1,1) PRIMARY KEY,
    RoleId INT NOT NULL,
    PermissionId INT NOT NULL,
    CreatedAt DATETIME2 DEFAULT SYSDATETIME(),
    FOREIGN KEY (RoleId) REFERENCES Roles(RoleId) ON DELETE CASCADE,
    FOREIGN KEY (PermissionId) REFERENCES Permissions(PermissionId) ON DELETE CASCADE,
    UNIQUE(RoleId, PermissionId)
);
GO

-- RefreshTokens (cho JWT refresh)
CREATE TABLE RefreshTokens (
    RefreshTokenId INT IDENTITY(1,1) PRIMARY KEY,
    UserId INT NOT NULL,
    Token NVARCHAR(500) NOT NULL,
    ExpiresAt DATETIME2 NOT NULL,
    CreatedAt DATETIME2 DEFAULT SYSDATETIME(),
    RevokedAt DATETIME2 NULL,
    FOREIGN KEY (UserId) REFERENCES Users(UserId) ON DELETE CASCADE
);
CREATE INDEX IX_RefreshTokens_UserId ON RefreshTokens(UserId);
CREATE INDEX IX_RefreshTokens_Token ON RefreshTokens(Token);
GO

-- Seed Roles
INSERT INTO Roles (RoleCode, RoleName, Description) VALUES
('admin', N'Quản trị viên', N'Full quyền'),
('manager', N'Quản lý', N'Quản lý và thao tác'),
('staff', N'Nhân viên', N'Thao tác cơ bản'),
('guest', N'Khách', N'Chỉ xem');
GO

-- Seed Permissions (module.action)
INSERT INTO Permissions (PermissionCode, PermissionName, ModuleCode, ActionCode) VALUES
('mps.view', N'MPS - Xem', 'mps', 'view'),
('mps.edit', N'MPS - Sửa', 'mps', 'edit'),
('production.view', N'Production - Xem', 'production', 'view'),
('production.edit', N'Production - Sửa', 'production', 'edit'),
('product.view', N'Product - Xem', 'product', 'view'),
('product.edit', N'Product - Sửa', 'product', 'edit'),
('purchase.view', N'Purchase - Xem', 'purchase', 'view'),
('purchase.add', N'Purchase - Thêm', 'purchase', 'add'),
('purchase.edit', N'Purchase - Sửa', 'purchase', 'edit'),
('purchase.delete', N'Purchase - Xóa', 'purchase', 'delete'),
('sales.view', N'Sales - Xem', 'sales', 'view'),
('sales.add', N'Sales - Thêm', 'sales', 'add'),
('sales.edit', N'Sales - Sửa', 'sales', 'edit'),
('sales.delete', N'Sales - Xóa', 'sales', 'delete'),
('partners.view', N'Partners - Xem', 'partners', 'view'),
('partners.add', N'Partners - Thêm', 'partners', 'add'),
('partners.edit', N'Partners - Sửa', 'partners', 'edit'),
('partners.delete', N'Partners - Xóa', 'partners', 'delete'),
('users.view', N'Users - Xem', 'users', 'view'),
('users.add', N'Users - Thêm', 'users', 'add'),
('users.edit', N'Users - Sửa', 'users', 'edit'),
('users.delete', N'Users - Xóa', 'users', 'delete');
GO

-- Admin role: full permissions
INSERT INTO RolePermissions (RoleId, PermissionId)
SELECT 1, PermissionId FROM Permissions;
GO

-- Guest role: view only
INSERT INTO RolePermissions (RoleId, PermissionId)
SELECT 4, PermissionId FROM Permissions WHERE ActionCode = 'view';
GO

-- Staff: view + edit (add/edit for purchase, sales, partners)
INSERT INTO RolePermissions (RoleId, PermissionId)
SELECT 3, PermissionId FROM Permissions 
WHERE PermissionCode IN ('mps.view','mps.edit','production.view','production.edit','product.view','product.edit',
  'purchase.view','purchase.add','purchase.edit','sales.view','sales.add','sales.edit','partners.view','partners.add','partners.edit');
GO

-- Manager: full except users
INSERT INTO RolePermissions (RoleId, PermissionId)
SELECT 2, PermissionId FROM Permissions WHERE ModuleCode != 'users';
GO

-- Admin user: tạo từ server khi startup (nếu chưa có user nào)
-- Password mặc định: admin123
GO

PRINT 'Auth tables created. Start server to create admin user (admin/admin123).';
GO
