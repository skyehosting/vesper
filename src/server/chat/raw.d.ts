/** Vite `?raw` imports (the bundled protocols default). */
declare module '*.md?raw' {
  const text: string
  export default text
}
