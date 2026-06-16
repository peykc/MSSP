const fs = require("node:fs");

const SCHEMA_VERSION = 1;

function writeSourcesPayload({ filePath, sources, sourceBaseUrl }) {
  const payload = {
    generatedAt: new Date().toISOString(),
    schemaVersion: SCHEMA_VERSION,
    sourceBaseUrl,
    sources,
  };

  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  JSON.parse(fs.readFileSync(filePath, "utf8"));
  return payload;
}

module.exports = {
  SCHEMA_VERSION,
  writeSourcesPayload,
};
