const sql = require("mssql");

// Parse SQL_SERVER to handle both named instance and port-based connections
const sqlServer = process.env.SQL_SERVER || "localhost";
const hasInstance = sqlServer.includes("\\") || sqlServer.includes("/");

const config = {
  user: process.env.SQL_USER,
  password: process.env.SQL_PASSWORD,
  server: sqlServer,
  database: process.env.SQL_DATABASE,
  // Only set port if not using named instance (named instances use dynamic ports)
  ...(hasInstance ? {} : { port: Number(process.env.SQL_PORT || 1433) }),
  options: {
    encrypt: process.env.SQL_ENCRYPT === "true", // for Azure; false for local
    trustServerCertificate: process.env.SQL_ENCRYPT !== "true",
    // Enable instance name resolution for named instances
    enableArithAbort: true,
    instanceName: hasInstance ? sqlServer.split(/[\\\/]/)[1] : undefined
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





