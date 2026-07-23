const EXPECTED_COUNTS = {
  anthology: 913,
  old: 145,
  new: 369,
  paytch: 399,
};

const COLLECTIONS = [
  {
    id: "anthology",
    name: "The Holy Trinity",
    shortName: "Holy Trinity",
    coverKind: "anthology",
    filter: () => true,
    accent: "#7fc1ad",
  },
  {
    id: "old",
    name: "The Old Testament",
    shortName: "Old Test",
    coverKind: "old",
    filter: (episode) => episode.series === "MSSPOT" && !episode.isPaytch,
    accent: "#8da1b8",
  },
  {
    id: "new",
    name: "The New Testament",
    shortName: "New Test",
    coverKind: "new",
    filter: (episode) => episode.series === "MSSP" && !episode.isPaytch,
    accent: "#c79457",
  },
  {
    id: "paytch",
    name: "The PAYTCH",
    shortName: "PAYTCH",
    coverKind: "paytch",
    filter: (episode) => episode.isPaytch,
    accent: "#f96854",
  },
];

function getCollection(id) {
  return COLLECTIONS.find((collection) => collection.id === id);
}

function isKnownCollection(id) {
  return Boolean(getCollection(id));
}

module.exports = {
  COLLECTIONS,
  EXPECTED_COUNTS,
  getCollection,
  isKnownCollection,
};
