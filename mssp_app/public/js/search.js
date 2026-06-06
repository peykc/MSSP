import { debounce } from "./utils.js";

export function initSearch({ dom, state, loadEpisodes }) {
  dom.searchInput.addEventListener("input", debounce(async (event) => {
    state.query = event.target.value.trim();
    await loadEpisodes();
  }, 160));
}
