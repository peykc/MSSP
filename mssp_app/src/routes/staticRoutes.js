const path = require("node:path");
const { PUBLIC_DIR } = require("../config/paths");
const { contentTypeFor } = require("../utils/contentTypes");
const { sendFile } = require("../utils/http");

function handleStaticRoutes(requestUrl, response) {
  let decodedPath;
  try {
    decodedPath = decodeURIComponent(requestUrl.pathname);
  } catch {
    response.writeHead(400);
    response.end("Bad Request");
    return true;
  }

  const safePath = decodedPath === "/" ? "index.html" : decodedPath.replace(/^[/\\]+/, "");
  const filePath = path.resolve(PUBLIC_DIR, safePath);
  const publicPathPrefix = `${PUBLIC_DIR}${path.sep}`;

  if (filePath !== PUBLIC_DIR && !filePath.startsWith(publicPathPrefix)) {
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
