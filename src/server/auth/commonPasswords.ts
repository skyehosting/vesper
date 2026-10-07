/**
 * The bundled common-password blocklist lives in src/shared/commonPasswords.ts, so the server's check (password.ts)
 * and the client's live rules (features/access/password.logic.ts) read one list. Re-exported here for server code.
 */
export { COMMON_PASSWORDS } from '@shared/commonPasswords'
