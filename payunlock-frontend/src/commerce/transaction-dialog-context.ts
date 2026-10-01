import { createContext } from "react";

export const TransactionDialogContext = createContext<{ close(): void; setBusy(busy: boolean): void } | null>(null);
