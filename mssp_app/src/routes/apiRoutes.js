const { sendJson } = require("../utils/http");

function handleApiRoutes(requestUrl, response, context) {
  if (requestUrl.pathname === "/api/health") {
    sendJson(response, {
      databaseLoaded: Boolean(context.db),
      sourceFile: context.health.sourceFile,
      parsedRows: context.health.parsedRows,
      skippedRows: context.health.skippedRows,
      counts: context.health.counts,
      warnings: context.health.warnings,
      metadataDiagnostics: context.health.metadataDiagnostics,
    });
    return true;
  }

  return false;
}

module.exports = {
  handleApiRoutes,
};
