const fs = require("node:fs");
const path = require("node:path");
const { COVERS, PUBLIC_DIR } = require("../config/paths");
const { contentTypeFor } = require("../utils/contentTypes");
const { sendFile } = require("../utils/http");

function handleCoverRoutes(requestUrl, response) {
  if (!requestUrl.pathname.startsWith("/covers/")) return false;

  const id = requestUrl.pathname.split("/").pop();
  const isHoverCover = id.endsWith("-hover");
  const coverKind = isHoverCover ? id.slice(0, -6) : id;
  const cover = COVERS[coverKind];

  if (!cover) {
    response.writeHead(404);
    response.end("Not found");
    return true;
  }

  const publicWebp = path.join(PUBLIC_DIR, "assets", "covers", `${id}.webp`);
  if (fs.existsSync(publicWebp)) {
    sendFile(response, publicWebp, contentTypeFor(publicWebp));
    return true;
  }

  const coverFile = isHoverCover ? cover.hoverFile : cover.file;
  if (!coverFile) {
    response.writeHead(404);
    response.end("Not found");
    return true;
  }

  sendFile(response, coverFile, contentTypeFor(coverFile));
  return true;
}

module.exports = {
  handleCoverRoutes,
};
