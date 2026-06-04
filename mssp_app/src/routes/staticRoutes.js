const path = require("node:path");
const { PUBLIC_DIR } = require("../config/paths");
const { contentTypeFor } = require("../utils/contentTypes");
const { sendFile } = require("../utils/http");

function handleStaticRoutes(requestUrl, response) {
  const safePath = requestUrl.pathname === "/" ? "/index.html" : requestUrl.pathname;
  const filePath = path.normalize(path.join(PUBLIC_DIR, safePath));

  if (!filePath.startsWith(PUBLIC_DIR)) {
    response.writeHead(403);
    response.end("Forbidden");
    return true;
  }

  sendFile(response, filePath, contentTypeFor(filePath));
  return true;
}

module.exports = {
  handleStaticRoutes,
};
