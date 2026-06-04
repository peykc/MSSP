const http = require("node:http");
const { URL } = require("node:url");
const { ANTHOLOGY_MARKDOWN, DB_PATH } = require("./config/paths");
const { openDatabase } = require("./data/database");
const { seedDatabase } = require("./data/seedDatabase");
const { createCollectionService } = require("./services/collectionService");
const { createEpisodeService } = require("./services/episodeService");
const { createSourceService } = require("./services/sourceService");
const { handleApiRoutes } = require("./routes/apiRoutes");
const { handleCollectionRoutes } = require("./routes/collectionRoutes");
const { handleEpisodeRoutes } = require("./routes/episodeRoutes");
const { handleCoverRoutes } = require("./routes/coverRoutes");
const { handleStaticRoutes } = require("./routes/staticRoutes");
const { sendJson } = require("./utils/http");

function createApp(options = {}) {
  const dbPath = options.dbPath || DB_PATH;
  const anthologyPath = options.anthologyPath || ANTHOLOGY_MARKDOWN;
  const db = openDatabase(dbPath);
  const health = seedDatabase(db, anthologyPath);

  for (const warning of health.warnings) {
    console.warn(`[mssp validation] ${warning}`);
  }

  const context = {
    db,
    dbPath,
    health,
    collectionService: createCollectionService(db),
    episodeService: createEpisodeService(db),
    sourceService: createSourceService(),
  };

  return function app(request, response) {
    const requestUrl = new URL(request.url, `http://${request.headers.host}`);

    if (requestUrl.pathname.startsWith("/api/")) {
      if (handleApiRoutes(requestUrl, response, context)) return;
      if (handleCollectionRoutes(requestUrl, response, context)) return;
      if (handleEpisodeRoutes(requestUrl, response, context)) return;

      sendJson(response, { error: "Not found" }, 404);
      return;
    }

    if (handleCoverRoutes(requestUrl, response, context)) return;
    handleStaticRoutes(requestUrl, response, context);
  };
}

function createServer(options = {}) {
  return http.createServer(createApp(options));
}

module.exports = {
  createApp,
  createServer,
};
