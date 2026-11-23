export const fold = (s: string): string => [...s].map((c) => c.toLocaleLowerCase()).join("");

export const searchQuery = (query: string): string => fold(query.trim());
