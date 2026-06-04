const { createServer } = require("./src/app");
const { DB_PATH, HOST, PORT } = require("./src/config/paths");

const server = createServer();

server.listen(PORT, HOST, () => {
  console.log(`MSSP Anthology indexed into ${DB_PATH}`);
  console.log(`Open http://127.0.0.1:${PORT}`);
  console.log(`Listening on http://${HOST}:${PORT}`);
});
