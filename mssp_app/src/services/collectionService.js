const { COLLECTIONS } = require("../config/collections");
const { COVERS } = require("../config/paths");

function createCollectionService(db) {
  function listCollections() {
    const stats = getCollectionStats(db);
    const total = stats.anthology?.count || 0;
    return {
      total,
      collections: COLLECTIONS.map((collection) => {
        const cover = COVERS[collection.coverKind] || {};
        return {
          id: collection.id,
          name: collection.name,
          shortName: collection.shortName,
          coverUrl: `/covers/${collection.coverKind}`,
          hoverCoverUrl: cover.hoverFile ? `/covers/${collection.coverKind}-hover` : "",
          accent: collection.accent,
          count: stats[collection.id]?.count || 0,
          startDate: stats[collection.id]?.startDate || "",
          endDate: stats[collection.id]?.endDate || "",
        };
      }),
    };
  }

  return {
    listCollections,
  };
}

function getCollectionStats(db) {
  const anthology = db.prepare(`
    SELECT COUNT(*) AS count, MIN(date) AS startDate, MAX(date) AS endDate
    FROM episodes
  `).get();
  const rows = db.prepare(`
    SELECT collection_kind AS collection, COUNT(*) AS count, MIN(date) AS startDate, MAX(date) AS endDate
    FROM episodes
    GROUP BY collection_kind
  `).all();

  const stats = {
    anthology,
  };
  for (const row of rows) {
    stats[row.collection] = row;
  }
  return stats;
}

module.exports = {
  createCollectionService,
  getCollectionStats,
};
