// Vite `?raw` imports return the file as a string (used to check wrangler.toml, SPEC-002 AC-29).
declare module '*?raw' {
  const content: string;
  export default content;
}
