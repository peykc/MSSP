function createSourceService() {
  return {
    listPublicSources() {
      return {
        sources: [],
        status: "unresolved",
      };
    },
  };
}

module.exports = {
  createSourceService,
};
