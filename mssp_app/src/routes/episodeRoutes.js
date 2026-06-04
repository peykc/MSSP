const { sendJson } = require("../utils/http");

function handleEpisodeRoutes(requestUrl, response, context) {
  if (requestUrl.pathname !== "/api/episodes") return false;

  const result = context.episodeService.listEpisodes({
    collection: requestUrl.searchParams.get("collection") || "anthology",
    query: requestUrl.searchParams.get("q") || "",
  });

  if (result.error) {
    sendJson(response, { error: result.error }, 400);
    return true;
  }

  sendJson(response, result);
  return true;
}

module.exports = {
  handleEpisodeRoutes,
};
