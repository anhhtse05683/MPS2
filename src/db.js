const sql = require("mssql");

const config = {
  user: process.env.SQL_USER,
  password: process.env.SQL_PASSWORD,
  server: process.env.SQL_SERVER || "localhost",
  database: process.env.SQL_DATABASE,
  port: Number(process.env.SQL_PORT || 1433),
  options: {
    encrypt: process.env.SQL_ENCRYPT === "true", // for Azure; false for local
    trustServerCertificate: process.env.SQL_ENCRYPT !== "true"
  },
  pool: {
    max: 10,
    min: 0,
    idleTimeoutMillis: 30000
  }
};

let poolPromise;

async function getPool() {
  if (!poolPromise) {
    poolPromise = sql
      .connect(config)
      .then((pool) => {
        console.log("Connected to SQL Server");
        return pool;
      })
      .catch((err) => {
        console.error("SQL Server connection error", err);
        poolPromise = undefined;
        throw err;
      });
  }
  return poolPromise;
}

module.exports = {
  sql,
  getPool
};





