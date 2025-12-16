# Material Planning Schedule (MPS)

Full-stack demo (Express + SQL Server + Bootstrap/JS) for visualizing product and material balances by week.

## Requirements implemented
- Product table: `SHIP_QTY` (editable, saved to SalesPlans), `Pro_QTY` (Production orders status ACTIVE/COMPLETE), `Balance` (opening week fixed; next weeks `prev_balance - ship_qty + pro_qty`; weeks before opening = 0). Only one opening balance per product.
- Material table: `Stock_In_Qty` (Purchase orders status CONFIRM), `Stock_Out_Qty` (Production * BOM consume), `Balance` (opening week fixed; next weeks `prev_balance - stock_out + stock_in`; weeks before opening = 0). Only one opening balance per material.
- Week range selector spans years. Negative balances are red. Two tables scroll in sync.

## Quick start
1) Install deps  
```bash
npm install
```
2) Prepare env: copy `env.sample` to `.env` and fill SQL connection + port.
3) Create DB + seed: run `schema.sql` in SQL Server (creates Products, Materials, BOM, OpeningBalances, SalesPlans, ProductionOrders, PurchaseOrders/Lines with sample data).
4) Run server  
```bash
npm start
```
Open http://localhost:3000 (served from `index.html`).

## API (used by frontend)
- `GET /api/products`
- `GET /api/materials?productId=`
- `GET /api/opening-balance/product/:id`
- `GET /api/opening-balance/material/:id`
- `PUT /api/opening-balance` `{ itemType:'P'|'M', itemId, startYear, startWeek, balanceQty }`
- `GET /api/production?productId&fromYear&fromWeek&toYear&toWeek`
- `GET /api/purchase?materialId(optional)&fromYear&fromWeek&toYear&toWeek`
- `GET /api/sales-plan?productId&fromYear&fromWeek&toYear&toWeek`
- `PUT /api/sales-plan` `{ productId, plans:[{year, week, qty}] }`

## Frontend usage
- Chọn tuần/năm bắt đầu-kết thúc, chọn sản phẩm.
- Nhập balance mở (tuần/năm/giá trị) cho product rồi bấm “Xem lịch” để lưu (API).
- Nhập SHIP_QTY tại ô sản phẩm; tự tính Balance và tự lưu (PUT /api/sales-plan).
- Balance NVL tự tính dựa trên BOM, Production, Purchase và tồn mở NVL.

## Deployment notes
- Static served from Express root (`index.html`).
- For IIS/Reverse proxy, forward to Node port (default 3000); enable CORS if cross-origin.
- SQL encryption toggle via `SQL_ENCRYPT` in `.env` (set true for Azure, false for local/trust). 

