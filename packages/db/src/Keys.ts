/**
 * Keys more than one repository builds: an alias's partition (read by `ContactRepo` to check the
 * alias still exists) and an alias's contacts partition (purged by `AliasRepo` when it is deleted).
 */

/** Addresses are case-insensitive, so keys use the lowercased address. */
export const aliasKey = (domain: string, localPart: string) => ({
  pk: { S: `ALIAS#${domain.toLowerCase()}#${localPart.toLowerCase()}` },
  sk: { S: "ALIAS" },
});

/** Keyed by the alias's id, not its address, so an alias recreated there starts without any. */
export const contactsPartition = (aliasId: string) => `CONTACTS#${aliasId}`;
