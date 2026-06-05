const path = require("node:path");

const APP_DIR = path.resolve(__dirname, "../..");
const ROOT_DIR = path.resolve(APP_DIR, "..");
const PUBLIC_DIR = path.join(APP_DIR, "public");
const DB_PATH = process.env.DB_PATH || path.join(APP_DIR, "mssp.sqlite");
const ANTHOLOGY_MARKDOWN = path.join(ROOT_DIR, "The Holy Trinity", "MSSP - The Holy Trinity.md");

const HOST = process.env.HOST || "0.0.0.0";
const PORT = Number(process.env.PORT || 5177);

const COVERS = {
  anthology: {
    file: path.join(ROOT_DIR, "The Holy Trinity", "cover.jpg"),
    hoverFile: path.join(ROOT_DIR, "The Holy Trinity", "cover2.jpg"),
  },
  old: {
    file: path.join(ROOT_DIR, "The Old Testament", "cover.jpg"),
  },
  new: {
    file: path.join(ROOT_DIR, "The New Testament", "cover.jpg"),
  },
  paytch: {
    file: path.join(ROOT_DIR, "The PAYTCH", "cover.jpg"),
  },
};

module.exports = {
  APP_DIR,
  ROOT_DIR,
  PUBLIC_DIR,
  DB_PATH,
  ANTHOLOGY_MARKDOWN,
  HOST,
  PORT,
  COVERS,
};
