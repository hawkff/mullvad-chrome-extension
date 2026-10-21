declare const __DEV__: boolean;
// Bun inlines these files as strings through `with { type: "text" }` imports.
declare module "*.LICENSE" {
  const text: string;
  export default text;
}
declare module "tldts/dist/index.umd.min.js" {
  const text: string;
  export default text;
}
