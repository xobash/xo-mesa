import { useAppStore, getStore } from "../store";
import { Modal } from "./Modal";
import { SearchSurface } from "./SearchSurface";

export function SearchPanel() {
  const open = useAppStore((s) => s.searchOpen);
  const setSearch = useAppStore((s) => s.setSearch);

  if (!open) return null;

  return (
    <Modal onClose={() => setSearch(false)} align="top" className="search">
      <SearchSurface
        initialQuery={getStore().searchSeed || ""}
        onClose={() => setSearch(false)}
      />
    </Modal>
  );
}
