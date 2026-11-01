import Module, { createRequire } from "node:module";

// Metro supplies native asset ids, as for TMDB's logo in Settings' About, and picks a picture's
// @2x file; Node has no PNG loader and asks for the plain name. Importing this before a screen
// that requires a picture gives it an id and the @2x file.
createRequire(import.meta.url).extensions[".png"] = (module) => {
  module.exports = 1;
};
const resolving = Module as unknown as {
  _resolveFilename(request: string, ...rest: unknown[]): string;
};
const resolve = resolving._resolveFilename.bind(resolving);
resolving._resolveFilename = (request, ...rest) =>
  resolve(request.endsWith("/tmdb.png") ? request.replace(/\.png$/, "@2x.png") : request, ...rest);
