const { createServer } = require("./src/app");
const { DB_PATH, HOST, PORT } = require("./src/config/paths");

const server = createServer();

server.on("error", (error) => {
  if (error.code === "EADDRINUSE") {
    console.error(`Port ${PORT} is already in use. Close the other MSSP server or change PORT.`);
    process.exit(1);
  }

  throw error;
});

server.listen(PORT, HOST, () => {
  console.log(`MSSP Anthology indexed into ${DB_PATH}`);
  console.log(`Open http://127.0.0.1:${PORT}`);
  console.log(`Listening on http://${HOST}:${PORT}`);
});
