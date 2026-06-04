const { sendJson } = require("../utils/http");

function handleCollectionRoutes(requestUrl, response, context) {
  if (requestUrl.pathname !== "/api/collections") return false;
  sendJson(response, context.collectionService.listCollections());
  return true;
}

module.exports = {
  handleCollectionRoutes,
};
