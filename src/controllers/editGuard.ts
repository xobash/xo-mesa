import { getStore } from "../store";
import { pendingEditGuard } from "../lib/closeGuard";

/** The one save-before-close check shared by Close, Quit and Restart to update. */
export const { flush: flushAllEdits, pending: hasPendingEdits } = pendingEditGuard(() => getStore());
