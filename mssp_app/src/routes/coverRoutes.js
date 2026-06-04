const { COVERS } = require("../config/paths");
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

  const coverFile = isHoverCover ? cover.hoverFile : cover.file;
  if (!coverFile) {
    response.writeHead(404);
    response.end("Not found");
    return true;
  }

  sendFile(response, coverFile, "image/jpeg");
  return true;
}

module.exports = {
  handleCoverRoutes,
};
