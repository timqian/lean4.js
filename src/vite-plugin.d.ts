import type { Plugin } from 'vite'

/**
 * Vite plugin that sets the COOP/COEP headers required for
 * `SharedArrayBuffer` during `vite dev` and `vite preview`.
 */
export function lean4Plugin(): Plugin
