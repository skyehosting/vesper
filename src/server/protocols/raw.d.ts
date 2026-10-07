/** Vite/vitest `?raw` imports: the file's text (used for the shipped protocols default). */
declare module '*.md?raw' {
  const text: string
  export default text
}
